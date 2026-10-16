import { and, asc, count, eq, ilike, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { groupMembers, groups, students, units, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, deleteOrConflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js';
import { assertPathInScope, type Scope } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { findUnit, loadUnitIndex } from '../structure/service.js';

type GroupRow = typeof groups.$inferSelect;

export type GroupDto = {
  id: string;
  name: string;
  kind: string;
  unitId: string | null;
  /** Names from the root to the group's unit; empty for institute-wide groups. */
  unitPath: string[];
  memberCount: number;
};

/**
 * A group anchored at unit U only accepts students from U or below it.
 * `studentUnitPath` is the root-to-self id path of the student's unit.
 */
export function groupAcceptsUnit(groupUnitId: string | null, studentUnitPath: readonly string[]): boolean {
  return groupUnitId === null || studentUnitPath.includes(groupUnitId);
}

export async function findGroup(db: DbOrTx, instituteId: string, groupId: string): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Group');
  return row;
}

/** Throws 403 unless the group is inside the caller's scope. Institute-wide groups are admin-only. */
async function assertGroupInScope(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, group: GroupRow) {
  if (scope.all) return;
  if (!group.unitId) throw forbidden('Only admins can manage institute-wide groups');
  assertPathInScope(scope, (await findUnit(db, auth.instituteId, group.unitId)).path, 'This group');
}

const groupNameTaken = (err: unknown, name: string): never => {
  if (isUniqueViolation(err, 'groups_name_uq')) {
    throw conflict('GROUP_NAME_TAKEN', `A group called "${name}" already exists in this unit`);
  }
  throw err;
};

export async function listGroups(
  db: Db,
  instituteId: string,
  query: { unitId?: string; kind?: string; q?: string },
): Promise<GroupDto[]> {
  const conditions: SQL[] = [eq(groups.instituteId, instituteId)];
  if (query.unitId) conditions.push(sql`${units.path} @> ARRAY[${query.unitId}]::uuid[]`);
  if (query.kind) conditions.push(eq(groups.kind, query.kind));
  if (query.q) conditions.push(ilike(groups.name, containsPattern(query.q)));

  const [rows, index] = await Promise.all([
    db
      .select({ group: groups, memberCount: count(groupMembers.studentId) })
      .from(groups)
      .leftJoin(units, eq(units.id, groups.unitId))
      .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(and(...conditions))
      .groupBy(groups.id)
      .orderBy(asc(groups.name)),
    loadUnitIndex(db, instituteId),
  ]);
  return rows.map(({ group, memberCount }) => ({
    id: group.id,
    name: group.name,
    kind: group.kind,
    unitId: group.unitId,
    unitPath: group.unitId ? index.pathNames(group.unitId) : [],
    memberCount,
  }));
}

async function toGroupDto(db: DbOrTx, instituteId: string, group: GroupRow): Promise<GroupDto> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, group.id));
  const index = await loadUnitIndex(db, instituteId);
  return {
    id: group.id,
    name: group.name,
    kind: group.kind,
    unitId: group.unitId,
    unitPath: group.unitId ? index.pathNames(group.unitId) : [],
    memberCount: n,
  };
}

export async function createGroup(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  input: { name: string; kind?: string; unitId?: string | null },
  ip?: string,
): Promise<GroupDto> {
  return db.transaction(async (tx) => {
    if (input.unitId) {
      assertPathInScope(scope, (await findUnit(tx, auth.instituteId, input.unitId)).path, 'This unit');
    } else if (!scope.all) {
      throw forbidden('Only admins can create institute-wide groups');
    }
    const [row] = await tx
      .insert(groups)
      .values({ instituteId: auth.instituteId, name: input.name, kind: input.kind, unitId: input.unitId ?? null })
      .returning()
      .catch((err) => groupNameTaken(err, input.name));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'group.created',
      entityType: 'group',
      entityId: row!.id,
      data: { name: input.name, kind: row!.kind, unitId: row!.unitId },
      ip,
    });
    return toGroupDto(tx, auth.instituteId, row!);
  });
}

export async function updateGroup(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  groupId: string,
  input: { name?: string; kind?: string },
  ip?: string,
): Promise<GroupDto> {
  return db.transaction(async (tx) => {
    await assertGroupInScope(tx, auth, scope, await findGroup(tx, auth.instituteId, groupId));
    const [row] = await tx
      .update(groups)
      .set(input)
      .where(eq(groups.id, groupId))
      .returning()
      .catch((err) => groupNameTaken(err, input.name ?? ''));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'group.updated',
      entityType: 'group',
      entityId: groupId,
      data: { changes: input },
      ip,
    });
    return toGroupDto(tx, auth.instituteId, row!);
  });
}

export async function deleteGroup(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  groupId: string,
  ip?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const group = await findGroup(tx, auth.instituteId, groupId);
    await assertGroupInScope(tx, auth, scope, group);
    await deleteOrConflict(
      () => tx.delete(groups).where(eq(groups.id, groupId)),
      'GROUP_IN_USE',
      `"${group.name}" is used by a course offering; remove it there first`,
    );
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'group.deleted',
      entityType: 'group',
      entityId: groupId,
      data: { name: group.name },
      ip,
    });
  });
}

export type GroupMemberDto = { id: string; username: string; fullName: string; rollNo: string | null; unitId: string };

export async function listMembers(db: Db, instituteId: string, groupId: string): Promise<GroupMemberDto[]> {
  await findGroup(db, instituteId, groupId);
  return db
    .select({
      id: students.userId,
      username: users.username,
      fullName: users.fullName,
      rollNo: students.rollNo,
      unitId: students.unitId,
    })
    .from(groupMembers)
    .innerJoin(students, eq(students.userId, groupMembers.studentId))
    .innerJoin(users, eq(users.id, students.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(sql`lpad(coalesce(${students.rollNo}, ''), 12, '0')`, users.username);
}

/**
 * Loads students by id within the institute, with their unit paths. Throws if any id
 * is not a student of this institute.
 */
export async function loadStudentUnitPaths(
  db: DbOrTx,
  instituteId: string,
  studentIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db
    .select({ id: students.userId, path: units.path })
    .from(students)
    .innerJoin(units, eq(units.id, students.unitId))
    .where(and(eq(students.instituteId, instituteId), inArray(students.userId, [...studentIds])));
  const found = new Map(rows.map((r) => [r.id, r.path]));
  const missing = studentIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw badRequest('UNKNOWN_STUDENTS', 'Some students were not found', { studentIds: missing });
  return found;
}

export async function changeMembers(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  groupId: string,
  input: { add?: string[]; remove?: string[] },
  ip?: string,
): Promise<{ memberCount: number }> {
  return db.transaction(async (tx) => {
    const group = await findGroup(tx, auth.instituteId, groupId);
    await assertGroupInScope(tx, auth, scope, group);

    const add = [...new Set(input.add ?? [])];
    const remove = [...new Set(input.remove ?? [])];
    const paths = await loadStudentUnitPaths(tx, auth.instituteId, add);
    const outside = add.filter((id) => !groupAcceptsUnit(group.unitId, paths.get(id)!));
    if (outside.length > 0) {
      throw badRequest('STUDENT_OUTSIDE_GROUP_UNIT', 'Some students do not belong to the unit this group is in', {
        studentIds: outside,
      });
    }

    if (add.length > 0) {
      await tx
        .insert(groupMembers)
        .values(add.map((studentId) => ({ groupId, studentId })))
        .onConflictDoNothing();
    }
    if (remove.length > 0) {
      await tx
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.studentId, remove)));
    }
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'group.members_changed',
      entityType: 'group',
      entityId: groupId,
      data: { added: add.length, removed: remove.length },
      ip,
    });
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return { memberCount: n };
  });
}
