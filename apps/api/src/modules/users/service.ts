import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { type Role, staffProfiles, students, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { generateTemporaryPassword, hashPassword, hashTemporaryPassword } from '../../lib/password.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { revokeAllSessions } from '../auth/service.js';
import { findUnit } from '../structure/service.js';
import { toUserDto, type UserDto } from './dto.js';

type Actor = { userId: string; ip?: string };
type InstituteRole = Exclude<Role, 'platform_admin'>;

/** A user as seen by institute admins: account fields plus where they sit in the structure. */
export type ManagedUserDto = UserDto & {
  /** Student: their class unit. Staff: their department/home unit (a HOD's managed subtree). */
  unitId: string | null;
  designation: string | null;
};

export type CreateUserInput = {
  role: InstituteRole;
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  /** If omitted a temporary password is generated and returned once. */
  password?: string;
  mustChangePassword?: boolean;
  /** Staff only. Required for HODs. */
  unitId?: string | null;
  designation?: string | null;
};

export type CreatedUser = { user: ManagedUserDto; temporaryPassword?: string };

const hodNeedsUnit = () => badRequest('HOD_NEEDS_UNIT', 'A HOD must be assigned the unit (department) they manage');

/**
 * Creates a user inside an institute; staff also get a staff profile. Callers creating
 * students must add the students row themselves (see students service). Usable within
 * a caller's transaction.
 */
export async function createUser(
  db: DbOrTx,
  instituteId: string,
  actor: Actor,
  input: CreateUserInput,
): Promise<CreatedUser> {
  const isStaff = input.role !== 'student';
  if (input.role === 'hod' && !input.unitId) throw hodNeedsUnit();
  if (isStaff && input.unitId) await findUnit(db, instituteId, input.unitId);

  const temporaryPassword = input.password ? undefined : generateTemporaryPassword();
  const passwordHash = input.password ? await hashPassword(input.password) : await hashTemporaryPassword(temporaryPassword!);

  let row;
  try {
    [row] = await db
      .insert(users)
      .values({
        instituteId,
        role: input.role,
        username: input.username,
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        passwordHash,
        mustChangePassword: temporaryPassword !== undefined || (input.mustChangePassword ?? true),
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, 'users_institute_username_uq')) {
      throw conflict('USERNAME_TAKEN', `Username "${input.username}" is already in use in this institute`);
    }
    throw err;
  }

  if (isStaff) {
    await db.insert(staffProfiles).values({
      userId: row!.id,
      instituteId,
      unitId: input.unitId ?? null,
      designation: input.designation ?? null,
    });
  }

  await writeAudit(db, {
    instituteId,
    actorUserId: actor.userId,
    action: 'user.created',
    entityType: 'user',
    entityId: row!.id,
    data: { role: input.role, username: input.username },
    ip: actor.ip,
  });
  return {
    user: {
      ...toUserDto(row!),
      unitId: isStaff ? (input.unitId ?? null) : null,
      designation: isStaff ? (input.designation ?? null) : null,
    },
    temporaryPassword,
  };
}

function selectManaged(db: DbOrTx) {
  return db
    .select({
      user: users,
      staffUnitId: staffProfiles.unitId,
      designation: staffProfiles.designation,
      studentUnitId: students.unitId,
    })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(students, eq(students.userId, users.id));
}

type ManagedRow = Awaited<ReturnType<typeof selectManaged>>[number];

const toManagedDto = (r: ManagedRow): ManagedUserDto => ({
  ...toUserDto(r.user),
  unitId: r.studentUnitId ?? r.staffUnitId,
  designation: r.designation,
});

export type ListUsersQuery = {
  page: number;
  pageSize: number;
  role?: Role;
  status?: 'active' | 'disabled';
  /** Matches username, name or email. */
  q?: string;
};

export async function listUsers(db: Db, instituteId: string, query: ListUsersQuery) {
  const filters: SQL[] = [eq(users.instituteId, instituteId)];
  if (query.role) filters.push(eq(users.role, query.role));
  if (query.status) filters.push(eq(users.status, query.status));
  if (query.q) {
    const pattern = containsPattern(query.q);
    filters.push(or(ilike(users.username, pattern), ilike(users.fullName, pattern), ilike(users.email, pattern))!);
  }
  const where = and(...filters);

  const [rows, [totalRow]] = await Promise.all([
    selectManaged(db)
      .where(where)
      .orderBy(desc(users.createdAt), users.id)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(users).where(where),
  ]);

  return { items: rows.map(toManagedDto), total: totalRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
}

export async function listStaffDirectory(db: Db, instituteId: string) {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      unitId: staffProfiles.unitId,
      designation: staffProfiles.designation,
    })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(
      and(eq(users.instituteId, instituteId), eq(users.status, 'active'), inArray(users.role, ['admin', 'hod', 'faculty'])),
    )
    .orderBy(asc(users.fullName));
  return rows.map((r) => ({ ...r, role: r.role as 'admin' | 'hod' | 'faculty' }));
}

/** Tenant-scoped lookup: a user in another institute is reported as not found. */
async function findInInstitute(db: DbOrTx, instituteId: string, userId: string): Promise<ManagedRow> {
  const [row] = await selectManaged(db)
    .where(and(eq(users.id, userId), eq(users.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('User');
  return row;
}

export async function getUser(db: DbOrTx, instituteId: string, userId: string): Promise<ManagedUserDto> {
  return toManagedDto(await findInInstitute(db, instituteId, userId));
}

export type UpdateUserInput = {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  role?: InstituteRole;
  status?: 'active' | 'disabled';
  /** Staff only. */
  unitId?: string | null;
  designation?: string | null;
};

export async function updateUser(
  db: Db,
  auth: InstituteAuthContext,
  userId: string,
  input: UpdateUserInput,
  ip?: string,
): Promise<ManagedUserDto> {
  if (userId === auth.userId && (input.role !== undefined || input.status !== undefined)) {
    // Stops an admin from locking themselves (and possibly the whole institute) out.
    throw badRequest('CANNOT_CHANGE_SELF', 'You cannot change your own role or status');
  }
  const { unitId, designation, ...accountChanges } = input;

  return db.transaction(async (tx) => {
    const before = await findInInstitute(tx, auth.instituteId, userId);
    const wasStudent = before.user.role === 'student';

    if (input.role && (input.role === 'student') !== wasStudent) {
      throw badRequest('ROLE_CHANGE_NOT_ALLOWED', 'Students and staff accounts cannot be converted into each other');
    }

    if (wasStudent) {
      if (unitId !== undefined || designation !== undefined) {
        throw badRequest('USE_STUDENTS_API', "Change a student's class through the students API");
      }
    } else {
      if (unitId) await findUnit(tx, auth.instituteId, unitId);
      const finalRole = input.role ?? before.user.role;
      const finalUnit = unitId !== undefined ? unitId : before.staffUnitId;
      if (finalRole === 'hod' && !finalUnit) throw hodNeedsUnit();

      if (unitId !== undefined || designation !== undefined) {
        await tx
          .insert(staffProfiles)
          .values({ userId, instituteId: auth.instituteId, unitId: unitId ?? null, designation: designation ?? null })
          .onConflictDoUpdate({
            target: staffProfiles.userId,
            set: {
              ...(unitId !== undefined && { unitId }),
              ...(designation !== undefined && { designation }),
            },
          });
      }
    }

    if (Object.values(accountChanges).some((v) => v !== undefined)) {
      await tx.update(users).set(accountChanges).where(eq(users.id, userId));
    }
    if (input.status === 'disabled' && before.user.status !== 'disabled') await revokeAllSessions(tx, userId);

    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'user.updated',
      entityType: 'user',
      entityId: userId,
      data: { changes: input },
      ip,
    });
    return getUser(tx, auth.instituteId, userId);
  });
}

/** Sets a new temporary password, signs the user out everywhere and returns it once. */
export async function resetPassword(
  db: Db,
  auth: InstituteAuthContext,
  userId: string,
  ip?: string,
): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashTemporaryPassword(temporaryPassword);

  await db.transaction(async (tx) => {
    await findInInstitute(tx, auth.instituteId, userId);
    await tx.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, userId));
    await revokeAllSessions(tx, userId);
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: userId,
      ip,
    });
  });
  return { temporaryPassword };
}
