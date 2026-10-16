import { and, asc, count, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import {
  groupMembers,
  groups,
  offeringAudience,
  offeringFaculty,
  offerings,
  students,
  subjects,
  terms,
  units,
  users,
} from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isPathInScope, pathWithinAny, type Scope } from '../../lib/scope.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { findSubject, findTerm } from '../catalog/service.js';
import { loadUnitIndex } from '../structure/service.js';

export type Audience = { unitIds: string[]; groupIds: string[] };

export type OfferingDto = {
  id: string;
  term: { id: string; name: string };
  subject: { id: string; code: string; name: string };
  faculty: { id: string; username: string; fullName: string }[];
  audience: {
    units: { id: string; name: string; path: string[] }[];
    groups: { id: string; name: string; kind: string; unitPath: string[] }[];
  };
};

// ---------------------------------------------------------------------------
// Audience → students (also used by attendance sessions)
// ---------------------------------------------------------------------------

/** SQL condition on `students` (joined with `units`) selecting everyone in the audience. */
export function audienceCondition(audience: Audience): SQL {
  const parts: SQL[] = [];
  if (audience.unitIds.length > 0) parts.push(pathWithinAny(units.path, audience.unitIds));
  if (audience.groupIds.length > 0) {
    parts.push(
      sql`exists (select 1 from ${groupMembers} where ${groupMembers.studentId} = ${students.userId} and ${inArray(
        groupMembers.groupId,
        audience.groupIds,
      )})`,
    );
  }
  return or(...parts) ?? sql`false`;
}

export type RosterEntry = {
  id: string;
  username: string;
  fullName: string;
  rollNo: string | null;
  unitId: string;
  unitPath: string[];
};

/** Active students in an audience, in class then roll-number order. */
export async function listAudienceStudents(db: DbOrTx, instituteId: string, audience: Audience): Promise<RosterEntry[]> {
  // Sequential on purpose: `db` may be a transaction, which runs one query at a time.
  const rows = await db
    .select({
      id: students.userId,
      username: users.username,
      fullName: users.fullName,
      rollNo: students.rollNo,
      unitId: students.unitId,
    })
    .from(students)
    .innerJoin(users, eq(users.id, students.userId))
    .innerJoin(units, eq(units.id, students.unitId))
    .where(and(eq(students.instituteId, instituteId), eq(users.status, 'active'), audienceCondition(audience)));
  const index = await loadUnitIndex(db, instituteId);
  const entries = rows.map((r) => ({ ...r, unitPath: index.pathNames(r.unitId) }));
  const collator = new Intl.Collator(undefined, { numeric: true });
  return entries.sort(
    (a, b) =>
      collator.compare(a.unitPath.join('/'), b.unitPath.join('/')) ||
      collator.compare(a.rollNo ?? '', b.rollNo ?? '') ||
      collator.compare(a.username, b.username),
  );
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** HODs may only target units/groups inside their department. Returns the loaded rows. */
export async function validateAudience(db: DbOrTx, instituteId: string, scope: Scope, audience: Audience) {
  const unitIds = [...new Set(audience.unitIds)];
  const groupIds = [...new Set(audience.groupIds)];
  if (unitIds.length + groupIds.length === 0) throw badRequest('EMPTY_AUDIENCE', 'Choose at least one class or group');

  const unitRows = unitIds.length
    ? await db
        .select()
        .from(units)
        .where(and(eq(units.instituteId, instituteId), inArray(units.id, unitIds)))
    : [];
  const groupRows = groupIds.length
    ? await db
        .select({ group: groups, unitPath: units.path })
        .from(groups)
        .leftJoin(units, eq(units.id, groups.unitId))
        .where(and(eq(groups.instituteId, instituteId), inArray(groups.id, groupIds)))
    : [];
  if (unitRows.length !== unitIds.length) throw badRequest('UNKNOWN_UNITS', 'Some classes were not found');
  if (groupRows.length !== groupIds.length) throw badRequest('UNKNOWN_GROUPS', 'Some groups were not found');

  const outside = [
    ...unitRows.filter((u) => !isPathInScope(scope, u.path)).map((u) => u.name),
    ...groupRows.filter((g) => !isPathInScope(scope, g.unitPath)).map((g) => g.group.name),
  ];
  if (outside.length > 0) {
    throw forbidden(`Outside the part of the institute you manage: ${outside.join(', ')}`);
  }
  return { unitIds, groupIds };
}

async function validateFaculty(db: DbOrTx, instituteId: string, facultyIds: readonly string[]) {
  const ids = [...new Set(facultyIds)];
  if (ids.length === 0) return ids;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.instituteId, instituteId),
        inArray(users.id, ids),
        inArray(users.role, ['faculty', 'hod', 'admin']),
        eq(users.status, 'active'),
      ),
    );
  if (rows.length !== ids.length) {
    throw badRequest('INVALID_FACULTY', 'Each teacher must be an active faculty, HOD or admin account');
  }
  return ids;
}

/** SQL limiting offerings to those the caller may see; undefined = all. */
export function visibilityCondition(auth: InstituteAuthContext, scope: Scope): SQL | undefined {
  if (scope.all) return undefined;
  const teaches = sql`exists (select 1 from ${offeringFaculty} where ${offeringFaculty.offeringId} = ${offerings.id} and ${offeringFaculty.userId} = ${auth.userId})`;
  if (scope.unitId === null) return teaches;
  // HOD: any audience entry (directly, or through a group's unit) inside their department.
  const inDepartment = sql`exists (
    select 1 from ${offeringAudience} oa
    left join ${groups} g on g.id = oa.group_id
    join ${units} u on u.id = coalesce(oa.unit_id, g.unit_id)
    where oa.offering_id = ${offerings.id} and u.path @> ARRAY[${scope.unitId}]::uuid[])`;
  return or(teaches, inDepartment);
}

export async function findVisibleOffering(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, offeringId: string) {
  const [row] = await db
    .select()
    .from(offerings)
    .where(
      and(eq(offerings.id, offeringId), eq(offerings.instituteId, auth.instituteId), visibilityCondition(auth, scope)),
    )
    .limit(1);
  if (!row) throw notFound('Offering');
  return row;
}

export function loadAudience(db: DbOrTx, offeringId: string): Promise<Audience> {
  return db
    .select()
    .from(offeringAudience)
    .where(eq(offeringAudience.offeringId, offeringId))
    .then((rows) => ({
      unitIds: rows.flatMap((r) => (r.unitId ? [r.unitId] : [])),
      groupIds: rows.flatMap((r) => (r.groupId ? [r.groupId] : [])),
    }));
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

async function toOfferingDtos(
  db: DbOrTx,
  instituteId: string,
  rows: (typeof offerings.$inferSelect)[],
): Promise<OfferingDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, which runs one query at a time.
  const termRows = await db.select().from(terms).where(inArray(terms.id, [...new Set(rows.map((r) => r.termId))]));
  const subjectRows = await db
    .select()
    .from(subjects)
    .where(inArray(subjects.id, [...new Set(rows.map((r) => r.subjectId))]));
  const facultyRows = await db
    .select({ offeringId: offeringFaculty.offeringId, id: users.id, username: users.username, fullName: users.fullName })
    .from(offeringFaculty)
    .innerJoin(users, eq(users.id, offeringFaculty.userId))
    .where(inArray(offeringFaculty.offeringId, ids))
    .orderBy(asc(users.fullName));
  const audienceRows = await db
    .select({ audience: offeringAudience, group: groups })
    .from(offeringAudience)
    .leftJoin(groups, eq(groups.id, offeringAudience.groupId))
    .where(inArray(offeringAudience.offeringId, ids));
  const index = await loadUnitIndex(db, instituteId);

  const termById = new Map(termRows.map((t) => [t.id, t]));
  const subjectById = new Map(subjectRows.map((s) => [s.id, s]));

  return rows.map((r) => {
    const term = termById.get(r.termId)!;
    const subject = subjectById.get(r.subjectId)!;
    const audience = audienceRows.filter((a) => a.audience.offeringId === r.id);
    return {
      id: r.id,
      term: { id: term.id, name: term.name },
      subject: { id: subject.id, code: subject.code, name: subject.name },
      faculty: facultyRows.filter((f) => f.offeringId === r.id).map(({ offeringId: _, ...f }) => f),
      audience: {
        units: audience.flatMap(({ audience: a }) =>
          a.unitId ? [{ id: a.unitId, name: index.byId.get(a.unitId)?.name ?? '?', path: index.pathNames(a.unitId) }] : [],
        ),
        groups: audience.flatMap(({ group: g }) =>
          g ? [{ id: g.id, name: g.name, kind: g.kind, unitPath: g.unitId ? index.pathNames(g.unitId) : [] }] : [],
        ),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function replaceFacultyAndAudience(
  tx: DbOrTx,
  offeringId: string,
  facultyIds: string[] | undefined,
  audience: Audience | undefined,
) {
  if (facultyIds) {
    await tx.delete(offeringFaculty).where(eq(offeringFaculty.offeringId, offeringId));
    if (facultyIds.length > 0) {
      await tx.insert(offeringFaculty).values(facultyIds.map((userId) => ({ offeringId, userId })));
    }
  }
  if (audience) {
    await tx.delete(offeringAudience).where(eq(offeringAudience.offeringId, offeringId));
    await tx
      .insert(offeringAudience)
      .values([
        ...audience.unitIds.map((unitId) => ({ offeringId, unitId })),
        ...audience.groupIds.map((groupId) => ({ offeringId, groupId })),
      ]);
  }
}

export type CreateOfferingInput = { termId: string; subjectId: string; facultyIds: string[]; audience: Audience };

export async function createOffering(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  input: CreateOfferingInput,
  ip?: string,
): Promise<OfferingDto> {
  return db.transaction(async (tx) => {
    await findTerm(tx, auth.instituteId, input.termId);
    await findSubject(tx, auth.instituteId, input.subjectId);
    const audience = await validateAudience(tx, auth.instituteId, scope, input.audience);
    const facultyIds = await validateFaculty(tx, auth.instituteId, input.facultyIds);

    const [row] = await tx
      .insert(offerings)
      .values({ instituteId: auth.instituteId, termId: input.termId, subjectId: input.subjectId })
      .returning();
    await replaceFacultyAndAudience(tx, row!.id, facultyIds, audience);
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'offering.created',
      entityType: 'offering',
      entityId: row!.id,
      data: { ...input },
      ip,
    });
    const [dto] = await toOfferingDtos(tx, auth.instituteId, [row!]);
    return dto!;
  });
}

export type ListOfferingsQuery = {
  page: number;
  pageSize: number;
  termId?: string;
  subjectId?: string;
  facultyId?: string;
  /** Only offerings the caller teaches. */
  mine?: boolean;
};

export async function listOfferings(db: Db, auth: InstituteAuthContext, scope: Scope, query: ListOfferingsQuery) {
  const facultyId = query.mine ? auth.userId : query.facultyId;
  const conditions: (SQL | undefined)[] = [eq(offerings.instituteId, auth.instituteId), visibilityCondition(auth, scope)];
  if (query.termId) conditions.push(eq(offerings.termId, query.termId));
  if (query.subjectId) conditions.push(eq(offerings.subjectId, query.subjectId));
  if (facultyId) {
    conditions.push(
      sql`exists (select 1 from ${offeringFaculty} where ${offeringFaculty.offeringId} = ${offerings.id} and ${offeringFaculty.userId} = ${facultyId})`,
    );
  }
  const where = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ offering: offerings })
      .from(offerings)
      .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
      .where(where)
      .orderBy(asc(subjects.code), asc(offerings.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(offerings).where(where),
  ]);
  return {
    items: await toOfferingDtos(
      db,
      auth.instituteId,
      rows.map((r) => r.offering),
    ),
    total: totalRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getOffering(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  offeringId: string,
): Promise<OfferingDto & { studentCount: number }> {
  const row = await findVisibleOffering(db, auth, scope, offeringId);
  const [[dto], roster] = await Promise.all([
    toOfferingDtos(db, auth.instituteId, [row]),
    listAudienceStudents(db, auth.instituteId, await loadAudience(db, offeringId)),
  ]);
  return { ...dto!, studentCount: roster.length };
}

export async function getOfferingRoster(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  offeringId: string,
): Promise<RosterEntry[]> {
  await findVisibleOffering(db, auth, scope, offeringId);
  return listAudienceStudents(db, auth.instituteId, await loadAudience(db, offeringId));
}

/** Admins, or HODs when both the current and new audience are inside their department. */
async function assertCanManage(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, offeringId: string) {
  const [row] = await db
    .select()
    .from(offerings)
    .where(and(eq(offerings.id, offeringId), eq(offerings.instituteId, auth.instituteId)))
    .limit(1);
  if (!row) throw notFound('Offering');
  if (!scope.all) await validateAudience(db, auth.instituteId, scope, await loadAudience(db, offeringId));
  return row;
}

export async function updateOffering(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  offeringId: string,
  input: { facultyIds?: string[]; audience?: Audience },
  ip?: string,
): Promise<OfferingDto> {
  return db.transaction(async (tx) => {
    const row = await assertCanManage(tx, auth, scope, offeringId);
    const audience = input.audience ? await validateAudience(tx, auth.instituteId, scope, input.audience) : undefined;
    const facultyIds = input.facultyIds ? await validateFaculty(tx, auth.instituteId, input.facultyIds) : undefined;
    await replaceFacultyAndAudience(tx, offeringId, facultyIds, audience);
    await tx.update(offerings).set({ updatedAt: new Date() }).where(eq(offerings.id, offeringId));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'offering.updated',
      entityType: 'offering',
      entityId: offeringId,
      data: { changes: input },
      ip,
    });
    const [dto] = await toOfferingDtos(tx, auth.instituteId, [row]);
    return dto!;
  });
}

export async function deleteOffering(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  offeringId: string,
  ip?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCanManage(tx, auth, scope, offeringId);
    await tx.delete(offerings).where(eq(offerings.id, offeringId));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'offering.deleted',
      entityType: 'offering',
      entityId: offeringId,
      ip,
    });
  });
}
