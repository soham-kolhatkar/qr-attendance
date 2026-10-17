import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { institutes, jobRuns, notifications, offerings, studentTallies, subjects, users } from '../../db/schema.js';
import { resolveScope } from '../../lib/scope.js';
import { ATTENDANCE_DEFAULTS } from '../attendance/settings.js';
import { belowSql, DEFAULT_TIMEZONE, dateIn, resolveTerm, toTally } from '../reports/query.js';
import { listStudentReport } from '../reports/service.js';
import { ensureTallies } from '../reports/tallies.js';
import { lowAttendance, weeklySummary } from './messages.js';
import { type NewNotification, notify } from './service.js';

/** Low-attendance reminders go out after classes, from this hour (institute time). */
export const LOW_ALERT_HOUR = 17;
/** The weekly staff summary goes out from Monday at this hour (or the first time the server is up after it). */
export const SUMMARY_HOUR = 8;
/** A student isn't judged on fewer counted classes than this (one absence on day one would be 0%). */
export const MIN_COUNTED_CLASSES = 5;
/** A student below the minimum is reminded at most this often. */
const LOW_ALERT_EVERY_MS = 7 * 24 * 3600_000 - 12 * 3600_000; // a week, give or take the time of day

/** Date, hour, weekday (1 = Monday) and ISO week in a time zone. */
export function localTime(timezone: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const date = dateIn(timezone, at);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1;
  // ISO week: the week (Monday–Sunday) belongs to the year its Thursday is in.
  const thursday = new Date(`${date}T00:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { date, hour: Number(parts.hour), weekday, isoWeek: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}

/**
 * Daily and weekly notifications, for every active institute whose time has come. Each
 * runs once per period (recorded in job_runs), even with several servers running this.
 * The free hosting plan sleeps when nobody uses it, so a job runs the first time the
 * server is up after its hour.
 */
export async function runScheduledJobs(db: Db, now: Date, log?: FastifyBaseLogger): Promise<void> {
  const list = await db
    .select({ id: institutes.id, settings: institutes.settings })
    .from(institutes)
    .where(eq(institutes.status, 'active'));
  for (const inst of list) {
    const local = localTime(inst.settings.timezone ?? DEFAULT_TIMEZONE, now);
    const settings = { ...ATTENDANCE_DEFAULTS, ...inst.settings.attendance };
    try {
      if (settings.lowAttendanceAlerts && local.hour >= LOW_ALERT_HOUR) {
        await runOnce(db, 'low_attendance', inst.id, local.date, now, () => lowAttendanceAlerts(db, inst.id, settings.minimumPercent, now));
      }
      if (settings.weeklyStaffSummary && (local.weekday > 1 || local.hour >= SUMMARY_HOUR)) {
        await runOnce(db, 'weekly_summary', inst.id, local.isoWeek, now, () => weeklySummaries(db, inst.id, now));
      }
    } catch (err) {
      log?.error({ err, instituteId: inst.id }, 'scheduled notifications failed');
    }
  }
}

/** Works out a job's notifications and saves them, unless the job already ran for this period. */
async function runOnce(db: Db, job: string, instituteId: string, period: string, now: Date, compute: () => Promise<NewNotification[]>) {
  const key = and(eq(jobRuns.job, job), eq(jobRuns.instituteId, instituteId), eq(jobRuns.period, period));
  const [done] = await db.select({ job: jobRuns.job }).from(jobRuns).where(key).limit(1);
  if (done) return null;
  const list = await compute();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(jobRuns)
      .values({ job, instituteId, period, result: { notifications: list.length }, ranAt: now })
      .onConflictDoNothing()
      .returning({ job: jobRuns.job });
    if (!claimed) return null; // another server got there first
    await notify(tx, list, now);
    return list.length;
  });
}

/** Students below the minimum this term (overall), not reminded in the past week. */
export async function lowAttendanceAlerts(db: Db, instituteId: string, minimumPercent: number, now: Date): Promise<NewNotification[]> {
  await ensureTallies(db, instituteId, now);
  const [inst] = await db.select({ settings: institutes.settings }).from(institutes).where(eq(institutes.id, instituteId));
  const term = await resolveTerm(db, instituteId, undefined, dateIn(inst?.settings.timezone ?? DEFAULT_TIMEZONE, now));
  if (!term) return [];

  const sums = {
    present: sql<number>`sum(${studentTallies.present})`.mapWith(Number),
    absent: sql<number>`sum(${studentTallies.absent})`.mapWith(Number),
    excused: sql<number>`sum(${studentTallies.excused})`.mapWith(Number),
    total: sql<number>`sum(${studentTallies.total})`.mapWith(Number),
  };
  const remindedSince = new Date(now.getTime() - LOW_ALERT_EVERY_MS);
  const below = await db
    .select({ studentId: studentTallies.studentId, ...sums })
    .from(studentTallies)
    .innerJoin(offerings, eq(offerings.id, studentTallies.offeringId))
    .innerJoin(users, eq(users.id, studentTallies.studentId))
    .where(
      and(
        eq(studentTallies.instituteId, instituteId),
        eq(offerings.termId, term.id),
        eq(users.status, 'active'),
        sql`not exists (select 1 from ${notifications} n where n.user_id = ${studentTallies.studentId} and n.kind = 'attendance.low' and n.created_at >= ${remindedSince})`,
      ),
    )
    .groupBy(studentTallies.studentId)
    .having(
      and(
        sql`${sums.total} - ${sums.excused} >= ${MIN_COUNTED_CLASSES}`,
        belowSql({ present: sums.present, excused: sums.excused, total: sums.total }, minimumPercent),
      ),
    );
  if (below.length === 0) return [];

  const bySubject = new Map<string, { code: string; name: string; percentage: number }[]>();
  for (let i = 0; i < below.length; i += 5000) {
    const rows = await db
      .select({
        studentId: studentTallies.studentId,
        code: subjects.code,
        name: subjects.name,
        present: studentTallies.present,
        absent: studentTallies.absent,
        excused: studentTallies.excused,
        total: studentTallies.total,
      })
      .from(studentTallies)
      .innerJoin(offerings, eq(offerings.id, studentTallies.offeringId))
      .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
      .where(
        and(
          eq(offerings.termId, term.id),
          inArray(
            studentTallies.studentId,
            below.slice(i, i + 5000).map((b) => b.studentId),
          ),
        ),
      );
    for (const r of rows) {
      const { percentage } = toTally(r.present, r.absent, r.excused, r.total);
      if (percentage === null || percentage >= minimumPercent) continue;
      bySubject.set(r.studentId, [...(bySubject.get(r.studentId) ?? []), { code: r.code, name: r.name, percentage }]);
    }
  }

  return below.map((b) => {
    const tally = toTally(b.present, b.absent, b.excused, b.total);
    return {
      instituteId,
      userId: b.studentId,
      ...lowAttendance({
        termId: term.id,
        termName: term.name,
        minimumPercent,
        present: b.present,
        counted: b.total - b.excused,
        percentage: tally.percentage!,
        subjectsBelow: (bySubject.get(b.studentId) ?? []).sort((x, y) => x.percentage - y.percentage),
      }),
    };
  });
}

const SUMMARY_SIZE = 10;

/** For each teacher, HOD and admin with students below the minimum in what they see: the count and the lowest few. */
export async function weeklySummaries(db: Db, instituteId: string, now: Date): Promise<NewNotification[]> {
  await ensureTallies(db, instituteId, now);
  const staff = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.instituteId, instituteId), inArray(users.role, ['admin', 'hod', 'faculty']), eq(users.status, 'active')));
  const list: NewNotification[] = [];
  for (const person of staff) {
    const role = person.role as 'admin' | 'hod' | 'faculty';
    const auth = { userId: person.id, role, instituteId };
    const scope = await resolveScope(db, auth);
    const report = await listStudentReport(db, auth, scope, { below: true, sort: 'percentage', page: 1, pageSize: SUMMARY_SIZE }, now);
    if (!report.term || report.total === 0) continue;
    list.push({
      instituteId,
      userId: person.id,
      ...weeklySummary({
        role,
        termId: report.term.id,
        termName: report.term.name,
        minimumPercent: report.minimumPercent,
        total: report.total,
        lowest: report.items.map((s) => ({
          fullName: s.student.fullName,
          rollNo: s.student.rollNo,
          className: s.student.unitPath.join(' › '),
          percentage: s.percentage,
        })),
      }),
    });
  }
  return list;
}
