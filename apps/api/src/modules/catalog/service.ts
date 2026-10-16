import { and, asc, desc, eq, ilike, or, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { subjects, terms, units } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, deleteOrConflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors.js';
import { assertPathInScope, type Scope } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { findUnit, loadUnitIndex } from '../structure/service.js';

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export type TermDto = { id: string; name: string; startsOn: string; endsOn: string };

const toTermDto = (r: typeof terms.$inferSelect): TermDto => ({
  id: r.id,
  name: r.name,
  startsOn: r.startsOn,
  endsOn: r.endsOn,
});

const termNameTaken = (err: unknown, name: string): never => {
  if (isUniqueViolation(err, 'terms_name_uq')) throw conflict('TERM_NAME_TAKEN', `Term "${name}" already exists`);
  throw err;
};

export async function findTerm(db: DbOrTx, instituteId: string, termId: string) {
  const [row] = await db
    .select()
    .from(terms)
    .where(and(eq(terms.id, termId), eq(terms.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Term');
  return row;
}

export async function listTerms(db: Db, instituteId: string): Promise<TermDto[]> {
  const rows = await db.select().from(terms).where(eq(terms.instituteId, instituteId)).orderBy(desc(terms.startsOn));
  return rows.map(toTermDto);
}

function assertDateOrder(startsOn: string, endsOn: string) {
  if (endsOn < startsOn) throw badRequest('INVALID_DATES', 'The end date must be on or after the start date');
}

export async function createTerm(
  db: Db,
  auth: InstituteAuthContext,
  input: { name: string; startsOn: string; endsOn: string },
  ip?: string,
): Promise<TermDto> {
  assertDateOrder(input.startsOn, input.endsOn);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(terms)
      .values({ instituteId: auth.instituteId, ...input })
      .returning()
      .catch((err) => termNameTaken(err, input.name));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'term.created',
      entityType: 'term',
      entityId: row!.id,
      data: input,
      ip,
    });
    return toTermDto(row!);
  });
}

export async function updateTerm(
  db: Db,
  auth: InstituteAuthContext,
  termId: string,
  input: { name?: string; startsOn?: string; endsOn?: string },
  ip?: string,
): Promise<TermDto> {
  return db.transaction(async (tx) => {
    const before = await findTerm(tx, auth.instituteId, termId);
    assertDateOrder(input.startsOn ?? before.startsOn, input.endsOn ?? before.endsOn);
    const [row] = await tx
      .update(terms)
      .set(input)
      .where(eq(terms.id, termId))
      .returning()
      .catch((err) => termNameTaken(err, input.name ?? ''));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'term.updated',
      entityType: 'term',
      entityId: termId,
      data: { changes: input },
      ip,
    });
    return toTermDto(row!);
  });
}

export async function deleteTerm(db: Db, auth: InstituteAuthContext, termId: string, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const term = await findTerm(tx, auth.instituteId, termId);
    await deleteOrConflict(
      () => tx.delete(terms).where(eq(terms.id, termId)),
      'TERM_IN_USE',
      `Term "${term.name}" has course offerings; delete them first`,
    );
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'term.deleted',
      entityType: 'term',
      entityId: termId,
      data: { name: term.name },
      ip,
    });
  });
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export type SubjectDto = { id: string; code: string; name: string; unitId: string | null; unitPath: string[] };

type SubjectRow = typeof subjects.$inferSelect;

const subjectCodeTaken = (err: unknown, code: string): never => {
  if (isUniqueViolation(err, 'subjects_code_uq')) {
    throw conflict('SUBJECT_CODE_TAKEN', `Subject code "${code}" already exists`);
  }
  throw err;
};

export async function findSubject(db: DbOrTx, instituteId: string, subjectId: string): Promise<SubjectRow> {
  const [row] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.id, subjectId), eq(subjects.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Subject');
  return row;
}

async function toSubjectDtos(db: DbOrTx, instituteId: string, rows: SubjectRow[]): Promise<SubjectDto[]> {
  const index = await loadUnitIndex(db, instituteId);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    unitId: r.unitId,
    unitPath: r.unitId ? index.pathNames(r.unitId) : [],
  }));
}

/** HODs may only manage subjects owned by a unit inside their department. */
async function assertSubjectUnitInScope(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, unitId: string | null) {
  if (scope.all) {
    if (unitId) await findUnit(db, auth.instituteId, unitId);
    return;
  }
  if (!unitId) throw forbidden('Only admins can manage subjects without a department');
  assertPathInScope(scope, (await findUnit(db, auth.instituteId, unitId)).path, 'This unit');
}

export async function listSubjects(
  db: Db,
  instituteId: string,
  query: { q?: string; unitId?: string },
): Promise<SubjectDto[]> {
  const conditions: (SQL | undefined)[] = [eq(subjects.instituteId, instituteId)];
  if (query.q) {
    const pattern = containsPattern(query.q);
    conditions.push(or(ilike(subjects.code, pattern), ilike(subjects.name, pattern)));
  }
  if (query.unitId) conditions.push(sql`${units.path} @> ARRAY[${query.unitId}]::uuid[]`);
  const rows = await db
    .select({ subject: subjects })
    .from(subjects)
    .leftJoin(units, eq(units.id, subjects.unitId))
    .where(and(...conditions))
    .orderBy(asc(subjects.code));
  return toSubjectDtos(
    db,
    instituteId,
    rows.map((r) => r.subject),
  );
}

export async function createSubject(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  input: { code: string; name: string; unitId?: string | null },
  ip?: string,
): Promise<SubjectDto> {
  return db.transaction(async (tx) => {
    await assertSubjectUnitInScope(tx, auth, scope, input.unitId ?? null);
    const [row] = await tx
      .insert(subjects)
      .values({ instituteId: auth.instituteId, code: input.code, name: input.name, unitId: input.unitId ?? null })
      .returning()
      .catch((err) => subjectCodeTaken(err, input.code));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'subject.created',
      entityType: 'subject',
      entityId: row!.id,
      data: { code: input.code, name: input.name },
      ip,
    });
    const [dto] = await toSubjectDtos(tx, auth.instituteId, [row!]);
    return dto!;
  });
}

export async function updateSubject(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  subjectId: string,
  input: { code?: string; name?: string; unitId?: string | null },
  ip?: string,
): Promise<SubjectDto> {
  return db.transaction(async (tx) => {
    const before = await findSubject(tx, auth.instituteId, subjectId);
    await assertSubjectUnitInScope(tx, auth, scope, before.unitId);
    if (input.unitId !== undefined) await assertSubjectUnitInScope(tx, auth, scope, input.unitId);
    const [row] = await tx
      .update(subjects)
      .set(input)
      .where(eq(subjects.id, subjectId))
      .returning()
      .catch((err) => subjectCodeTaken(err, input.code ?? ''));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'subject.updated',
      entityType: 'subject',
      entityId: subjectId,
      data: { changes: input },
      ip,
    });
    const [dto] = await toSubjectDtos(tx, auth.instituteId, [row!]);
    return dto!;
  });
}

export async function deleteSubject(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  subjectId: string,
  ip?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const subject = await findSubject(tx, auth.instituteId, subjectId);
    await assertSubjectUnitInScope(tx, auth, scope, subject.unitId);
    await deleteOrConflict(
      () => tx.delete(subjects).where(eq(subjects.id, subjectId)),
      'SUBJECT_IN_USE',
      `Subject "${subject.code}" has course offerings; delete them first`,
    );
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'subject.deleted',
      entityType: 'subject',
      entityId: subjectId,
      data: { code: subject.code },
      ip,
    });
  });
}
