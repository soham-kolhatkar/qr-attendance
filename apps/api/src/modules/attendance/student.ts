import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, offerings, subjects, terms } from '../../db/schema.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { canRequestCorrection, latestCorrections, type MyCorrection, requestableFrom } from '../corrections/service.js';
import { effectiveStatus } from './sessions.js';
import { getAttendanceSettings } from './settings.js';

export type Tally = { present: number; absent: number; excused: number; total: number; percentage: number | null };

export type MyAttendance = {
  term: { id: string; name: string } | null;
  /** The institute's minimum attendance percentage. */
  minimumPercent: number;
  /** Days after a class within which the student can ask for a correction; 0 = not in the app. */
  correctionWindowDays: number;
  /** Terms the student has attendance in, newest first. */
  terms: { id: string; name: string }[];
  overall: Tally;
  subjects: ({ offeringId: string; subject: { code: string; name: string } } & Tally)[];
  /** Latest sessions first. "open" sessions are still taking attendance and aren't counted yet. */
  recent: {
    sessionId: string;
    startedAt: string;
    kind: string;
    topic: string | null;
    subject: { code: string; name: string };
    status: 'present' | 'absent' | 'excused';
    method: 'qr' | 'manual' | null;
    open: boolean;
    /** The latest correction request for this class, if any. */
    correction: MyCorrection | null;
    /** What the student may ask to be marked instead, now; empty when they can't ask. */
    canRequest: ('present' | 'excused')[];
  }[];
};

const RECENT_LIMIT = 30;

/**
 * Attendance percentage = present ÷ (sessions − excused): an excused absence (e.g. a
 * medical certificate) counts neither for nor against the student.
 */
function tally(rows: { status: string }[]): Tally {
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const present = count('present');
  const excused = count('excused');
  const total = rows.length;
  const counted = total - excused;
  return {
    present,
    absent: count('absent'),
    excused,
    total,
    percentage: counted > 0 ? Math.round((present / counted) * 1000) / 10 : null,
  };
}

/** A student's own attendance for one term (default: the term of their latest class). */
export async function getMyAttendance(
  db: Db,
  auth: InstituteAuthContext,
  termId: string | undefined,
  now: Date,
): Promise<MyAttendance> {
  const base = () =>
    db
      .select({
        sessionId: attendanceSessions.id,
        startedAt: attendanceSessions.startedAt,
        closesAt: attendanceSessions.closesAt,
        sessionStatus: attendanceSessions.status,
        kind: attendanceSessions.kind,
        topic: attendanceSessions.topic,
        offeringId: offerings.id,
        termId: terms.id,
        termName: terms.name,
        code: subjects.code,
        name: subjects.name,
        status: attendanceRecords.status,
        method: attendanceRecords.method,
      })
      .from(attendanceRecords)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
      .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
      .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
      .innerJoin(terms, eq(terms.id, offerings.termId));
  const mine = and(
    eq(attendanceRecords.instituteId, auth.instituteId),
    eq(attendanceRecords.studentId, auth.userId),
    ne(attendanceSessions.status, 'cancelled'),
  );

  const termRows = await db
    .selectDistinctOn([terms.id], { id: terms.id, name: terms.name, startsOn: terms.startsOn })
    .from(attendanceRecords)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .innerJoin(terms, eq(terms.id, offerings.termId))
    .where(mine);
  const termList = termRows.sort((a, b) => b.startsOn.localeCompare(a.startsOn)).map(({ id, name }) => ({ id, name }));
  const term = termList.find((t) => t.id === termId) ?? (termId ? undefined : termList[0]);
  const { minimumPercent, correctionWindowDays } = await getAttendanceSettings(db, auth.instituteId);
  const empty = { term: term ?? null, minimumPercent, correctionWindowDays, terms: termList, overall: tally([]), subjects: [], recent: [] };
  if (!term) return empty;

  const rows = await base()
    .where(and(mine, eq(terms.id, term.id)))
    .orderBy(desc(attendanceSessions.startedAt));
  const withOpen = rows.map((r) => ({ ...r, open: effectiveStatus({ status: r.sessionStatus, closesAt: r.closesAt }, now) === 'open' }));
  const counted = withOpen.filter((r) => !r.open);

  const byOffering = new Map<string, typeof counted>();
  for (const r of counted) byOffering.set(r.offeringId, [...(byOffering.get(r.offeringId) ?? []), r]);
  const collator = new Intl.Collator(undefined, { numeric: true });
  const recent = withOpen.slice(0, RECENT_LIMIT);
  const corrections = await latestCorrections(
    db,
    auth.userId,
    recent.map((r) => r.sessionId),
  );

  return {
    term,
    minimumPercent,
    correctionWindowDays,
    terms: termList,
    overall: tally(counted),
    subjects: [...byOffering.entries()]
      .map(([offeringId, list]) => ({ offeringId, subject: { code: list[0]!.code, name: list[0]!.name }, ...tally(list) }))
      .sort((a, b) => collator.compare(a.subject.code, b.subject.code)),
    recent: recent.map((r) => {
      const correction = corrections.get(r.sessionId) ?? null;
      return {
        sessionId: r.sessionId,
        startedAt: r.startedAt.toISOString(),
        kind: r.kind,
        topic: r.topic,
        subject: { code: r.code, name: r.name },
        status: r.status,
        method: r.method,
        open: r.open,
        correction,
        canRequest: canRequestCorrection(r, correction ?? undefined, correctionWindowDays, now) ? requestableFrom(r.status) : [],
      };
    }),
  };
}
