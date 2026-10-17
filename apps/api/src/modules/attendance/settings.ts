import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { institutes } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';

export type AttendanceSettings = {
  qrRotationSeconds: number;
  qrGraceSeconds: number;
  defaultScanMinutes: number;
  requireRegisteredPhone: boolean;
  minimumPercent: number;
  correctionWindowDays: number;
  lowAttendanceAlerts: boolean;
  weeklyStaffSummary: boolean;
};

export const ATTENDANCE_DEFAULTS: AttendanceSettings = {
  qrRotationSeconds: 5,
  qrGraceSeconds: 10,
  defaultScanMinutes: 10,
  requireRegisteredPhone: true,
  minimumPercent: 75,
  correctionWindowDays: 7,
  lowAttendanceAlerts: true,
  weeklyStaffSummary: true,
};

export async function getAttendanceSettings(db: DbOrTx, instituteId: string): Promise<AttendanceSettings> {
  const [row] = await db
    .select({ settings: institutes.settings })
    .from(institutes)
    .where(eq(institutes.id, instituteId))
    .limit(1);
  if (!row) throw notFound('Institute');
  return { ...ATTENDANCE_DEFAULTS, ...row.settings.attendance };
}

export async function updateAttendanceSettings(
  db: Db,
  auth: InstituteAuthContext,
  changes: Partial<AttendanceSettings>,
  ip?: string,
): Promise<AttendanceSettings> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ settings: institutes.settings })
      .from(institutes)
      .where(eq(institutes.id, auth.instituteId))
      .for('update')
      .limit(1);
    const attendance = { ...row!.settings.attendance, ...changes };
    await tx
      .update(institutes)
      .set({ settings: { ...row!.settings, attendance } })
      .where(eq(institutes.id, auth.instituteId));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'settings.attendance_updated',
      data: { changes },
      ip,
    });
    return { ...ATTENDANCE_DEFAULTS, ...attendance };
  });
}
