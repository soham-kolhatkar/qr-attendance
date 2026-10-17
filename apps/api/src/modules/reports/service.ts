import { and, asc, eq, ilike, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  attendanceRecords,
  attendanceSessions,
  offeringFaculty,
  offerings,
  sessionTallies,
  students,
  studentTallies,
  subjects,
  terms,
  units,
  users,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import type { Scope } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { getAttendanceSettings } from '../attendance/settings.js';
import { effectiveStatus } from '../attendance/sessions.js';
import { findVisibleOffering } from '../offerings/service.js';
import { loadUnitIndex } from '../structure/service.js';
import {
  addTallies,
  belowSql,
  type Counted,
  countedRecords,
  countedWhere,
  dateIn,
  instituteTimezone,
  isBelow,
  type ReportFilter,
  resolveTerm,
  type Tally,
  talliesWhere,
  type TermRef,
  toTally,
} from './query.js';
import { ensureTallies } from './tallies.js';

export type ReportQuery = Omit<ReportFilter, 'termId' | 'studentId'> & { termId?: string };

type Context = {
  term: TermRef;
  minimumPercent: number;
  timezone: string;
  filter: ReportFilter;
  /** Raw records (for one student, or group-filtered trends). */
  counted: Counted;
};

/** Term, threshold, time zone and the counted records for one report request; ctx is null if there's no term yet. */
async function reportContext(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  query: ReportQuery & { studentId?: string },
  now: Date,
): Promise<{ ctx: Context | null; minimumPercent: number }> {
  const settings = await getAttendanceSettings(db, auth.instituteId);
  const timezone = await instituteTimezone(db, auth.instituteId);
  const term = await resolveTerm(db, auth.instituteId, query.termId, dateIn(timezone, now));
  if (!term) return { ctx: null, minimumPercent: settings.minimumPercent };
  const filter = { ...query, termId: term.id };
  const counted = countedRecords(db, countedWhere(auth, scope, filter, now));
  return { ctx: { term, minimumPercent: settings.minimumPercent, timezone, filter, counted }, minimumPercent: settings.minimumPercent };
}

/** Counts over the counted records (raw, so usable in HAVING and ORDER BY too). */
function aggregates(c: Counted) {
  const agg = {
    present: sql`count(*) filter (where ${c.status} = 'present')`,
    absent: sql`count(*) filter (where ${c.status} = 'absent')`,
    excused: sql`count(*) filter (where ${c.status} = 'excused')`,
    total: sql`count(*)`,
  };
  return {
    agg,
    fields: {
      present: sql<number>`${agg.present}`.mapWith(Number).as('present'),
      absent: sql<number>`${agg.absent}`.mapWith(Number).as('absent'),
      excused: sql<number>`${agg.excused}`.mapWith(Number).as('excused'),
      total: sql<number>`${agg.total}`.mapWith(Number).as('total'),
    },
    percent: sql`(${agg.present})::float / nullif((${agg.total}) - (${agg.excused}), 0)`,
    sessions: sql<number>`count(distinct ${c.sessionId})`.mapWith(Number).as('sessions'),
  };
}

type Counts = { present: unknown; absent: unknown; excused: unknown; total: unknown };

/** Sums of count columns (raw, so usable in HAVING and ORDER BY too). */
function sums(t: Counts) {
  const agg = {
    present: sql`sum(${t.present})`,
    absent: sql`sum(${t.absent})`,
    excused: sql`sum(${t.excused})`,
    total: sql`sum(${t.total})`,
  };
  return {
    agg,
    fields: {
      present: sql<number>`${agg.present}`.mapWith(Number).as('present'),
      absent: sql<number>`${agg.absent}`.mapWith(Number).as('absent'),
      excused: sql<number>`${agg.excused}`.mapWith(Number).as('excused'),
      total: sql<number>`${agg.total}`.mapWith(Number).as('total'),
    },
    percent: sql`(${agg.present})::float / nullif((${agg.total}) - (${agg.excused}), 0)`,
  };
}

/** The per-student totals a report covers, as a CTE: `db.with(st).select(...).from(st)`. */
function studentTotals(db: Db, where: SQL) {
  return db.$with('st').as(
    db
      .select({
        studentId: studentTallies.studentId,
        subjectId: offerings.subjectId,
        unitId: students.unitId,
        rollNo: students.rollNo,
        unitName: sql<string>`${units.name}`.as('unit_name'),
        present: studentTallies.present,
        absent: studentTallies.absent,
        excused: studentTallies.excused,
        total: studentTallies.total,
      })
      .from(studentTallies)
      .innerJoin(offerings, eq(offerings.id, studentTallies.offeringId))
      .innerJoin(students, eq(students.userId, studentTallies.studentId))
      .innerJoin(units, eq(units.id, students.unitId))
      .where(where),
  );
}

/** The per-session totals a report covers, as a CTE. */
function sessionTotals(db: Db, where: SQL) {
  return db.$with('ss').as(
    db
      .select({
        sessionId: sessionTallies.sessionId,
        startedAt: sessionTallies.startedAt,
        subjectId: offerings.subjectId,
        present: sessionTallies.present,
        absent: sessionTallies.absent,
        excused: sessionTallies.excused,
        total: sessionTallies.total,
      })
      .from(sessionTallies)
      .innerJoin(offerings, eq(offerings.id, sessionTallies.offeringId))
      .innerJoin(units, eq(units.id, sessionTallies.unitId))
      .where(where),
  );
}

const tallyOf = (r: { present: number; absent: number; excused: number; total: number }) =>
  toTally(r.present, r.absent, r.excused, r.total);

/** Sums a subquery's per-student counts, with how many students are below the minimum. */
function sumPerStudent<T extends { present: unknown; absent: unknown; excused: unknown; total: unknown }>(per: T, minimumPercent: number) {
  return {
    present: sql<number>`sum(${per.present})`.mapWith(Number),
    absent: sql<number>`sum(${per.absent})`.mapWith(Number),
    excused: sql<number>`sum(${per.excused})`.mapWith(Number),
    total: sql<number>`sum(${per.total})`.mapWith(Number),
    students: sql<number>`count(*)`.mapWith(Number),
    below: sql<number>`count(*) filter (where ${belowSql(per, minimumPercent)})`.mapWith(Number),
  };
}

async function subjectNames(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, { code: string; name: string }>();
  const rows = await db.select({ id: subjects.id, code: subjects.code, name: subjects.name }).from(subjects).where(inArray(subjects.id, ids));
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
}

const collator = new Intl.Collator(undefined, { numeric: true });

// ---------------------------------------------------------------------------
// Summary: the dashboard
// ---------------------------------------------------------------------------

export type ReportSummary = {
  term: TermRef | null;
  minimumPercent: number;
  overall: Tally;
  sessions: number;
  students: { total: number; below: number };
  /** One point per day with classes, in the institute's time zone. */
  trend: { date: string; sessions: number; percentage: number | null }[];
  /** By the students' classes. */
  byUnit: ({ unitId: string; path: string[]; students: number; below: number } & Tally)[];
  bySubject: ({ subjectId: string; code: string; name: string; sessions: number; students: number; below: number } & Tally)[];
  /** Weekday 1 = Monday … 7 = Sunday; hour 0–23 when the session started. */
  heatmap: { weekday: number; hour: number; sessions: number; percentage: number | null }[];
};

export async function getSummary(db: Db, auth: InstituteAuthContext, scope: Scope, query: ReportQuery, now: Date): Promise<ReportSummary> {
  const { ctx, minimumPercent } = await reportContext(db, auth, scope, query, now);
  if (!ctx) {
    return {
      term: null,
      minimumPercent,
      overall: toTally(0, 0, 0, 0),
      sessions: 0,
      students: { total: 0, below: 0 },
      trend: [],
      byUnit: [],
      bySubject: [],
      heatmap: [],
    };
  }
  await ensureTallies(db, auth.instituteId, now);
  const { filter } = ctx;
  const st = studentTotals(db, talliesWhere(studentTallies, auth, scope, filter));
  const { fields } = sums(st);

  // The subqueries carry their own WITH clause.
  const perStudent = db.with(st).select({ studentId: st.studentId, unitId: st.unitId, ...fields }).from(st).groupBy(st.studentId, st.unitId).as('per');
  const unitRows = await db
    .select({ unitId: perStudent.unitId, ...sumPerStudent(perStudent, minimumPercent) })
    .from(perStudent)
    .groupBy(perStudent.unitId);

  const perSubject = db
    .with(st)
    .select({ subjectId: st.subjectId, studentId: st.studentId, ...fields })
    .from(st)
    .groupBy(st.subjectId, st.studentId)
    .as('per_subject');
  const subjectRows = await db
    .select({ subjectId: perSubject.subjectId, ...sumPerStudent(perSubject, minimumPercent) })
    .from(perSubject)
    .groupBy(perSubject.subjectId);

  const { trendRows, heatRows, subjectSessions } = filter.groupId
    ? await sessionStatsFromRecords(db, ctx)
    : await sessionStatsFromTallies(db, auth, scope, ctx);

  const index = await loadUnitIndex(db, auth.instituteId);
  const names = await subjectNames(db, subjectRows.map((r) => r.subjectId));
  const sessionsBySubject = new Map(subjectSessions.map((r) => [r.subjectId, r.sessions]));

  const byUnit = unitRows
    .map((r) => ({ unitId: r.unitId, path: index.pathNames(r.unitId), students: r.students, below: r.below, ...tallyOf(r) }))
    .sort((a, b) => collator.compare(a.path.join('/'), b.path.join('/')));
  const bySubject = subjectRows
    .map((r) => ({
      subjectId: r.subjectId,
      code: names.get(r.subjectId)?.code ?? '?',
      name: names.get(r.subjectId)?.name ?? '?',
      sessions: sessionsBySubject.get(r.subjectId) ?? 0,
      students: r.students,
      below: r.below,
      ...tallyOf(r),
    }))
    .sort((a, b) => collator.compare(a.code, b.code));

  return {
    term: ctx.term,
    minimumPercent,
    overall: addTallies(byUnit),
    sessions: trendRows.reduce((n, r) => n + r.sessions, 0),
    students: { total: byUnit.reduce((n, u) => n + u.students, 0), below: byUnit.reduce((n, u) => n + u.below, 0) },
    trend: trendRows.map((r) => ({ date: r.date, sessions: r.sessions, percentage: tallyOf(r).percentage })),
    byUnit,
    bySubject,
    heatmap: heatRows.map((r) => ({ weekday: r.weekday, hour: r.hour, sessions: r.sessions, percentage: tallyOf(r).percentage })),
  };
}

type SessionStats = {
  trendRows: { date: string; sessions: number; present: number; absent: number; excused: number; total: number }[];
  heatRows: { weekday: number; hour: number; sessions: number; present: number; absent: number; excused: number; total: number }[];
  subjectSessions: { subjectId: string; sessions: number }[];
};

/** By day, by weekday × hour, and sessions per subject — from the per-session totals. */
async function sessionStatsFromTallies(db: Db, auth: InstituteAuthContext, scope: Scope, ctx: Context): Promise<SessionStats> {
  const ss = sessionTotals(db, talliesWhere(sessionTallies, auth, scope, ctx.filter));
  const { fields } = sums(ss);
  const sessions = sql<number>`count(distinct ${ss.sessionId})`.mapWith(Number).as('sessions');
  const local = sql`(${ss.startedAt} at time zone ${ctx.timezone})`;
  const trendRows = await db
    .with(ss)
    .select({ date: sql<string>`to_char(${local}, 'YYYY-MM-DD')`.as('date'), sessions, ...fields })
    .from(ss)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const heatRows = await db
    .with(ss)
    .select({
      weekday: sql<number>`extract(isodow from ${local})`.mapWith(Number).as('weekday'),
      hour: sql<number>`extract(hour from ${local})`.mapWith(Number).as('hour'),
      sessions,
      ...fields,
    })
    .from(ss)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`, sql`2`);
  const subjectSessions = await db.with(ss).select({ subjectId: ss.subjectId, sessions }).from(ss).groupBy(ss.subjectId);
  return { trendRows, heatRows, subjectSessions };
}

/** The same from the records themselves, when filtering by a group (batch, elective). */
async function sessionStatsFromRecords(db: Db, ctx: Context): Promise<SessionStats> {
  const c = ctx.counted;
  const { fields, sessions } = aggregates(c);
  const local = sql`(${c.startedAt} at time zone ${ctx.timezone})`;
  const trendRows = await db
    .with(c)
    .select({ date: sql<string>`to_char(${local}, 'YYYY-MM-DD')`.as('date'), sessions, ...fields })
    .from(c)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const heatRows = await db
    .with(c)
    .select({
      weekday: sql<number>`extract(isodow from ${local})`.mapWith(Number).as('weekday'),
      hour: sql<number>`extract(hour from ${local})`.mapWith(Number).as('hour'),
      sessions,
      ...fields,
    })
    .from(c)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`, sql`2`);
  const subjectSessions = await db.with(c).select({ subjectId: c.subjectId, sessions }).from(c).groupBy(c.subjectId);
  return { trendRows, heatRows, subjectSessions };
}

// ---------------------------------------------------------------------------
// Students: who is below the minimum
// ---------------------------------------------------------------------------

export type StudentListQuery = ReportQuery & {
  /** Only students below the minimum percentage. */
  below?: boolean;
  q?: string;
  sort: 'percentage' | 'name' | 'roll';
  page: number;
  pageSize: number;
};

export type StudentRow = {
  student: { id: string; username: string; fullName: string; rollNo: string | null; unitPath: string[] };
  below: boolean;
} & Tally;

export async function listStudentReport(db: Db, auth: InstituteAuthContext, scope: Scope, query: StudentListQuery, now: Date) {
  const { ctx, minimumPercent } = await reportContext(db, auth, scope, query, now);
  if (!ctx) return { term: null, minimumPercent, items: [] as StudentRow[], total: 0, page: query.page, pageSize: query.pageSize };
  const rows = await studentRows(db, auth, scope, ctx, query, now, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
  return { term: ctx.term, minimumPercent, items: rows.items, total: rows.total, page: query.page, pageSize: query.pageSize };
}

async function studentRows(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  ctx: Context,
  query: Omit<StudentListQuery, 'page' | 'pageSize'>,
  now: Date,
  page?: { limit: number; offset: number },
): Promise<{ items: StudentRow[]; total: number }> {
  await ensureTallies(db, auth.instituteId, now);
  const st = studentTotals(db, talliesWhere(studentTallies, auth, scope, ctx.filter));
  const { agg, fields, percent } = sums(st);
  const search = query.q
    ? or(ilike(users.username, containsPattern(query.q)), ilike(users.fullName, containsPattern(query.q)), ilike(st.rollNo, containsPattern(query.q)))
    : undefined;
  const order = {
    percentage: [sql`${percent} asc nulls last`, asc(users.fullName)],
    name: [asc(users.fullName), asc(users.username)],
    roll: [asc(st.unitName), sql`lpad(coalesce(${st.rollNo}, ''), 12, '0')`, asc(users.username)],
  }[query.sort];

  let q = db
    .with(st)
    .select({
      studentId: st.studentId,
      username: users.username,
      fullName: users.fullName,
      rollNo: st.rollNo,
      unitId: st.unitId,
      ...fields,
      totalRows: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(st)
    .innerJoin(users, eq(users.id, st.studentId))
    .where(search)
    .groupBy(st.studentId, users.username, users.fullName, st.rollNo, st.unitId, st.unitName)
    .orderBy(...order)
    .$dynamic();
  if (query.below) q = q.having(belowSql(agg, ctx.minimumPercent));
  if (page) q = q.limit(page.limit).offset(page.offset);
  const rows = await q;

  const index = await loadUnitIndex(db, auth.instituteId);
  return {
    total: rows[0]?.totalRows ?? 0,
    items: rows.map((r) => {
      const tally = tallyOf(r);
      return {
        student: { id: r.studentId, username: r.username, fullName: r.fullName, rollNo: r.rollNo, unitPath: index.pathNames(r.unitId) },
        below: isBelow(tally, ctx.minimumPercent),
        ...tally,
      };
    }),
  };
}

export type StudentExport = {
  term: TermRef | null;
  minimumPercent: number;
  rows: StudentRow[];
  subjects: { subjectId: string; code: string; name: string }[];
  /** studentId → subjectId → tally */
  bySubject: Map<string, Map<string, Tally>>;
};

/** Every matching student (no paging), with a per-subject breakdown, for downloads. */
export async function exportStudentReport(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  query: Omit<StudentListQuery, 'page' | 'pageSize'>,
  now: Date,
): Promise<StudentExport> {
  const { ctx, minimumPercent } = await reportContext(db, auth, scope, query, now);
  if (!ctx) return { term: null, minimumPercent, rows: [], subjects: [], bySubject: new Map() };
  const { items } = await studentRows(db, auth, scope, ctx, query, now);
  const st = studentTotals(db, talliesWhere(studentTallies, auth, scope, ctx.filter));
  const cells = await db
    .with(st)
    .select({ studentId: st.studentId, subjectId: st.subjectId, ...sums(st).fields })
    .from(st)
    .groupBy(st.studentId, st.subjectId);
  const bySubject = new Map<string, Map<string, Tally>>();
  for (const cell of cells) {
    if (!bySubject.has(cell.studentId)) bySubject.set(cell.studentId, new Map());
    bySubject.get(cell.studentId)!.set(cell.subjectId, tallyOf(cell));
  }
  const names = await subjectNames(db, [...new Set(cells.map((cell) => cell.subjectId))]);
  const subjectList = [...names.entries()]
    .map(([subjectId, n]) => ({ subjectId, ...n }))
    .sort((a, b) => collator.compare(a.code, b.code));
  return { term: ctx.term, minimumPercent, rows: items, subjects: subjectList, bySubject };
}

// ---------------------------------------------------------------------------
// One student
// ---------------------------------------------------------------------------

export type StudentReport = {
  student: { id: string; username: string; fullName: string; rollNo: string | null; unitPath: string[] };
  term: TermRef | null;
  minimumPercent: number;
  overall: Tally;
  subjects: ({ subjectId: string; code: string; name: string } & Tally)[];
  /** Finished sessions, latest first. */
  sessions: {
    sessionId: string;
    startedAt: string;
    kind: string;
    topic: string | null;
    subject: { code: string; name: string };
    status: 'present' | 'absent' | 'excused';
    method: 'qr' | 'manual' | null;
    markedAt: string | null;
    reason: string | null;
  }[];
};

/**
 * A student's attendance as staff see it. Faculty see only the classes they teach; a
 * student outside the caller's view is "not found".
 */
export async function getStudentReport(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  studentId: string,
  termId: string | undefined,
  now: Date,
): Promise<StudentReport> {
  const [row] = await db
    .select({ username: users.username, fullName: users.fullName, rollNo: students.rollNo, unitId: students.unitId, path: units.path })
    .from(students)
    .innerJoin(users, eq(users.id, students.userId))
    .innerJoin(units, eq(units.id, students.unitId))
    .where(and(eq(students.userId, studentId), eq(students.instituteId, auth.instituteId)))
    .limit(1);
  if (!row) throw notFound('Student');
  const inDepartment = scope.all || (scope.unitId !== null && row.path.includes(scope.unitId));
  if (!inDepartment) {
    const [taught] = await db
      .select({ one: sql`1` })
      .from(attendanceRecords)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
      .innerJoin(offeringFaculty, eq(offeringFaculty.offeringId, attendanceSessions.offeringId))
      .where(and(eq(attendanceRecords.studentId, studentId), eq(offeringFaculty.userId, auth.userId)))
      .limit(1);
    if (!taught) throw notFound('Student');
  }

  const index = await loadUnitIndex(db, auth.instituteId);
  const student = { id: studentId, username: row.username, fullName: row.fullName, rollNo: row.rollNo, unitPath: index.pathNames(row.unitId) };
  const { ctx, minimumPercent } = await reportContext(db, auth, scope, { termId, studentId }, now);
  if (!ctx) return { student, term: null, minimumPercent, overall: toTally(0, 0, 0, 0), subjects: [], sessions: [] };

  const c = ctx.counted;
  const rows = await db
    .with(c)
    .select({
      sessionId: c.sessionId,
      startedAt: c.startedAt,
      kind: c.kind,
      topic: c.topic,
      subjectId: c.subjectId,
      code: subjects.code,
      name: subjects.name,
      status: c.status,
      method: c.method,
      markedAt: c.markedAt,
      reason: c.reason,
    })
    .from(c)
    .innerJoin(subjects, eq(subjects.id, c.subjectId))
    .orderBy(sql`${c.startedAt} desc`);

  const count = (list: typeof rows, s: string) => list.filter((r) => r.status === s).length;
  const tallyList = (list: typeof rows) => toTally(count(list, 'present'), count(list, 'absent'), count(list, 'excused'), list.length);
  const bySubject = new Map<string, typeof rows>();
  for (const r of rows) bySubject.set(r.subjectId, [...(bySubject.get(r.subjectId) ?? []), r]);

  return {
    student,
    term: ctx.term,
    minimumPercent,
    overall: tallyList(rows),
    subjects: [...bySubject.entries()]
      .map(([subjectId, list]) => ({ subjectId, code: list[0]!.code, name: list[0]!.name, ...tallyList(list) }))
      .sort((a, b) => collator.compare(a.code, b.code)),
    sessions: rows.map((r) => ({
      sessionId: r.sessionId,
      startedAt: r.startedAt.toISOString(),
      kind: r.kind,
      topic: r.topic,
      subject: { code: r.code, name: r.name },
      status: r.status,
      method: r.method,
      markedAt: r.markedAt?.toISOString() ?? null,
      reason: r.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// Register: students × sessions for one offering
// ---------------------------------------------------------------------------

export type Mark = 'present' | 'absent' | 'excused' | null;

export type Register = {
  offering: {
    id: string;
    subject: { code: string; name: string };
    term: { id: string; name: string };
    faculty: string[];
  };
  minimumPercent: number;
  /** Oldest first. Open sessions are shown but not counted yet. */
  sessions: { id: string; startedAt: string; kind: string; topic: string | null; open: boolean }[];
  students: ({
    id: string;
    username: string;
    fullName: string;
    rollNo: string | null;
    unitPath: string[];
    /** One per session, in order; null when the student wasn't on that session's list. */
    marks: Mark[];
    below: boolean;
  } & Tally)[];
};

/** The classic attendance register for an offering the caller can see. */
export async function getRegister(db: Db, auth: InstituteAuthContext, scope: Scope, offeringId: string, now: Date): Promise<Register> {
  const offering = await findVisibleOffering(db, auth, scope, offeringId);
  const [info] = await db
    .select({ code: subjects.code, name: subjects.name, termId: terms.id, termName: terms.name })
    .from(subjects)
    .innerJoin(terms, eq(terms.id, offering.termId))
    .where(eq(subjects.id, offering.subjectId));
  const faculty = await db
    .select({ fullName: users.fullName })
    .from(offeringFaculty)
    .innerJoin(users, eq(users.id, offeringFaculty.userId))
    .where(eq(offeringFaculty.offeringId, offeringId))
    .orderBy(asc(users.fullName));
  const { minimumPercent } = await getAttendanceSettings(db, auth.instituteId);

  const sessionRows = await db
    .select()
    .from(attendanceSessions)
    .where(and(eq(attendanceSessions.offeringId, offeringId), ne(attendanceSessions.status, 'cancelled')))
    .orderBy(asc(attendanceSessions.startedAt));
  const records = sessionRows.length
    ? await db
        .select({
          sessionId: attendanceRecords.sessionId,
          studentId: attendanceRecords.studentId,
          status: attendanceRecords.status,
          username: users.username,
          fullName: users.fullName,
          rollNo: students.rollNo,
          unitId: students.unitId,
        })
        .from(attendanceRecords)
        .innerJoin(students, eq(students.userId, attendanceRecords.studentId))
        .innerJoin(users, eq(users.id, attendanceRecords.studentId))
        .where(inArray(attendanceRecords.sessionId, sessionRows.map((s) => s.id)))
    : [];

  const sessions = sessionRows.map((s) => ({
    id: s.id,
    startedAt: s.startedAt.toISOString(),
    kind: s.kind,
    topic: s.topic,
    open: effectiveStatus(s, now) === 'open',
  }));
  const column = new Map(sessions.map((s, i) => [s.id, i]));
  const index = await loadUnitIndex(db, auth.instituteId);
  const byStudent = new Map<string, Register['students'][number]>();
  for (const r of records) {
    let row = byStudent.get(r.studentId);
    if (!row) {
      row = {
        id: r.studentId,
        username: r.username,
        fullName: r.fullName,
        rollNo: r.rollNo,
        unitPath: index.pathNames(r.unitId),
        marks: sessions.map(() => null),
        below: false,
        ...toTally(0, 0, 0, 0),
      };
      byStudent.set(r.studentId, row);
    }
    row.marks[column.get(r.sessionId)!] = r.status;
  }
  for (const row of byStudent.values()) {
    const counted = row.marks.filter((m, i): m is NonNullable<Mark> => m !== null && !sessions[i]!.open);
    const tally = toTally(
      counted.filter((m) => m === 'present').length,
      counted.filter((m) => m === 'absent').length,
      counted.filter((m) => m === 'excused').length,
      counted.length,
    );
    Object.assign(row, tally, { below: isBelow(tally, minimumPercent) });
  }
  return {
    offering: {
      id: offering.id,
      subject: { code: info!.code, name: info!.name },
      term: { id: info!.termId, name: info!.termName },
      faculty: faculty.map((f) => f.fullName),
    },
    minimumPercent,
    sessions,
    students: [...byStudent.values()].sort(
      (a, b) =>
        collator.compare(a.unitPath.join('/'), b.unitPath.join('/')) ||
        collator.compare(a.rollNo ?? '', b.rollNo ?? '') ||
        collator.compare(a.username, b.username),
    ),
  };
}
