import { and, asc, count, eq, exists, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { groupMembers, groups, students, units, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { assertPathInScope, type Scope, scopeCondition } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { groupAcceptsUnit } from '../groups/service.js';
import { findUnit, loadUnitIndex } from '../structure/service.js';
import { createUser } from '../users/service.js';
import { markStudentsStale } from '../reports/tallies.js';

export type StudentDto = {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
  rollNo: string | null;
  unitId: string;
  /** Names from the root down, e.g. ["Computer Engg", "SY", "Div A"]. */
  unitPath: string[];
  groups: { id: string; name: string; kind: string }[];
};

function selectStudents(db: DbOrTx) {
  return db
    .select({ student: students, user: users, unitPath: units.path })
    .from(students)
    .innerJoin(users, eq(users.id, students.userId))
    .innerJoin(units, eq(units.id, students.unitId));
}

type StudentRow = Awaited<ReturnType<typeof selectStudents>>[number];

async function toStudentDtos(db: DbOrTx, instituteId: string, rows: StudentRow[]): Promise<StudentDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.student.userId);
  // Sequential on purpose: `db` may be a transaction, which runs one query at a time.
  const index = await loadUnitIndex(db, instituteId);
  const memberships = await db
    .select({ studentId: groupMembers.studentId, id: groups.id, name: groups.name, kind: groups.kind })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(inArray(groupMembers.studentId, ids))
    .orderBy(asc(groups.name));

  const groupsByStudent = new Map<string, StudentDto['groups']>();
  for (const { studentId, ...g } of memberships) {
    const list = groupsByStudent.get(studentId) ?? [];
    list.push(g);
    groupsByStudent.set(studentId, list);
  }

  return rows.map(({ student, user }) => ({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    status: user.status,
    rollNo: student.rollNo,
    unitId: student.unitId,
    unitPath: index.pathNames(student.unitId),
    groups: groupsByStudent.get(user.id) ?? [],
  }));
}

async function findStudentRow(db: DbOrTx, instituteId: string, studentId: string): Promise<StudentRow> {
  const [row] = await selectStudents(db)
    .where(and(eq(students.userId, studentId), eq(students.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Student');
  return row;
}

/** Loads the given groups (tenant-scoped) and checks each accepts a student from `unitPath`. */
async function loadGroupsForUnit(db: DbOrTx, instituteId: string, groupIds: readonly string[], unitPath: string[]) {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(groups)
    .where(and(eq(groups.instituteId, instituteId), inArray(groups.id, ids)));
  if (rows.length !== ids.length) throw badRequest('UNKNOWN_GROUPS', 'Some groups were not found');
  const wrong = rows.filter((g) => !groupAcceptsUnit(g.unitId, unitPath));
  if (wrong.length > 0) {
    throw badRequest(
      'GROUP_OUTSIDE_STUDENT_UNIT',
      `These groups belong to a different class: ${wrong.map((g) => g.name).join(', ')}`,
    );
  }
  return rows;
}

export type CreateStudentInput = {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  password?: string;
  unitId: string;
  rollNo?: string;
  groupIds?: string[];
};

export async function createStudent(
  db: Db,
  auth: InstituteAuthContext,
  input: CreateStudentInput,
  ip?: string,
): Promise<{ student: StudentDto; temporaryPassword?: string }> {
  return db.transaction(async (tx) => {
    const unit = await findUnit(tx, auth.instituteId, input.unitId);
    const memberOf = await loadGroupsForUnit(tx, auth.instituteId, input.groupIds ?? [], unit.path);

    const { user, temporaryPassword } = await createUser(
      tx,
      auth.instituteId,
      { userId: auth.userId, ip },
      {
        role: 'student',
        username: input.username,
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        password: input.password,
      },
    );
    await tx
      .insert(students)
      .values({ userId: user.id, instituteId: auth.instituteId, unitId: unit.id, rollNo: input.rollNo ?? null });
    if (memberOf.length > 0) {
      await tx.insert(groupMembers).values(memberOf.map((g) => ({ groupId: g.id, studentId: user.id })));
    }

    const [dto] = await toStudentDtos(tx, auth.instituteId, [await findStudentRow(tx, auth.instituteId, user.id)]);
    return { student: dto!, temporaryPassword };
  });
}

export type ListStudentsQuery = {
  page: number;
  pageSize: number;
  /** Students in this unit or any unit below it. */
  unitId?: string;
  groupId?: string;
  status?: 'active' | 'disabled';
  /** Matches username, name or roll number. */
  q?: string;
};

export async function listStudents(db: Db, instituteId: string, scope: Scope, query: ListStudentsQuery) {
  const conditions: (SQL | undefined)[] = [eq(students.instituteId, instituteId), scopeCondition(scope, units.path)];
  if (query.unitId) conditions.push(sql`${units.path} @> ARRAY[${query.unitId}]::uuid[]`);
  if (query.groupId) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(groupMembers)
          .where(and(eq(groupMembers.groupId, query.groupId), eq(groupMembers.studentId, students.userId))),
      ),
    );
  }
  if (query.status) conditions.push(eq(users.status, query.status));
  if (query.q) {
    const pattern = containsPattern(query.q);
    conditions.push(or(ilike(users.username, pattern), ilike(users.fullName, pattern), ilike(students.rollNo, pattern)));
  }
  const where = and(...conditions);

  // A class list reads best in roll-number order; an institute-wide list by username.
  const classView = query.unitId !== undefined || query.groupId !== undefined;
  const order = classView
    ? [sql`lpad(coalesce(${students.rollNo}, ''), 12, '0')`, asc(users.username)]
    : [asc(users.username)];

  const [rows, [totalRow]] = await Promise.all([
    selectStudents(db)
      .where(where)
      .orderBy(...order)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(students)
      .innerJoin(users, eq(users.id, students.userId))
      .innerJoin(units, eq(units.id, students.unitId))
      .where(where),
  ]);

  return {
    items: await toStudentDtos(db, instituteId, rows),
    total: totalRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getStudent(db: Db, instituteId: string, scope: Scope, studentId: string): Promise<StudentDto> {
  const row = await findStudentRow(db, instituteId, studentId);
  assertPathInScope(scope, row.unitPath, 'This student');
  const [dto] = await toStudentDtos(db, instituteId, [row]);
  return dto!;
}

export type UpdateStudentInput = {
  unitId?: string;
  rollNo?: string | null;
  /** Replaces all memberships. */
  groupIds?: string[];
};

/**
 * Moves a student, changes roll number and/or replaces their groups. When the class
 * changes without new groups being given, memberships the new class cannot have
 * (e.g. the old division's lab batch) are dropped.
 */
export async function updateStudent(
  db: Db,
  auth: InstituteAuthContext,
  studentId: string,
  input: UpdateStudentInput,
  ip?: string,
): Promise<StudentDto> {
  return db.transaction(async (tx) => {
    const before = await findStudentRow(tx, auth.instituteId, studentId);
    const unit = input.unitId ? await findUnit(tx, auth.instituteId, input.unitId) : null;
    const unitPath = unit?.path ?? before.unitPath;
    let droppedGroups: string[] = [];

    if (input.groupIds !== undefined) {
      const memberOf = await loadGroupsForUnit(tx, auth.instituteId, input.groupIds, unitPath);
      await tx.delete(groupMembers).where(eq(groupMembers.studentId, studentId));
      if (memberOf.length > 0) {
        await tx.insert(groupMembers).values(memberOf.map((g) => ({ groupId: g.id, studentId })));
      }
    } else if (unit && unit.id !== before.student.unitId) {
      const current = await tx
        .select({ id: groups.id, name: groups.name, unitId: groups.unitId })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groupMembers.studentId, studentId));
      const invalid = current.filter((g) => !groupAcceptsUnit(g.unitId, unitPath));
      if (invalid.length > 0) {
        await tx.delete(groupMembers).where(
          and(
            eq(groupMembers.studentId, studentId),
            inArray(
              groupMembers.groupId,
              invalid.map((g) => g.id),
            ),
          ),
        );
        droppedGroups = invalid.map((g) => g.name);
      }
    }

    const profileChanges = {
      ...(unit && { unitId: unit.id }),
      ...(input.rollNo !== undefined && { rollNo: input.rollNo }),
    };
    if (Object.keys(profileChanges).length > 0) {
      await tx.update(students).set(profileChanges).where(eq(students.userId, studentId));
    }
    // Report trends are grouped by class.
    if (unit && unit.id !== before.student.unitId) await markStudentsStale(tx, [studentId]);

    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'student.updated',
      entityType: 'user',
      entityId: studentId,
      data: { changes: input, ...(droppedGroups.length > 0 && { droppedGroups }) },
      ip,
    });
    const [dto] = await toStudentDtos(tx, auth.instituteId, [await findStudentRow(tx, auth.instituteId, studentId)]);
    return dto!;
  });
}
