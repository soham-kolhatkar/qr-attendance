import { and, eq, ne, or, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, institutes, offerings, students, subjects, users } from '../../db/schema.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { verifyScanDevice } from '../devices/service.js';
import type { LiveHub } from './live.js';
import { isQrMacValid, parseQrPayload, qrFreshness } from './qr.js';
import { effectiveStatus, sessionCounts } from './sessions.js';
import { ATTENDANCE_DEFAULTS } from './settings.js';

export type ScanResult = {
  status: 'present';
  /** True if the student had already been marked present by an earlier scan. */
  alreadyMarked: boolean;
  markedAt: string;
  session: { id: string; kind: string; startedAt: string; subject: { code: string; name: string } };
};

const invalidQr = () => badRequest('QR_INVALID', 'This is not a valid attendance QR code for your institute');

export type ScanInput = {
  qr: string;
  /** The linked phone's signature over the scan (see scanSigningMessage). */
  device?: { id: string; signature: string };
};

/**
 * Verifies a scanned code and marks the student present. Checks, in order:
 * the code's structure and signature (before revealing anything about the session),
 * the session is open, the code is fresh, the scan was signed by the student's linked
 * phone, and the student is on the session's list.
 * Scanning again is harmless. A status set by hand by the teacher is never overridden.
 */
export async function scanQr(
  db: Db,
  hub: LiveHub,
  auth: InstituteAuthContext,
  { qr, device }: ScanInput,
  now: Date,
  ip?: string,
): Promise<ScanResult> {
  const parsed = parseQrPayload(qr);
  if (!parsed) throw invalidQr();

  const [row] = await db
    .select({
      session: attendanceSessions,
      subject: { code: subjects.code, name: subjects.name },
      settings: institutes.settings,
    })
    .from(attendanceSessions)
    .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(institutes, eq(institutes.id, attendanceSessions.instituteId))
    .where(and(eq(attendanceSessions.id, parsed.sessionId), eq(attendanceSessions.instituteId, auth.instituteId)))
    .limit(1);
  if (!row || !isQrMacValid(parsed, row.session.qrSecret)) throw invalidQr();
  const { session } = row;

  const status = effectiveStatus(session, now);
  if (status === 'cancelled') throw conflict('SESSION_CANCELLED', 'This session was cancelled by your teacher');
  if (status === 'closed') throw conflict('SESSION_CLOSED', 'Attendance for this session is closed. Talk to your teacher.');

  const freshness = qrFreshness(parsed.step, now.getTime(), session.qrRotationSeconds, session.qrGraceSeconds);
  if (freshness === 'expired') {
    throw badRequest('QR_EXPIRED', 'This code has expired. Scan the code on the screen again.');
  }
  if (freshness === 'future') throw invalidQr();

  // One phone per student: the scan must be signed by the student's linked phone. A
  // signature is always checked when sent, even where the institute doesn't require one.
  const requirePhone = row.settings.attendance?.requireRegisteredPhone ?? ATTENDANCE_DEFAULTS.requireRegisteredPhone;
  let deviceId: string | null = null;
  if (device) deviceId = await verifyScanDevice(db, auth.userId, device, qr);
  else if (requirePhone) {
    throw new AppError(403, 'DEVICE_REQUIRED', 'Scan with the attendance app on your linked phone.');
  }

  const sessionInfo = {
    id: session.id,
    kind: session.kind,
    startedAt: session.startedAt.toISOString(),
    subject: row.subject,
  };

  // Mark present unless already present or set by hand — in one statement, so a scan
  // racing with the teacher's manual change cannot overwrite it.
  const [marked] = await db
    .update(attendanceRecords)
    .set({ status: 'present', method: 'qr', markedAt: now, markedBy: auth.userId, reason: null, qrStep: parsed.step, deviceId, ip })
    .where(
      and(
        eq(attendanceRecords.sessionId, session.id),
        eq(attendanceRecords.studentId, auth.userId),
        ne(attendanceRecords.status, 'present'),
        or(isNull(attendanceRecords.method), eq(attendanceRecords.method, 'qr')),
      ),
    )
    .returning();

  if (marked) {
    const [student] = await db
      .select({ fullName: users.fullName, rollNo: students.rollNo })
      .from(users)
      .innerJoin(students, eq(students.userId, users.id))
      .where(eq(users.id, auth.userId));
    const counts = (await sessionCounts(db, [session.id])).get(session.id)!;
    await hub.publish(db, {
      type: 'marked',
      sessionId: session.id,
      student: { id: auth.userId, fullName: student!.fullName, rollNo: student!.rollNo },
      status: 'present',
      method: 'qr',
      counts,
    });
    return { status: 'present', alreadyMarked: false, markedAt: now.toISOString(), session: sessionInfo };
  }

  // Nothing changed: work out why.
  const [record] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.sessionId, session.id), eq(attendanceRecords.studentId, auth.userId)))
    .limit(1);
  if (!record) {
    throw new AppError(403, 'NOT_IN_SESSION', 'You are not on the list for this class. Ask your teacher to mark you.');
  }
  if (record.status === 'present') {
    return { status: 'present', alreadyMarked: true, markedAt: record.markedAt!.toISOString(), session: sessionInfo };
  }
  throw conflict('MARKED_BY_FACULTY', `Your teacher has marked you ${record.status} for this session.`);
}
