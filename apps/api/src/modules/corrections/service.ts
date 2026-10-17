import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, DbOrTx } from '../../db/client.js';
import {
  attendanceCorrections,
  attendanceRecords,
  attendanceSessions,
  CORRECTION_STATUSES,
  offerings,
  students,
  subjects,
  users,
} from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import type { Scope } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import type { LiveHub } from '../attendance/live.js';
import { actorName, applyMarks, classRef, effectiveStatus } from '../attendance/sessions.js';
import { getAttendanceSettings } from '../attendance/settings.js';
import { correctionRejected, correctionApproved } from '../notifications/messages.js';
import { notify } from '../notifications/service.js';
import { visibilityCondition } from '../offerings/service.js';
import { loadUnitIndex } from '../structure/service.js';

type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];
type AttendanceStatus = 'present' | 'absent' | 'excused';
export type RequestableStatus = 'present' | 'excused';

const DAY_MS = 24 * 3600_000;

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

/** What a student sees about their latest request for a class. */
export type MyCorrection = {
  id: string;
  status: CorrectionStatus;
  requestedStatus: RequestableStatus;
  reason: string;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

/** Marks a student may ask to change to: absent → present or excused; excused → present. */
export const requestableFrom = (status: AttendanceStatus): RequestableStatus[] =>
  status === 'absent' ? ['present', 'excused'] : status === 'excused' ? ['present'] : [];

/**
 * Whether the student can ask about this class now: it has finished, it's within the
 * institute's window, their mark can go up, and they haven't asked already (asking
 * again is allowed only after withdrawing).
 */
export function canRequestCorrection(
  record: { status: AttendanceStatus; startedAt: Date; open: boolean },
  latest: { status: CorrectionStatus } | undefined,
  windowDays: number,
  now: Date,
): boolean {
  return (
    windowDays > 0 &&
    !record.open &&
    requestableFrom(record.status).length > 0 &&
    now.getTime() - record.startedAt.getTime() <= windowDays * DAY_MS &&
    (!latest || latest.status === 'withdrawn')
  );
}

/** The student's latest request per session, for the given sessions. */
export async function latestCorrections(db: DbOrTx, studentId: string, sessionIds: string[]): Promise<Map<string, MyCorrection>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([attendanceCorrections.sessionId])
    .from(attendanceCorrections)
    .where(and(eq(attendanceCorrections.studentId, studentId), inArray(attendanceCorrections.sessionId, sessionIds)))
    .orderBy(attendanceCorrections.sessionId, desc(attendanceCorrections.createdAt));
  return new Map(rows.map((c) => [c.sessionId, toMyCorrection(c)]));
}

const toMyCorrection = (c: typeof attendanceCorrections.$inferSelect): MyCorrection => ({
  id: c.id,
  status: c.status,
  requestedStatus: c.requestedStatus as RequestableStatus,
  reason: c.reason,
  reviewNote: c.reviewNote,
  createdAt: c.createdAt.toISOString(),
  reviewedAt: c.reviewedAt?.toISOString() ?? null,
});

/** A student asks for their mark in a finished class to be changed. */
export async function requestCorrection(
  db: Db,
  auth: InstituteAuthContext,
  input: { sessionId: string; requestedStatus: RequestableStatus; reason: string },
  now: Date,
  ip?: string,
): Promise<MyCorrection> {
  const settings = await getAttendanceSettings(db, auth.instituteId);
  if (settings.correctionWindowDays === 0) {
    throw new AppError(403, 'CORRECTIONS_OFF', 'Your institute doesn’t take correction requests in the app. Please speak to your teacher.');
  }
  return db
    .transaction(async (tx) => {
      const [row] = await tx
        .select({ record: attendanceRecords, session: attendanceSessions })
        .from(attendanceRecords)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
        .where(
          and(
            eq(attendanceRecords.sessionId, input.sessionId),
            eq(attendanceRecords.studentId, auth.userId),
            eq(attendanceRecords.instituteId, auth.instituteId),
          ),
        )
        .for('update', { of: attendanceRecords })
        .limit(1);
      if (!row) throw notFound('Class');
      const { record, session } = row;
      const status = effectiveStatus(session, now);
      if (status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This class was cancelled, so it doesn’t count.');
      if (status === 'open') throw conflict('SESSION_STILL_OPEN', 'This class is still taking attendance. Scan the QR code instead.');
      if (!requestableFrom(record.status).includes(input.requestedStatus)) {
        throw conflict('NOTHING_TO_CORRECT', `You’re already marked ${record.status} for this class.`);
      }
      if (now.getTime() - session.startedAt.getTime() > settings.correctionWindowDays * DAY_MS) {
        const days = settings.correctionWindowDays;
        throw conflict('CORRECTION_TOO_LATE', `Requests must be made within ${days} day${days === 1 ? '' : 's'} of the class. Please speak to your teacher.`);
      }
      const latest = (await latestCorrections(tx, auth.userId, [session.id])).get(session.id);
      if (latest?.status === 'pending') throw conflict('CORRECTION_PENDING', 'You’ve already asked about this class. Wait for your teacher to reply.');
      if (latest && latest.status !== 'withdrawn') {
        throw conflict('CORRECTION_DECIDED', 'Your request for this class has already been answered. Please speak to your teacher.');
      }

      const [created] = await tx
        .insert(attendanceCorrections)
        .values({
          instituteId: auth.instituteId,
          sessionId: session.id,
          studentId: auth.userId,
          requestedStatus: input.requestedStatus,
          previousStatus: record.status,
          reason: input.reason,
        })
        .returning();
      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: 'correction.requested',
        entityType: 'correction',
        entityId: created!.id,
        data: { sessionId: session.id, from: record.status, to: input.requestedStatus, reason: input.reason },
        ip,
      });
      return toMyCorrection(created!);
    })
    .catch((err) => {
      if (isUniqueViolation(err, 'attendance_corrections_one_pending')) {
        throw conflict('CORRECTION_PENDING', 'You’ve already asked about this class. Wait for your teacher to reply.');
      }
      throw err;
    });
}

/** The student takes back a request that hasn't been answered yet. */
export async function withdrawCorrection(db: Db, auth: InstituteAuthContext, id: string, now: Date, ip?: string): Promise<MyCorrection> {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(attendanceCorrections)
      .where(and(eq(attendanceCorrections.id, id), eq(attendanceCorrections.studentId, auth.userId)))
      .for('update')
      .limit(1);
    if (!c) throw notFound('Request');
    if (c.status !== 'pending') throw conflict('CORRECTION_DECIDED', `This request was already ${c.status}.`);
    const [updated] = await tx
      .update(attendanceCorrections)
      .set({ status: 'withdrawn', reviewedAt: now })
      .where(eq(attendanceCorrections.id, id))
      .returning();
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'correction.withdrawn',
      entityType: 'correction',
      entityId: id,
      data: { sessionId: c.sessionId },
      ip,
    });
    return toMyCorrection(updated!);
  });
}

// ---------------------------------------------------------------------------
// Staff: the review queue
// ---------------------------------------------------------------------------

export type CorrectionDto = {
  id: string;
  status: CorrectionStatus;
  requestedStatus: RequestableStatus;
  previousStatus: AttendanceStatus;
  /** The student's mark now (it may have changed since they asked). */
  currentStatus: AttendanceStatus;
  reason: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewer: { id: string; fullName: string } | null;
  student: { id: string; username: string; fullName: string; rollNo: string | null; unitPath: string[] };
  session: {
    id: string;
    startedAt: string;
    kind: string;
    topic: string | null;
    status: 'open' | 'closed' | 'cancelled';
    subject: { code: string; name: string };
    teacher: string;
  };
};

const studentUser = alias(users, 'student_user');
const reviewer = alias(users, 'reviewer');
const teacher = alias(users, 'teacher');

function selectCorrections(db: DbOrTx) {
  return db
    .select({
      c: attendanceCorrections,
      currentStatus: attendanceRecords.status,
      session: attendanceSessions,
      subject: { code: subjects.code, name: subjects.name },
      student: { id: studentUser.id, username: studentUser.username, fullName: studentUser.fullName },
      rollNo: students.rollNo,
      unitId: students.unitId,
      reviewer: { id: reviewer.id, fullName: reviewer.fullName },
      teacher: teacher.fullName,
    })
    .from(attendanceCorrections)
    .innerJoin(
      attendanceRecords,
      and(eq(attendanceRecords.sessionId, attendanceCorrections.sessionId), eq(attendanceRecords.studentId, attendanceCorrections.studentId)),
    )
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(studentUser, eq(studentUser.id, attendanceCorrections.studentId))
    .innerJoin(students, eq(students.userId, attendanceCorrections.studentId))
    .innerJoin(teacher, eq(teacher.id, attendanceSessions.createdBy))
    .leftJoin(reviewer, eq(reviewer.id, attendanceCorrections.reviewedBy));
}

type CorrectionRow = Awaited<ReturnType<typeof selectCorrections>>[number];

async function toDtos(db: DbOrTx, instituteId: string, rows: CorrectionRow[], now: Date): Promise<CorrectionDto[]> {
  const index = await loadUnitIndex(db, instituteId);
  return rows.map((r) => ({
    id: r.c.id,
    status: r.c.status,
    requestedStatus: r.c.requestedStatus as RequestableStatus,
    previousStatus: r.c.previousStatus,
    currentStatus: r.currentStatus,
    reason: r.c.reason,
    createdAt: r.c.createdAt.toISOString(),
    reviewedAt: r.c.reviewedAt?.toISOString() ?? null,
    reviewNote: r.c.reviewNote,
    reviewer: r.reviewer?.id ? { id: r.reviewer.id, fullName: r.reviewer.fullName } : null,
    student: { ...r.student, rollNo: r.rollNo, unitPath: index.pathNames(r.unitId) },
    session: {
      id: r.session.id,
      startedAt: r.session.startedAt.toISOString(),
      kind: r.session.kind,
      topic: r.session.topic,
      status: effectiveStatus(r.session, now),
      subject: r.subject,
      teacher: r.teacher,
    },
  }));
}

/** Requests the caller may answer: for classes they teach, their department's (HOD), or all (admin). */
function managedWhere(auth: InstituteAuthContext, scope: Scope): SQL {
  return and(eq(attendanceCorrections.instituteId, auth.instituteId), visibilityCondition(auth, scope))!;
}

export type ListCorrectionsQuery = {
  status: CorrectionStatus;
  sessionId?: string;
  q?: string;
  page: number;
  pageSize: number;
};

/** Waiting requests oldest first (a queue); answered ones newest first. */
export async function listCorrections(db: Db, auth: InstituteAuthContext, scope: Scope, query: ListCorrectionsQuery, now: Date) {
  const conditions: (SQL | undefined)[] = [managedWhere(auth, scope), eq(attendanceCorrections.status, query.status)];
  if (query.sessionId) conditions.push(eq(attendanceCorrections.sessionId, query.sessionId));
  if (query.q) {
    const p = containsPattern(query.q);
    conditions.push(or(ilike(studentUser.fullName, p), ilike(studentUser.username, p), ilike(students.rollNo, p), ilike(subjects.code, p)));
  }
  const where = and(...conditions);
  const order = query.status === 'pending' ? asc(attendanceCorrections.createdAt) : desc(attendanceCorrections.reviewedAt);
  const [rows, [total]] = await Promise.all([
    selectCorrections(db)
      .where(where)
      .orderBy(order, asc(attendanceCorrections.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ n: count() })
      .from(attendanceCorrections)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
      .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
      .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
      .innerJoin(studentUser, eq(studentUser.id, attendanceCorrections.studentId))
      .innerJoin(students, eq(students.userId, attendanceCorrections.studentId))
      .where(where),
  ]);
  return { items: await toDtos(db, auth.instituteId, rows, now), total: total?.n ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Waiting requests the caller can answer, for the menu badge. */
export async function countPendingCorrections(db: Db, auth: InstituteAuthContext, scope: Scope): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(attendanceCorrections)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .where(and(managedWhere(auth, scope), eq(attendanceCorrections.status, 'pending')));
  return row?.n ?? 0;
}

/** Locks a pending request the caller may answer, with its session. */
async function findPending(tx: DbOrTx, auth: InstituteAuthContext, scope: Scope, id: string) {
  const [row] = await tx
    .select({ c: attendanceCorrections, session: attendanceSessions })
    .from(attendanceCorrections)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .where(and(eq(attendanceCorrections.id, id), managedWhere(auth, scope)))
    .for('update', { of: attendanceCorrections })
    .limit(1);
  if (!row) throw notFound('Request');
  if (row.c.status !== 'pending') throw conflict('CORRECTION_DECIDED', `This request was already ${row.c.status}.`);
  return row;
}

async function getCorrection(db: DbOrTx, auth: InstituteAuthContext, id: string, now: Date): Promise<CorrectionDto> {
  const rows = await selectCorrections(db).where(eq(attendanceCorrections.id, id));
  const [dto] = await toDtos(db, auth.instituteId, rows, now);
  return dto!;
}

/** Changes the student's mark to what they asked for, and tells them. */
export async function approveCorrection(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  scope: Scope,
  id: string,
  note: string | undefined,
  now: Date,
  ip?: string,
): Promise<CorrectionDto> {
  await db.transaction(async (tx) => {
    const { c, session } = await findPending(tx, auth, scope, id);
    if (session.status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This class was cancelled');
    const reason = `Correction request: ${c.reason}`;
    await applyMarks(tx, hub, auth, session, { studentIds: [c.studentId], status: c.requestedStatus, reason }, now, ip, {
      id: c.id,
      note: note ?? null,
    });
    await tx
      .update(attendanceCorrections)
      .set({ status: 'approved', reviewedBy: auth.userId, reviewedAt: now, reviewNote: note ?? null })
      .where(eq(attendanceCorrections.id, id));
    const message = correctionApproved(await classRef(tx, session), c.id, await actorName(tx, auth.userId), c.requestedStatus, note);
    await notify(tx, [{ instituteId: auth.instituteId, userId: c.studentId, ...message }], now);
  });
  return getCorrection(db, auth, id, now);
}

/** Keeps the mark as it is; the note tells the student why. */
export async function rejectCorrection(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  id: string,
  note: string,
  now: Date,
  ip?: string,
): Promise<CorrectionDto> {
  await db.transaction(async (tx) => {
    const { c, session } = await findPending(tx, auth, scope, id);
    await tx
      .update(attendanceCorrections)
      .set({ status: 'rejected', reviewedBy: auth.userId, reviewedAt: now, reviewNote: note })
      .where(eq(attendanceCorrections.id, id));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'correction.rejected',
      entityType: 'correction',
      entityId: id,
      data: { sessionId: c.sessionId, studentId: c.studentId, to: c.requestedStatus, note },
      ip,
    });
    const message = correctionRejected(await classRef(tx, session), c.id, await actorName(tx, auth.userId), note);
    await notify(tx, [{ instituteId: auth.instituteId, userId: c.studentId, ...message }], now);
  });
  return getCorrection(db, auth, id, now);
}
