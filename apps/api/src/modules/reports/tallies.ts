import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, offerings, sessionTallies, studentTallies } from '../../db/schema.js';

/**
 * Report totals are kept per offering and recounted when they go stale:
 * - a session finishes (closed by the teacher or by time), is re-opened or cancelled;
 * - a mark is changed by hand;
 * - a student moves to another class (trends are grouped by class).
 * Scans don't make anything stale: they only happen while a session is open, and open
 * sessions aren't counted until they finish.
 *
 * Recounting happens before every dashboard read (only the stale offerings, so it's
 * cheap) and in the background sweeper, so reports always match the records.
 */

/** Call in the same transaction as the change. */
export async function markOfferingsStale(tx: DbOrTx, offeringIds: string[]): Promise<void> {
  const ids = [...new Set(offeringIds)];
  if (ids.length === 0) return;
  await tx
    .update(offerings)
    .set({ talliesStale: true })
    .where(and(inArray(offerings.id, ids), eq(offerings.talliesStale, false)));
}

/** Offerings with records for these students (e.g. they changed class). */
export async function markStudentsStale(tx: DbOrTx, studentIds: string[]): Promise<void> {
  if (studentIds.length === 0) return;
  await tx.execute(sql`
    update ${offerings} set tallies_stale = true
    where not ${offerings.talliesStale} and ${offerings.id} in (
      select distinct ${studentTallies.offeringId} from ${studentTallies}
      where ${inArray(studentTallies.studentId, studentIds)}
    )`);
}

/** A session counts once it has finished. */
const finished = (now: Date) =>
  sql`${attendanceSessions.status} <> 'cancelled' and (${attendanceSessions.status} = 'closed' or ${attendanceSessions.closesAt} <= ${now})`;

/** Brings an institute's totals up to date before a report reads them. */
export async function ensureTallies(db: Db, instituteId: string, now: Date): Promise<void> {
  while ((await refreshTallies(db, instituteId, now)) === BATCH);
}

const BATCH = 500;

/**
 * Recounts up to `limit` stale offerings, of one institute or (instituteId null, from the
 * sweeper) of all. Concurrent callers wait for each other rather than recount the same
 * offerings. Returns how many offerings were recounted.
 */
export async function refreshTallies(db: Db, instituteId: string | null, now: Date, limit = BATCH): Promise<number> {
  const inInstitute = instituteId ? eq(offerings.instituteId, instituteId) : undefined;

  // Sessions past their closing time count as finished before the sweeper closes them.
  await db
    .update(offerings)
    .set({ talliesStale: true })
    .where(
      and(
        inInstitute,
        eq(offerings.talliesStale, false),
        inArray(
          offerings.id,
          db
            .select({ id: attendanceSessions.offeringId })
            .from(attendanceSessions)
            .where(and(eq(attendanceSessions.status, 'open'), lte(attendanceSessions.closesAt, now))),
        ),
      ),
    );

  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: offerings.id })
      .from(offerings)
      .where(and(inInstitute, eq(offerings.talliesStale, true)))
      .limit(limit)
      .for('update');
    if (stale.length === 0) return 0;
    const ids = stale.map((o) => o.id);
    const counts = sql`
      count(*) filter (where ${attendanceRecords.status} = 'present'),
      count(*) filter (where ${attendanceRecords.status} = 'absent'),
      count(*) filter (where ${attendanceRecords.status} = 'excused'),
      count(*)`;

    await tx.delete(studentTallies).where(inArray(studentTallies.offeringId, ids));
    await tx.execute(sql`
      insert into ${studentTallies} (offering_id, student_id, institute_id, present, absent, excused, total)
      select ${attendanceSessions.offeringId}, ${attendanceRecords.studentId}, ${attendanceRecords.instituteId}, ${counts}
      from ${attendanceRecords}
      join ${attendanceSessions} on ${attendanceSessions.id} = ${attendanceRecords.sessionId}
      where ${inArray(attendanceSessions.offeringId, ids)} and ${finished(now)}
      group by 1, 2, 3`);

    await tx.delete(sessionTallies).where(inArray(sessionTallies.offeringId, ids));
    await tx.execute(sql`
      insert into ${sessionTallies} (session_id, unit_id, offering_id, institute_id, started_at, present, absent, excused, total)
      select ${attendanceSessions.id}, students.unit_id, ${attendanceSessions.offeringId}, ${attendanceRecords.instituteId},
             ${attendanceSessions.startedAt}, ${counts}
      from ${attendanceRecords}
      join ${attendanceSessions} on ${attendanceSessions.id} = ${attendanceRecords.sessionId}
      join students on students.user_id = ${attendanceRecords.studentId}
      where ${inArray(attendanceSessions.offeringId, ids)} and ${finished(now)}
      group by 1, 2, 3, 4, 5`);

    await tx.update(offerings).set({ talliesStale: false }).where(inArray(offerings.id, ids));
    return ids.length;
  });
}
