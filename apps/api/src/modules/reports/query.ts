import { and, desc, eq, gte, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import {
  attendanceRecords,
  attendanceSessions,
  groupMembers,
  institutes,
  offeringFaculty,
  offerings,
  sessionTallies,
  students,
  studentTallies,
  terms,
  units,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import type { Scope } from '../../lib/scope.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';

/**
 * The rules every report shares.
 *
 * - A session counts once it has finished: not cancelled, and no longer taking
 *   attendance (closed, or past its closing time).
 * - Attendance % = present ÷ (sessions − excused). An excused absence (e.g. a medical
 *   certificate) counts neither for nor against the student.
 * - A student is a defaulter when their percentage is below the institute's minimum.
 * - Who sees what: admins everything; a HOD their department's students plus the
 *   classes they teach; faculty the classes they teach.
 */

export type Tally = { present: number; absent: number; excused: number; total: number; percentage: number | null };

export function toTally(present: number, absent: number, excused: number, total: number): Tally {
  const counted = total - excused;
  return {
    present,
    absent,
    excused,
    total,
    percentage: counted > 0 ? Math.round((present / counted) * 1000) / 10 : null,
  };
}

export const isBelow = (t: Tally, minimumPercent: number) => t.percentage !== null && t.percentage < minimumPercent;

export function addTallies(list: Tally[]): Tally {
  const sum = (k: 'present' | 'absent' | 'excused' | 'total') => list.reduce((n, t) => n + t[k], 0);
  return toTally(sum('present'), sum('absent'), sum('excused'), sum('total'));
}

/** SQL: these aggregated counts are below the minimum percentage. */
export const belowSql = (t: { present: unknown; excused: unknown; total: unknown }, minimumPercent: number) =>
  sql`(${t.total} - ${t.excused}) > 0 and ${t.present} * 100 < ${minimumPercent} * (${t.total} - ${t.excused})`;

export type ReportFilter = {
  termId: string;
  /** Students in this unit or below (a department, a year, a class). */
  unitId?: string;
  subjectId?: string;
  offeringId?: string;
  /** Students in this group (batch, elective). */
  groupId?: string;
  studentId?: string;
};

/** Records counted for a report: finished sessions of the term, within the caller's view. */
export function countedWhere(auth: InstituteAuthContext, scope: Scope, filter: ReportFilter, now: Date): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(attendanceRecords.instituteId, auth.instituteId),
    eq(offerings.termId, filter.termId),
    ne(attendanceSessions.status, 'cancelled'),
    or(eq(attendanceSessions.status, 'closed'), lte(attendanceSessions.closesAt, now)),
    viewCondition(auth, scope),
  ];
  if (filter.unitId) conditions.push(sql`${units.path} @> ARRAY[${filter.unitId}]::uuid[]`);
  if (filter.subjectId) conditions.push(eq(offerings.subjectId, filter.subjectId));
  if (filter.offeringId) conditions.push(eq(offerings.id, filter.offeringId));
  if (filter.studentId) conditions.push(eq(attendanceRecords.studentId, filter.studentId));
  if (filter.groupId) {
    conditions.push(
      sql`exists (select 1 from ${groupMembers} where ${groupMembers.groupId} = ${filter.groupId} and ${groupMembers.studentId} = ${attendanceRecords.studentId})`,
    );
  }
  return and(...conditions)!;
}

/**
 * The same filter over the totals tables: student_tallies (or session_tallies) joined
 * to offerings and the students' units. session_tallies has no per-student rows, so a
 * group filter there must use the records instead.
 */
export function talliesWhere(
  table: typeof studentTallies | typeof sessionTallies,
  auth: InstituteAuthContext,
  scope: Scope,
  filter: Omit<ReportFilter, 'studentId'>,
): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(table.instituteId, auth.instituteId),
    eq(offerings.termId, filter.termId),
    viewCondition(auth, scope),
  ];
  if (filter.unitId) conditions.push(sql`${units.path} @> ARRAY[${filter.unitId}]::uuid[]`);
  if (filter.subjectId) conditions.push(eq(offerings.subjectId, filter.subjectId));
  if (filter.offeringId) conditions.push(eq(offerings.id, filter.offeringId));
  if (filter.groupId) {
    if (table !== studentTallies) throw new Error('Group filters need per-student rows');
    conditions.push(
      sql`exists (select 1 from ${groupMembers} where ${groupMembers.groupId} = ${filter.groupId} and ${groupMembers.studentId} = ${studentTallies.studentId})`,
    );
  }
  return and(...conditions)!;
}

/** The caller's part of the institute, over rows joined to offerings and the students' units. */
function viewCondition(auth: InstituteAuthContext, scope: Scope): SQL | undefined {
  if (scope.all) return undefined;
  const teaches = sql`exists (select 1 from ${offeringFaculty} where ${offeringFaculty.offeringId} = ${offerings.id} and ${offeringFaculty.userId} = ${auth.userId})`;
  if (scope.unitId === null) return teaches;
  return or(sql`${units.path} @> ARRAY[${scope.unitId}]::uuid[]`, teaches);
}

/**
 * The records a report counts, as a CTE with what reports group and filter on:
 * `db.with(counted).select(...).from(counted)`.
 */
export function countedRecords(db: DbOrTx, where: SQL) {
  return db.$with('counted').as(
    db
      .select({
        studentId: attendanceRecords.studentId,
        status: attendanceRecords.status,
        method: attendanceRecords.method,
        markedAt: attendanceRecords.markedAt,
        reason: attendanceRecords.reason,
        sessionId: sql<string>`${attendanceSessions.id}`.as('session_id'),
        startedAt: attendanceSessions.startedAt,
        kind: attendanceSessions.kind,
        topic: attendanceSessions.topic,
        offeringId: sql<string>`${offerings.id}`.as('offering_id'),
        subjectId: offerings.subjectId,
        unitId: students.unitId,
        rollNo: students.rollNo,
      })
      .from(attendanceRecords)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
      .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
      .innerJoin(students, eq(students.userId, attendanceRecords.studentId))
      .innerJoin(units, eq(units.id, students.unitId))
      .where(where),
  );
}

export type Counted = ReturnType<typeof countedRecords>;

export type TermRef = { id: string; name: string; startsOn: string; endsOn: string };

/**
 * The requested term, or by default the current one: the term running today, else the
 * latest that has started, else the first upcoming. Null if the institute has none.
 */
export async function resolveTerm(db: DbOrTx, instituteId: string, termId: string | undefined, today: string): Promise<TermRef | null> {
  const columns = { id: terms.id, name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn };
  if (termId) {
    const [term] = await db
      .select(columns)
      .from(terms)
      .where(and(eq(terms.id, termId), eq(terms.instituteId, instituteId)))
      .limit(1);
    if (!term) throw notFound('Term');
    return term;
  }
  const [started] = await db
    .select(columns)
    .from(terms)
    .where(and(eq(terms.instituteId, instituteId), lte(terms.startsOn, today)))
    .orderBy(desc(terms.startsOn))
    .limit(1);
  if (started) return started;
  const [upcoming] = await db
    .select(columns)
    .from(terms)
    .where(and(eq(terms.instituteId, instituteId), gte(terms.startsOn, today)))
    .orderBy(terms.startsOn)
    .limit(1);
  return upcoming ?? null;
}

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** The institute's time zone (for days and hours in reports). */
export async function instituteTimezone(db: DbOrTx, instituteId: string): Promise<string> {
  const [row] = await db.select({ settings: institutes.settings }).from(institutes).where(eq(institutes.id, instituteId));
  return row?.settings.timezone ?? DEFAULT_TIMEZONE;
}

/** YYYY-MM-DD in the given time zone. */
export const dateIn = (timezone: string, at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
