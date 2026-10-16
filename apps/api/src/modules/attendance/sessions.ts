import { and, count, desc, eq, gt, gte, inArray, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import {
  attendanceRecords,
  attendanceSessions,
  offerings,
  SESSION_KINDS,
  students,
  subjects,
  terms,
  users,
} from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import type { Scope } from '../../lib/scope.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import {
  type Audience,
  findVisibleOffering,
  listAudienceStudents,
  loadAudience,
  validateAudience,
  visibilityCondition,
} from '../offerings/service.js';
import { loadUnitIndex } from '../structure/service.js';
import type { LiveHub, SessionCounts } from './live.js';
import { generateQrSecret, qrPayload, stepAt, stepEndsAt } from './qr.js';
import { getAttendanceSettings } from './settings.js';

type SessionRow = typeof attendanceSessions.$inferSelect;
type SessionKind = (typeof SESSION_KINDS)[number];
type EffectiveStatus = 'open' | 'closed' | 'cancelled';
type AttendanceStatus = 'present' | 'absent' | 'excused';

export type SessionDto = {
  id: string;
  kind: SessionKind;
  topic: string | null;
  status: EffectiveStatus;
  startedAt: string;
  closesAt: string;
  closedAt: string | null;
  cancelReason: string | null;
  offering: { id: string; subject: { id: string; code: string; name: string }; term: { id: string; name: string } };
  createdBy: { id: string; fullName: string };
  audience: Audience | null;
  counts: SessionCounts;
};

/** A session past its closing time counts as closed even before the sweeper updates it. */
export function effectiveStatus(row: Pick<SessionRow, 'status' | 'closesAt'>, now: Date): EffectiveStatus {
  return row.status === 'open' && row.closesAt <= now ? 'closed' : row.status;
}

const notInSession = (studentIds: string[]) =>
  badRequest('NOT_IN_SESSION', 'Some students are not on this session’s list', { studentIds });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function sessionCounts(db: DbOrTx, sessionIds: string[]): Promise<Map<string, SessionCounts>> {
  const result = new Map<string, SessionCounts>(
    sessionIds.map((id) => [id, { present: 0, absent: 0, excused: 0, total: 0 }]),
  );
  if (sessionIds.length === 0) return result;
  const rows = await db
    .select({ sessionId: attendanceRecords.sessionId, status: attendanceRecords.status, n: count() })
    .from(attendanceRecords)
    .where(inArray(attendanceRecords.sessionId, sessionIds))
    .groupBy(attendanceRecords.sessionId, attendanceRecords.status);
  for (const r of rows) {
    const c = result.get(r.sessionId)!;
    c[r.status] = r.n;
    c.total += r.n;
  }
  return result;
}

function selectSessions(db: DbOrTx) {
  return db
    .select({
      session: attendanceSessions,
      subject: { id: subjects.id, code: subjects.code, name: subjects.name },
      term: { id: terms.id, name: terms.name },
      createdBy: { id: users.id, fullName: users.fullName },
    })
    .from(attendanceSessions)
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(terms, eq(terms.id, offerings.termId))
    .innerJoin(users, eq(users.id, attendanceSessions.createdBy));
}

type SessionJoinRow = Awaited<ReturnType<typeof selectSessions>>[number];

async function toSessionDtos(db: DbOrTx, rows: SessionJoinRow[], now: Date): Promise<SessionDto[]> {
  const counts = await sessionCounts(
    db,
    rows.map((r) => r.session.id),
  );
  return rows.map(({ session: s, subject, term, createdBy }) => ({
    id: s.id,
    kind: s.kind,
    topic: s.topic,
    status: effectiveStatus(s, now),
    startedAt: s.startedAt.toISOString(),
    closesAt: s.closesAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? (effectiveStatus(s, now) === 'closed' ? s.closesAt.toISOString() : null),
    cancelReason: s.cancelReason,
    offering: { id: s.offeringId, subject, term },
    createdBy,
    audience: s.audience,
    counts: counts.get(s.id)!,
  }));
}

/**
 * A session the caller may run and edit: admins, the offering's teachers, and HODs
 * whose department the offering is taught to. Anyone else gets "not found".
 */
async function findManagedSession(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, sessionId: string) {
  const [row] = await db
    .select({ session: attendanceSessions })
    .from(attendanceSessions)
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .where(
      and(
        eq(attendanceSessions.id, sessionId),
        eq(attendanceSessions.instituteId, auth.instituteId),
        visibilityCondition(auth, scope),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Session');
  return row.session;
}

export async function getSession(
  db: DbOrTx,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  now: Date,
): Promise<SessionDto> {
  await findManagedSession(db, auth, scope, sessionId);
  const rows = await selectSessions(db).where(eq(attendanceSessions.id, sessionId));
  const [dto] = await toSessionDtos(db, rows, now);
  return dto!;
}

export type ListSessionsQuery = {
  page: number;
  pageSize: number;
  offeringId?: string;
  status?: EffectiveStatus;
  /** Only sessions the caller started. */
  mine?: boolean;
  from?: string;
  to?: string;
};

export async function listSessions(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  query: ListSessionsQuery,
  now: Date,
) {
  const conditions: (SQL | undefined)[] = [
    eq(attendanceSessions.instituteId, auth.instituteId),
    visibilityCondition(auth, scope),
  ];
  if (query.offeringId) conditions.push(eq(attendanceSessions.offeringId, query.offeringId));
  if (query.mine) conditions.push(eq(attendanceSessions.createdBy, auth.userId));
  if (query.from) conditions.push(gte(attendanceSessions.startedAt, new Date(query.from)));
  if (query.to) conditions.push(lt(attendanceSessions.startedAt, new Date(query.to)));
  if (query.status === 'open') {
    conditions.push(eq(attendanceSessions.status, 'open'), gt(attendanceSessions.closesAt, now));
  } else if (query.status === 'closed') {
    conditions.push(
      or(
        eq(attendanceSessions.status, 'closed'),
        and(eq(attendanceSessions.status, 'open'), lte(attendanceSessions.closesAt, now)),
      ),
    );
  } else if (query.status === 'cancelled') {
    conditions.push(eq(attendanceSessions.status, 'cancelled'));
  }
  const where = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    selectSessions(db)
      .where(where)
      .orderBy(desc(attendanceSessions.startedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(attendanceSessions)
      .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
      .where(where),
  ]);
  return { items: await toSessionDtos(db, rows, now), total: totalRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
}

export type RecordDto = {
  studentId: string;
  username: string;
  fullName: string;
  rollNo: string | null;
  unitPath: string[];
  status: AttendanceStatus;
  method: 'qr' | 'manual' | null;
  markedAt: string | null;
  reason: string | null;
};

/** Everyone expected at the session, in class then roll-number order. */
export async function listRecords(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
): Promise<RecordDto[]> {
  await findManagedSession(db, auth, scope, sessionId);
  const rows = await db
    .select({
      record: attendanceRecords,
      username: users.username,
      fullName: users.fullName,
      rollNo: students.rollNo,
      unitId: students.unitId,
    })
    .from(attendanceRecords)
    .innerJoin(students, eq(students.userId, attendanceRecords.studentId))
    .innerJoin(users, eq(users.id, attendanceRecords.studentId))
    .where(eq(attendanceRecords.sessionId, sessionId));
  const index = await loadUnitIndex(db, auth.instituteId);
  const collator = new Intl.Collator(undefined, { numeric: true });
  return rows
    .map(({ record: r, username, fullName, rollNo, unitId }) => ({
      studentId: r.studentId,
      username,
      fullName,
      rollNo,
      unitPath: index.pathNames(unitId),
      status: r.status,
      method: r.method,
      markedAt: r.markedAt?.toISOString() ?? null,
      reason: r.reason,
    }))
    .sort(
      (a, b) =>
        collator.compare(a.unitPath.join('/'), b.unitPath.join('/')) ||
        collator.compare(a.rollNo ?? '', b.rollNo ?? '') ||
        collator.compare(a.username, b.username),
    );
}

// ---------------------------------------------------------------------------
// QR for the faculty screen
// ---------------------------------------------------------------------------

export type QrConfig = {
  sessionId: string;
  /** HMAC key for generating codes on the faculty screen. Never show it to students. */
  secret: string;
  rotationSeconds: number;
  graceSeconds: number;
  /** Server clock, to correct the screen's clock. */
  serverTime: string;
  closesAt: string;
};

async function findOpenManagedSession(db: DbOrTx, auth: InstituteAuthContext, scope: Scope, sessionId: string, now: Date) {
  const session = await findManagedSession(db, auth, scope, sessionId);
  const status = effectiveStatus(session, now);
  if (status !== 'open') throw conflict(`SESSION_${status.toUpperCase()}`, `This session is ${status}`);
  return session;
}

export async function getQrConfig(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  now: Date,
): Promise<QrConfig> {
  const s = await findOpenManagedSession(db, auth, scope, sessionId, now);
  return {
    sessionId: s.id,
    secret: s.qrSecret,
    rotationSeconds: s.qrRotationSeconds,
    graceSeconds: s.qrGraceSeconds,
    serverTime: now.toISOString(),
    closesAt: s.closesAt.toISOString(),
  };
}

/** The code to display right now, for screens that don't generate codes themselves. */
export async function getCurrentQr(db: Db, auth: InstituteAuthContext, scope: Scope, sessionId: string, now: Date) {
  const s = await findOpenManagedSession(db, auth, scope, sessionId, now);
  const step = stepAt(now.getTime(), s.qrRotationSeconds);
  return {
    payload: qrPayload(s.id, s.qrSecret, step),
    step,
    nextChangeAt: new Date(stepEndsAt(step, s.qrRotationSeconds)).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type StartSessionInput = {
  offeringId: string;
  kind?: SessionKind;
  topic?: string;
  /** How long QR scanning stays open; defaults to the institute setting. */
  scanMinutes?: number;
  /** Narrow the offering's audience, e.g. to one lab batch. */
  audience?: Audience;
};

/** Starts a session and snapshots who is expected, all marked absent until they scan. */
export async function startSession(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  input: StartSessionInput,
  now: Date,
  ip?: string,
): Promise<SessionDto> {
  const offering = await findVisibleOffering(db, auth, scope, input.offeringId);
  const settings = await getAttendanceSettings(db, auth.instituteId);

  let roster = await listAudienceStudents(db, auth.instituteId, await loadAudience(db, offering.id));
  let audience: Audience | null = null;
  if (input.audience) {
    audience = await validateAudience(db, auth.instituteId, { all: true }, input.audience);
    const narrowed = new Set((await listAudienceStudents(db, auth.instituteId, audience)).map((s) => s.id));
    roster = roster.filter((s) => narrowed.has(s.id));
  }
  if (roster.length === 0) {
    throw badRequest('EMPTY_ROSTER', 'No active students are expected at this session; check the class or batch');
  }

  const scanMinutes = input.scanMinutes ?? settings.defaultScanMinutes;
  const sessionId = await db
    .transaction(async (tx) => {
      // A previous session of this teacher that ran out of time but wasn't swept yet
      // must not block the new one.
      await tx
        .update(attendanceSessions)
        .set({ status: 'closed', closedAt: sql`${attendanceSessions.closesAt}` })
        .where(
          and(
            eq(attendanceSessions.createdBy, auth.userId),
            eq(attendanceSessions.status, 'open'),
            lte(attendanceSessions.closesAt, now),
          ),
        );

      const [session] = await tx
        .insert(attendanceSessions)
        .values({
          instituteId: auth.instituteId,
          offeringId: offering.id,
          createdBy: auth.userId,
          kind: input.kind ?? 'lecture',
          topic: input.topic ?? null,
          audience,
          startedAt: now,
          closesAt: new Date(now.getTime() + scanMinutes * 60_000),
          qrSecret: generateQrSecret(),
          qrRotationSeconds: settings.qrRotationSeconds,
          qrGraceSeconds: settings.qrGraceSeconds,
        })
        .returning({ id: attendanceSessions.id });

      for (let i = 0; i < roster.length; i += 1000) {
        await tx.insert(attendanceRecords).values(
          roster.slice(i, i + 1000).map((s) => ({
            sessionId: session!.id,
            studentId: s.id,
            instituteId: auth.instituteId,
          })),
        );
      }
      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: 'session.started',
        entityType: 'attendance_session',
        entityId: session!.id,
        data: { offeringId: offering.id, students: roster.length, scanMinutes, audience },
        ip,
      });
      return session!.id;
    })
    .catch(async (err) => {
      if (!isUniqueViolation(err, 'attendance_sessions_one_open_per_creator')) throw err;
      const [open] = await db
        .select({ id: attendanceSessions.id })
        .from(attendanceSessions)
        .where(and(eq(attendanceSessions.createdBy, auth.userId), eq(attendanceSessions.status, 'open')))
        .limit(1);
      throw new AppError(409, 'SESSION_ALREADY_OPEN', 'You already have a session open; close it first', {
        sessionId: open?.id,
      });
    });

  return getSession(db, auth, scope, sessionId, now);
}

async function publishSession(db: DbOrTx, hub: LiveHub, s: SessionRow, now: Date) {
  await hub.publish(db, {
    type: 'session',
    sessionId: s.id,
    status: effectiveStatus(s, now),
    closesAt: s.closesAt.toISOString(),
  });
}

export async function closeSession(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  now: Date,
  ip?: string,
): Promise<SessionDto> {
  await db.transaction(async (tx) => {
    const s = await findManagedSession(tx, auth, scope, sessionId);
    if (s.status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This session was cancelled');
    if (s.status === 'closed') return;
    const closedAt = s.closesAt < now ? s.closesAt : now;
    const [updated] = await tx
      .update(attendanceSessions)
      .set({ status: 'closed', closedAt, closesAt: closedAt })
      .where(eq(attendanceSessions.id, sessionId))
      .returning();
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'session.closed',
      entityType: 'attendance_session',
      entityId: sessionId,
      ip,
    });
    await publishSession(tx, hub, updated!, now);
  });
  return getSession(db, auth, scope, sessionId, now);
}

/** Keeps scanning open longer, or re-opens a closed session (e.g. the class ran late). */
export async function extendSession(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  minutes: number,
  now: Date,
  ip?: string,
): Promise<SessionDto> {
  await db
    .transaction(async (tx) => {
      const s = await findManagedSession(tx, auth, scope, sessionId);
      if (s.status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This session was cancelled');
      const base = effectiveStatus(s, now) === 'open' ? s.closesAt : now;
      const [updated] = await tx
        .update(attendanceSessions)
        .set({ status: 'open', closedAt: null, closesAt: new Date(base.getTime() + minutes * 60_000) })
        .where(eq(attendanceSessions.id, sessionId))
        .returning();
      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: 'session.extended',
        entityType: 'attendance_session',
        entityId: sessionId,
        data: { minutes, closesAt: updated!.closesAt.toISOString() },
        ip,
      });
      await publishSession(tx, hub, updated!, now);
    })
    .catch((err) => {
      if (isUniqueViolation(err, 'attendance_sessions_one_open_per_creator')) {
        throw conflict('SESSION_ALREADY_OPEN', 'The teacher who started this session has another one open');
      }
      throw err;
    });
  return getSession(db, auth, scope, sessionId, now);
}

/** Cancelled sessions keep their records for the audit trail but are left out of reports. */
export async function cancelSession(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  reason: string,
  now: Date,
  ip?: string,
): Promise<SessionDto> {
  await db.transaction(async (tx) => {
    const s = await findManagedSession(tx, auth, scope, sessionId);
    if (s.status === 'cancelled') return;
    const [updated] = await tx
      .update(attendanceSessions)
      .set({ status: 'cancelled', cancelReason: reason, closedAt: s.closedAt ?? now })
      .where(eq(attendanceSessions.id, sessionId))
      .returning();
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'session.cancelled',
      entityType: 'attendance_session',
      entityId: sessionId,
      data: { reason },
      ip,
    });
    await publishSession(tx, hub, updated!, now);
  });
  return getSession(db, auth, scope, sessionId, now);
}

/** Closes every session whose scanning time is up. Safe to run on several instances at once. */
export async function closeExpiredSessions(db: Db, hub: LiveHub, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const closed = await tx
      .update(attendanceSessions)
      .set({ status: 'closed', closedAt: sql`${attendanceSessions.closesAt}` })
      .where(and(eq(attendanceSessions.status, 'open'), lte(attendanceSessions.closesAt, now)))
      .returning();
    for (const s of closed) await publishSession(tx, hub, s, now);
    return closed.length;
  });
}

// ---------------------------------------------------------------------------
// Manual marking
// ---------------------------------------------------------------------------

/**
 * Teacher/admin sets students' status by hand (no phone, medical leave, caught
 * proxying…). A reason is mandatory and every change is audited. A student marked by
 * hand cannot override it by scanning.
 */
export async function markRecords(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  sessionId: string,
  input: { studentIds: string[]; status: AttendanceStatus; reason: string },
  now: Date,
  ip?: string,
): Promise<{ updated: number; counts: SessionCounts }> {
  const studentIds = [...new Set(input.studentIds)];
  return db.transaction(async (tx) => {
    const s = await findManagedSession(tx, auth, scope, sessionId);
    if (s.status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This session was cancelled');

    const before = await tx
      .select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, fullName: users.fullName, rollNo: students.rollNo })
      .from(attendanceRecords)
      .innerJoin(users, eq(users.id, attendanceRecords.studentId))
      .innerJoin(students, eq(students.userId, attendanceRecords.studentId))
      .where(and(eq(attendanceRecords.sessionId, sessionId), inArray(attendanceRecords.studentId, studentIds)));
    if (before.length !== studentIds.length) {
      const found = new Set(before.map((r) => r.studentId));
      throw notInSession(studentIds.filter((id) => !found.has(id)));
    }

    await tx
      .update(attendanceRecords)
      .set({ status: input.status, method: 'manual', markedAt: now, markedBy: auth.userId, reason: input.reason, qrStep: null, ip: null })
      .where(and(eq(attendanceRecords.sessionId, sessionId), inArray(attendanceRecords.studentId, studentIds)));

    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'attendance.marked_manually',
      entityType: 'attendance_session',
      entityId: sessionId,
      data: {
        status: input.status,
        reason: input.reason,
        changes: before.map((r) => ({ studentId: r.studentId, from: r.status, to: input.status })),
      },
      ip,
    });

    const counts = (await sessionCounts(tx, [sessionId])).get(sessionId)!;
    for (const r of before) {
      await hub.publish(tx, {
        type: 'marked',
        sessionId,
        student: { id: r.studentId, fullName: r.fullName, rollNo: r.rollNo },
        status: input.status,
        method: 'manual',
        counts,
      });
    }
    return { updated: before.length, counts };
  });
}
