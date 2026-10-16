import { and, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { type Role, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { generateTemporaryPassword, hashPassword } from '../../lib/password.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { revokeAllSessions } from '../auth/service.js';
import { toUserDto, type UserDto } from './dto.js';

type Actor = { userId: string; ip?: string };

export type CreateUserInput = {
  role: Exclude<Role, 'platform_admin'>;
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  /** If omitted a temporary password is generated and returned once. */
  password?: string;
  mustChangePassword?: boolean;
};

export type CreatedUser = { user: UserDto; temporaryPassword?: string };

/** Creates a user inside an institute. Usable within a caller's transaction. */
export async function createUser(
  db: DbOrTx,
  instituteId: string,
  actor: Actor,
  input: CreateUserInput,
): Promise<CreatedUser> {
  const temporaryPassword = input.password ? undefined : generateTemporaryPassword();
  const passwordHash = await hashPassword(input.password ?? temporaryPassword!);

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

  await writeAudit(db, {
    instituteId,
    actorUserId: actor.userId,
    action: 'user.created',
    entityType: 'user',
    entityId: row!.id,
    data: { role: input.role, username: input.username },
    ip: actor.ip,
  });
  return { user: toUserDto(row!), temporaryPassword };
}

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
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), users.id)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(users).where(where),
  ]);

  return { items: rows.map(toUserDto), total: totalRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Tenant-scoped lookup: a user in another institute is reported as not found. */
async function findInInstitute(db: DbOrTx, instituteId: string, userId: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('User');
  return row;
}

export async function getUser(db: Db, instituteId: string, userId: string): Promise<UserDto> {
  return toUserDto(await findInInstitute(db, instituteId, userId));
}

export type UpdateUserInput = {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  role?: Exclude<Role, 'platform_admin'>;
  status?: 'active' | 'disabled';
};

export async function updateUser(
  db: Db,
  auth: InstituteAuthContext,
  userId: string,
  input: UpdateUserInput,
  ip?: string,
): Promise<UserDto> {
  if (userId === auth.userId && (input.role !== undefined || input.status !== undefined)) {
    // Stops an admin from locking themselves (and possibly the whole institute) out.
    throw badRequest('CANNOT_CHANGE_SELF', 'You cannot change your own role or status');
  }

  return db.transaction(async (tx) => {
    const before = await findInInstitute(tx, auth.instituteId, userId);
    const [after] = await tx.update(users).set(input).where(eq(users.id, userId)).returning();
    if (input.status === 'disabled' && before.status !== 'disabled') await revokeAllSessions(tx, userId);

    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'user.updated',
      entityType: 'user',
      entityId: userId,
      data: { changes: input },
      ip,
    });
    return toUserDto(after!);
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
  const passwordHash = await hashPassword(temporaryPassword);

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
