import { and, asc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, offerings, students, subjects, users } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { effectiveStatus, sessionCounts } from '../attendance/sessions.js';
import { type SessionRef, sessionRef, type StudentRef } from '../webhooks/events.js';

/**
 * Change feeds: "everything that changed since my last visit", for systems that sync
 * by polling. Rows come in the order they last changed; the response's cursor is passed
 * back as `after` next time. A row appears again whenever it changes again.
 *
 * Changes are held back for half a minute, so a change still being saved when the feed
 * is read can't be skipped over: the feed is always complete up to its cursor.
 */
export const FEED_LAG_MS = 30_000;

type Cursor = [updatedAt: string, ...ids: string[]];

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string, ids: number): Cursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(value) &&
      value.length === ids + 1 &&
      value.every((v) => typeof v === 'string') &&
      !Number.isNaN(Date.parse(value[0] as string)) &&
      value.slice(1).every((v: string) => /^[0-9a-f-]{36}$/.test(v))
    ) {
      return value as Cursor;
    }
  } catch {
    // reported below
  }
  throw badRequest('CURSOR_INVALID', 'The cursor is not one this API returned');
}

export type FeedQuery = { after?: string; since?: string; limit: number };

/** Rows after the cursor: (updated_at, ids…) compared as a tuple, which the change indexes serve. */
function afterCursor(raw: string, updatedAt: SQL, ids: SQL[]): SQL {
  const [ts, ...rest] = decodeCursor(raw, ids.length);
  return sql`(${updatedAt}, ${sql.join(ids, sql`, `)}) > (${ts}::timestamptz, ${sql.join(
    rest.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export type AttendanceChange = {
  session: SessionRef;
  student: StudentRef;
  status: 'present' | 'absent' | 'excused';
  method: 'qr' | 'manual' | null;
  markedAt: string | null;
  reason: string | null;
  updatedAt: string;
};

/** Students' marks, oldest change first. */
export async function attendanceFeed(db: Db, instituteId: string, query: FeedQuery, now: Date) {
  const r = attendanceRecords;
  const cursorTs = sql<string>`${r.updatedAt}::text`;
  const start = query.after
    ? afterCursor(query.after, sql`${r.updatedAt}`, [sql`${r.sessionId}`, sql`${r.studentId}`])
    : query.since
      ? gte(r.updatedAt, new Date(query.since))
      : undefined;
  const rows = await db
    .select({
      record: r,
      cursorTs,
      session: attendanceSessions,
      subject: { code: subjects.code, name: subjects.name },
      student: { id: users.id, username: users.username, fullName: users.fullName, rollNo: students.rollNo },
    })
    .from(r)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, r.sessionId))
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(users, eq(users.id, r.studentId))
    .innerJoin(students, eq(students.userId, r.studentId))
    .where(and(eq(r.instituteId, instituteId), lte(r.updatedAt, new Date(now.getTime() - FEED_LAG_MS)), start))
    .orderBy(asc(r.updatedAt), asc(r.sessionId), asc(r.studentId))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(
      ({ record, session, subject, student }): AttendanceChange => ({
        session: sessionRef(session, subject, effectiveStatus(session, now)),
        student,
        status: record.status,
        method: record.method,
        markedAt: record.markedAt?.toISOString() ?? null,
        reason: record.reason,
        updatedAt: record.updatedAt.toISOString(),
      }),
    ),
    cursor: last ? encodeCursor([last.cursorTs, last.record.sessionId, last.record.studentId]) : (query.after ?? null),
    hasMore: rows.length > query.limit,
  };
}

/** Sessions, oldest change first: started, closed (by the teacher or by time), re-opened, cancelled. */
export async function sessionFeed(db: Db, instituteId: string, query: FeedQuery, now: Date) {
  const s = attendanceSessions;
  const cursorTs = sql<string>`${s.updatedAt}::text`;
  const start = query.after
    ? afterCursor(query.after, sql`${s.updatedAt}`, [sql`${s.id}`])
    : query.since
      ? gte(s.updatedAt, new Date(query.since))
      : undefined;
  const rows = await db
    .select({ session: s, cursorTs, subject: { code: subjects.code, name: subjects.name }, startedBy: { id: users.id, fullName: users.fullName } })
    .from(s)
    .innerJoin(offerings, eq(offerings.id, s.offeringId))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(users, eq(users.id, s.createdBy))
    .where(and(eq(s.instituteId, instituteId), lte(s.updatedAt, new Date(now.getTime() - FEED_LAG_MS)), start))
    .orderBy(asc(s.updatedAt), asc(s.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const counts = await sessionCounts(
    db,
    page.map((p) => p.session.id),
  );
  const last = page.at(-1);
  return {
    items: page.map(({ session, subject, startedBy }) => {
      const status = effectiveStatus(session, now);
      return {
        ...sessionRef(session, subject, status),
        closedAt: session.closedAt?.toISOString() ?? (status === 'closed' ? session.closesAt.toISOString() : null),
        cancelReason: session.cancelReason,
        counts: counts.get(session.id)!,
        startedBy,
        updatedAt: session.updatedAt.toISOString(),
      };
    }),
    cursor: last ? encodeCursor([last.cursorTs, last.session.id]) : (query.after ?? null),
    hasMore: rows.length > query.limit,
  };
}
