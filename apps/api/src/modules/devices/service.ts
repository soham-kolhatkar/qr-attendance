import { createHash, verify as verifySignature } from 'node:crypto';
import { and, count, desc, eq, ilike, inArray, isNotNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { type DeviceAttestation, devices, students, units, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { prepared } from '../../lib/prepared.js';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { assertPathInScope, type Scope, scopeCondition } from '../../lib/scope.js';
import { containsPattern } from '../../lib/sql.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { loadUnitIndex } from '../structure/service.js';
import { type AndroidAttestationPolicy, AttestationError, verifyAndroidAttestation } from './attestation.js';
import { isChallengeValid } from './challenge.js';

type DeviceRow = typeof devices.$inferSelect;

export type DeviceDto = {
  id: string;
  platform: 'android' | 'ios';
  status: DeviceRow['status'];
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  securityLevel: DeviceAttestation['securityLevel'];
  bootState: DeviceAttestation['bootState'];
  bootloaderLocked: boolean | null;
  osPatchLevel: number | null;
  createdAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
};

export const toDeviceDto = (d: DeviceRow): DeviceDto => ({
  id: d.id,
  platform: d.platform,
  status: d.status,
  model: d.model,
  osVersion: d.osVersion,
  appVersion: d.appVersion,
  securityLevel: d.attestation.securityLevel,
  bootState: d.attestation.bootState,
  bootloaderLocked: d.attestation.bootloaderLocked,
  osPatchLevel: d.attestation.osPatchLevel,
  createdAt: d.createdAt.toISOString(),
  activatedAt: d.activatedAt?.toISOString() ?? null,
  endedAt: d.endedAt?.toISOString() ?? null,
  endReason: d.endReason,
});

const phoneInUse = () =>
  conflict(
    'PHONE_IN_USE',
    'This phone is already linked to another student. Each phone can be used by one student only — if this is your phone, ask your admin to unlink it.',
  );

const SUPERSEDED = 'Superseded by a newer request';

/** Same phone, same app install identity — without storing the raw id. */
const phoneHash = (instituteId: string, platform: string, phoneId: string) =>
  createHash('sha256').update(`${instituteId}:${platform}:${phoneId}`).digest('hex');

// ---------------------------------------------------------------------------
// Linking a phone (students)
// ---------------------------------------------------------------------------

export type RegisterDeviceInput = {
  platform: 'android';
  challenge: string;
  /** Key attestation certificates, base64 DER, the key's own certificate first. */
  certificateChain: string[];
  /** ANDROID_ID: stable for our app on one phone until a factory reset. */
  phoneId: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
};

/**
 * Links the phone that generated the attested key:
 * - first phone (or after an admin unlinked the old one): linked straight away;
 * - the app reinstalled on the same, unmodified phone: the new key replaces the old one;
 * - a different phone: a change request that an admin or HOD must approve. Until then
 *   the old phone keeps working.
 */
export async function registerDevice(
  db: Db,
  policy: AndroidAttestationPolicy,
  challengeSecret: string,
  auth: InstituteAuthContext,
  input: RegisterDeviceInput,
  now: Date,
  log: { warn(obj: object, msg: string): void },
  ip?: string,
): Promise<DeviceDto> {
  if (!isChallengeValid(challengeSecret, auth.userId, input.challenge, now)) {
    throw badRequest('CHALLENGE_INVALID', 'This request to link your phone has expired. Please try again.');
  }
  let verified;
  try {
    verified = await verifyAndroidAttestation(input.certificateChain, Buffer.from(input.challenge, 'utf8'), policy, now);
  } catch (err) {
    if (!(err instanceof AttestationError)) throw err;
    log.warn({ userId: auth.userId, reason: err.message, model: input.model }, 'Phone attestation rejected');
    throw badRequest(
      'ATTESTATION_FAILED',
      "This phone couldn't prove it is a genuine Android phone running the official app, so it can't be linked.",
    );
  }

  const publicKey = verified.publicKey.toString('base64');
  const keyHash = createHash('sha256').update(verified.publicKey).digest('hex');
  const hash = phoneHash(auth.instituteId, input.platform, input.phoneId);

  try {
    return await db.transaction(async (tx) => {
      // One registration at a time per student.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.userId)).for('update');

      const [sameKey] = await tx.select().from(devices).where(eq(devices.keyHash, keyHash)).limit(1);
      if (sameKey) {
        // The app retried after a lost response.
        if (sameKey.userId === auth.userId && (sameKey.status === 'active' || sameKey.status === 'pending')) {
          return toDeviceDto(sameKey);
        }
        throw badRequest('ATTESTATION_FAILED', 'This phone key has already been used. Please try again.');
      }

      const [otherStudent] = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(
            eq(devices.instituteId, auth.instituteId),
            eq(devices.phoneHash, hash),
            eq(devices.status, 'active'),
            ne(devices.userId, auth.userId),
          ),
        )
        .limit(1);
      if (otherStudent) throw phoneInUse();

      const current = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.userId, auth.userId), inArray(devices.status, ['active', 'pending'])));
      const active = current.find((d) => d.status === 'active');
      const pending = current.find((d) => d.status === 'pending');

      const unmodified = verified.attestation.bootState === 'verified' && verified.attestation.bootloaderLocked === true;
      const reinstalledHere = active?.phoneHash === hash && unmodified;
      const linkNow = !active || reinstalledHere;

      if (pending) await endDevice(tx, pending.id, 'rejected', now, null, SUPERSEDED);
      if (active && linkNow) {
        await endDevice(tx, active.id, 'revoked', now, null, 'Replaced: the app was reinstalled on the same phone');
      }
      const [device] = await tx
        .insert(devices)
        .values({
          instituteId: auth.instituteId,
          userId: auth.userId,
          platform: input.platform,
          status: linkNow ? 'active' : 'pending',
          publicKey,
          keyHash,
          phoneHash: hash,
          attestation: verified.attestation,
          model: input.model ?? null,
          osVersion: input.osVersion ?? null,
          appVersion: input.appVersion ?? null,
          activatedAt: linkNow ? now : null,
        })
        .returning();
      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: linkNow ? 'device.linked' : 'device.change_requested',
        entityType: 'device',
        entityId: device!.id,
        data: {
          model: input.model,
          ...(active && { previousDeviceId: active.id }),
          ...(reinstalledHere && { reinstalledOnSamePhone: true }),
          bootState: verified.attestation.bootState,
        },
        ip,
      });
      return toDeviceDto(device!);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'devices_one_user_per_phone')) throw phoneInUse();
    throw err;
  }
}

async function endDevice(
  tx: DbOrTx,
  id: string,
  status: 'revoked' | 'rejected',
  now: Date,
  by: string | null,
  reason: string,
): Promise<void> {
  await tx.update(devices).set({ status, endedAt: now, endedBy: by, endReason: reason }).where(eq(devices.id, id));
}

/** The student's linked phone and any change waiting for approval. */
export async function getMyDevices(db: Db, userId: string): Promise<{ active: DeviceDto | null; pending: DeviceDto | null }> {
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, userId), inArray(devices.status, ['active', 'pending'])));
  const find = (status: string) => rows.find((d) => d.status === status);
  return {
    active: find('active') ? toDeviceDto(find('active')!) : null,
    pending: find('pending') ? toDeviceDto(find('pending')!) : null,
  };
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/** What the app signs for each scan: binds the scanned code to the phone. */
export const scanSigningMessage = (deviceId: string, qr: string) => Buffer.from(`QAS1|${deviceId}|${qr}`, 'utf8');

const scanDeviceQuery = prepared((db) =>
  db
    .select({ id: devices.id, status: devices.status, publicKey: devices.publicKey })
    .from(devices)
    .where(and(eq(devices.id, sql.placeholder('id')), eq(devices.userId, sql.placeholder('userId'))))
    .limit(1)
    .prepare('scan_device'),
);

/** Checks that a scan was signed by the student's linked phone. Returns the device id. */
export async function verifyScanDevice(
  db: Db,
  userId: string,
  proof: { id: string; signature: string },
  qr: string,
): Promise<string> {
  const [device] = await scanDeviceQuery(db).execute({ id: proof.id, userId });
  if (!device) {
    throw new AppError(403, 'DEVICE_NOT_LINKED', "This phone isn't linked to your account. Open the app again to link it.");
  }
  if (device.status === 'pending') {
    throw new AppError(403, 'DEVICE_PENDING', 'Your new phone is waiting for approval. Scan with your old phone, or ask your teacher to mark you.');
  }
  if (device.status !== 'active') {
    throw new AppError(403, 'DEVICE_REVOKED', 'This phone is no longer linked to your account. Open the app again to link it.');
  }
  let valid = false;
  try {
    valid = verifySignature(
      'sha256',
      scanSigningMessage(device.id, qr),
      { key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki', dsaEncoding: 'der' },
      Buffer.from(proof.signature, 'base64'),
    );
  } catch {
    // Malformed signature.
  }
  if (!valid) throw new AppError(403, 'DEVICE_SIGNATURE_INVALID', "This scan couldn't be verified as coming from your phone.");
  return device.id;
}

// ---------------------------------------------------------------------------
// Managing phones (admins and HODs)
// ---------------------------------------------------------------------------

export type DeviceListQuery = {
  status: DeviceRow['status'];
  q?: string;
  unitId?: string;
  page: number;
  pageSize: number;
};

export type ManagedDeviceDto = DeviceDto & {
  student: { id: string; username: string; fullName: string; rollNo: string | null; unitPath: string[] };
  /** For a change request: the phone it would replace. */
  replaces: DeviceDto | null;
  /** Phones the student used before this one, and when the last one was linked. */
  history: { phones: number; lastLinkedAt: string | null };
};

export async function listDevices(db: Db, auth: InstituteAuthContext, scope: Scope, query: DeviceListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(devices.instituteId, auth.instituteId),
    eq(devices.status, query.status),
    scopeCondition(scope, units.path),
  ];
  if (query.unitId) conditions.push(scopeCondition({ all: false, unitId: query.unitId }, units.path));
  if (query.q) {
    const pattern = containsPattern(query.q);
    conditions.push(or(ilike(users.username, pattern), ilike(users.fullName, pattern), ilike(students.rollNo, pattern)));
  }
  const where = and(...conditions);
  const base = () =>
    db
      .select({ device: devices, username: users.username, fullName: users.fullName, rollNo: students.rollNo, unitId: students.unitId })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .innerJoin(students, eq(students.userId, devices.userId))
      .innerJoin(units, eq(units.id, students.unitId));

  const rows = await base()
    .where(where)
    // Requests: oldest first, so none waits forever. Otherwise newest first.
    .orderBy(query.status === 'pending' ? devices.createdAt : desc(devices.activatedAt), devices.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [totalRow] = await db
    .select({ total: count() })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .innerJoin(students, eq(students.userId, devices.userId))
    .innerJoin(units, eq(units.id, students.unitId))
    .where(where);

  return {
    items: await toManagedDtos(db, auth.instituteId, rows),
    total: totalRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function toManagedDtos(
  db: Db,
  instituteId: string,
  rows: { device: DeviceRow; username: string; fullName: string; rollNo: string | null; unitId: string }[],
): Promise<ManagedDeviceDto[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.device.userId))];
  const index = await loadUnitIndex(db, instituteId);
  const activeRows = await db
    .select()
    .from(devices)
    .where(and(inArray(devices.userId, userIds), eq(devices.status, 'active')));
  const everLinked = await db
    .select({ id: devices.id, userId: devices.userId, activatedAt: devices.activatedAt })
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNotNull(devices.activatedAt)));
  const activeByUser = new Map(activeRows.map((d) => [d.userId, d]));
  return rows.map(({ device, username, fullName, rollNo, unitId }) => {
    const before = everLinked.filter((d) => d.userId === device.userId && d.id !== device.id);
    const lastLinked = before.reduce<Date | null>((m, d) => (m && m > d.activatedAt! ? m : d.activatedAt), null);
    const replaces = device.status === 'pending' ? activeByUser.get(device.userId) : undefined;
    return {
      ...toDeviceDto(device),
      student: { id: device.userId, username, fullName, rollNo, unitPath: index.pathNames(unitId) },
      replaces: replaces ? toDeviceDto(replaces) : null,
      history: { phones: before.length, lastLinkedAt: lastLinked?.toISOString() ?? null },
    };
  });
}

/** Number of change requests waiting, for a badge in the menu. */
export async function countPendingDevices(db: Db, auth: InstituteAuthContext, scope: Scope): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(devices)
    .innerJoin(students, eq(students.userId, devices.userId))
    .innerJoin(units, eq(units.id, students.unitId))
    .where(and(eq(devices.instituteId, auth.instituteId), eq(devices.status, 'pending'), scopeCondition(scope, units.path)));
  return row?.total ?? 0;
}

/** Locks a device in the caller's institute and checks the student is in their scope. */
async function findManagedDevice(tx: DbOrTx, auth: InstituteAuthContext, scope: Scope, id: string): Promise<DeviceRow> {
  const [row] = await tx
    .select({ device: devices, unitPath: units.path })
    .from(devices)
    .innerJoin(students, eq(students.userId, devices.userId))
    .innerJoin(units, eq(units.id, students.unitId))
    .where(and(eq(devices.id, id), eq(devices.instituteId, auth.instituteId)))
    .for('update', { of: devices })
    .limit(1);
  if (!row) throw notFound('Phone');
  assertPathInScope(scope, row.unitPath, 'This student');
  return row.device;
}

async function deviceAction<T>(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  id: string,
  expected: DeviceRow['status'],
  act: (tx: DbOrTx, device: DeviceRow) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      const device = await findManagedDevice(tx, auth, scope, id);
      if (device.status !== expected) {
        const what = { pending: 'a pending request', active: 'a linked phone', revoked: 'unlinked', rejected: 'rejected' };
        throw conflict('DEVICE_STATE_CHANGED', `This phone is no longer ${what[expected]}. Refresh the list.`);
      }
      return act(tx, device);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'devices_one_user_per_phone')) throw phoneInUse();
    throw err;
  }
}

async function reload(tx: DbOrTx, id: string): Promise<DeviceDto> {
  const [row] = await tx.select().from(devices).where(eq(devices.id, id));
  return toDeviceDto(row!);
}

/** Approves a change of phone: the new one becomes the student's phone, the old one stops working. */
export async function approveDevice(db: Db, auth: InstituteAuthContext, scope: Scope, id: string, now: Date, ip?: string) {
  return deviceAction(db, auth, scope, id, 'pending', async (tx, device) => {
    const [old] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.userId, device.userId), eq(devices.status, 'active')));
    if (old) await endDevice(tx, old.id, 'revoked', now, auth.userId, 'Replaced by a new phone');
    await tx
      .update(devices)
      .set({ status: 'active', activatedAt: now, activatedBy: auth.userId })
      .where(eq(devices.id, device.id));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'device.change_approved',
      entityType: 'device',
      entityId: device.id,
      data: { studentId: device.userId, ...(old && { previousDeviceId: old.id }) },
      ip,
    });
    return reload(tx, device.id);
  });
}

export async function rejectDevice(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  id: string,
  reason: string,
  now: Date,
  ip?: string,
) {
  return deviceAction(db, auth, scope, id, 'pending', async (tx, device) => {
    await endDevice(tx, device.id, 'rejected', now, auth.userId, reason);
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'device.change_rejected',
      entityType: 'device',
      entityId: device.id,
      data: { studentId: device.userId, reason },
      ip,
    });
    return reload(tx, device.id);
  });
}

/** Unlinks a student's phone (lost, stolen, sold). Their next phone links without approval. */
export async function revokeDevice(
  db: Db,
  auth: InstituteAuthContext,
  scope: Scope,
  id: string,
  reason: string,
  now: Date,
  ip?: string,
) {
  return deviceAction(db, auth, scope, id, 'active', async (tx, device) => {
    await endDevice(tx, device.id, 'revoked', now, auth.userId, reason);
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'device.unlinked',
      entityType: 'device',
      entityId: device.id,
      data: { studentId: device.userId, reason },
      ip,
    });
    return reload(tx, device.id);
  });
}
