import { VerifiedBootState } from '@peculiar/asn1-android';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attendanceRecords, auditLogs } from '../src/db/schema.js';
import {
  as,
  createUserAs,
  expectStatus,
  linkPhone,
  login,
  loginStudent,
  setupClass,
  setupInstitute,
  type TestPhone,
  type Tokens,
  useTestApp,
} from './helpers.js';

const ctx = useTestApp();

async function openClass() {
  const c = await setupClass(ctx.app, ctx.db);
  const session = expectStatus(await as(ctx.app, c.profTokens).post('/v1/sessions', { offeringId: c.offering.id }), 201);
  const currentQr = async () => expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}/qr`), 200).payload as string;
  return { ...c, session, currentQr };
}

/** Links a phone and expects it to succeed. */
async function link(tokens: Tokens, opts: Parameters<typeof linkPhone>[2] = {}): Promise<TestPhone> {
  const { res, phone } = await linkPhone(ctx.app, tokens, opts);
  expectStatus(res, 201);
  return phone!;
}

const scanWith = (tokens: Tokens, phone: TestPhone, qr: string, signature = phone.key.sign(phone.deviceId, qr)) =>
  as(ctx.app, tokens).post('/v1/attendance/scan', { qr, device: { id: phone.deviceId, signature } });

const errorCode = (res: { json(): { error?: { code: string } } }) => res.json().error?.code;

describe('linking a phone', () => {
  it('links the first phone straight away, and scans signed by it mark the student present', async () => {
    const c = await openClass();
    const student = await loginStudent(ctx.app, 'ca01');
    expect(expectStatus(await as(ctx.app, student).get('/v1/devices/mine'), 200)).toEqual({ active: null, pending: null });

    const phone = await link(student, { model: 'Pixel 9' });
    expect(phone.status).toBe('active');
    const mine = expectStatus(await as(ctx.app, student).get('/v1/devices/mine'), 200);
    expect(mine.active).toMatchObject({ id: phone.deviceId, model: 'Pixel 9', securityLevel: 'tee', bootState: 'verified' });

    const qr = await c.currentQr();
    expectStatus(await scanWith(student, phone, qr), 200);
    const [record] = await ctx.db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.sessionId, c.session.id), eq(attendanceRecords.studentId, c.students.a1)));
    expect(record).toMatchObject({ status: 'present', deviceId: phone.deviceId });
  });

  it('refuses unsigned scans unless the institute turns the requirement off', async () => {
    const c = await openClass();
    const student = await loginStudent(ctx.app, 'ca01');
    const unsigned = await as(ctx.app, student).post('/v1/attendance/scan', { qr: await c.currentQr() });
    expect(unsigned.statusCode).toBe(403);
    expect(errorCode(unsigned)).toBe('DEVICE_REQUIRED');

    // An expired code is still reported as expired, before the phone check.
    const old = await c.currentQr();
    ctx.advance(16_000);
    expect(errorCode(await as(ctx.app, student).post('/v1/attendance/scan', { qr: old }))).toBe('QR_EXPIRED');

    const settings = expectStatus(await as(ctx.app, c.admin).get('/v1/settings/attendance'), 200);
    expect(settings.requireRegisteredPhone).toBe(true);
    expectStatus(await as(ctx.app, c.admin).patch('/v1/settings/attendance', { requireRegisteredPhone: false }), 200);
    expectStatus(await as(ctx.app, student).post('/v1/attendance/scan', { qr: await c.currentQr() }), 200);
  });

  it('refuses scans signed by the wrong key, for another code, or with another student’s phone', async () => {
    const c = await openClass();
    const s1 = await loginStudent(ctx.app, 'ca01');
    const s2 = await loginStudent(ctx.app, 'ca02');
    const phone1 = await link(s1);
    const phone2 = await link(s2);
    const qr = await c.currentQr();

    const wrongKey = await scanWith(s1, phone1, qr, phone2.key.sign(phone1.deviceId, qr));
    expect(errorCode(wrongKey)).toBe('DEVICE_SIGNATURE_INVALID');
    const otherCode = await scanWith(s1, phone1, qr, phone1.key.sign(phone1.deviceId, 'QA1.SOMETHING.1.ELSE'));
    expect(errorCode(otherCode)).toBe('DEVICE_SIGNATURE_INVALID');
    expect(errorCode(await scanWith(s1, phone1, qr, 'not-a-signature-at-all'))).toBe('DEVICE_SIGNATURE_INVALID');
    // s1 using s2's phone identity: the phone isn't s1's.
    expect(errorCode(await scanWith(s1, phone2, qr))).toBe('DEVICE_NOT_LINKED');
    expectStatus(await scanWith(s1, phone1, qr), 200);
  });

  it('allows one student per phone', async () => {
    await setupClass(ctx.app, ctx.db);
    const s1 = await loginStudent(ctx.app, 'ca01');
    const s2 = await loginStudent(ctx.app, 'ca02');
    const phone = await link(s1, { phoneId: 'shared-phone' });
    const { res } = await linkPhone(ctx.app, s2, { phoneId: 'shared-phone' });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PHONE_IN_USE');
    expect(phone.status).toBe('active');
  });

  it('refuses an expired challenge, someone else’s challenge, and a failed attestation', async () => {
    await setupClass(ctx.app, ctx.db);
    const s1 = await loginStudent(ctx.app, 'ca01');
    const s2 = await loginStudent(ctx.app, 'ca02');
    const { challenge } = expectStatus(await as(ctx.app, s2).post('/v1/devices/challenge'), 200);
    expect(errorCode((await linkPhone(ctx.app, s1, { challenge })).res)).toBe('CHALLENGE_INVALID');

    const failed = await linkPhone(ctx.app, s1, { packageName: 'com.example.cheat' });
    expect(failed.res.statusCode).toBe(400);
    expect(errorCode(failed.res)).toBe('ATTESTATION_FAILED');

    const { challenge: mine } = expectStatus(await as(ctx.app, s1).post('/v1/devices/challenge'), 200);
    ctx.advance(11 * 60_000);
    expect(errorCode((await linkPhone(ctx.app, s1, { challenge: mine })).res)).toBe('CHALLENGE_INVALID');
  });

  it('is idempotent when the app retries the same registration', async () => {
    await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    const api = as(ctx.app, student);
    const { challenge } = expectStatus(await api.post('/v1/devices/challenge'), 200);
    const { key } = await linkPhone(ctx.app, student, { challenge });
    const body = { platform: 'android', challenge, certificateChain: key.chain, phoneId: 'p1' };
    // linkPhone already registered this key; sending it again returns the same phone.
    const again = expectStatus(await api.post('/v1/devices', body), 201);
    const mine = expectStatus(await api.get('/v1/devices/mine'), 200);
    expect(again.device.id).toBe(mine.active.id);
  });

  it('is for students only', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    expect((await as(ctx.app, c.profTokens).post('/v1/devices/challenge')).statusCode).toBe(403);
    expect((await as(ctx.app, c.profTokens).get('/v1/devices/mine')).statusCode).toBe(403);
  });
});

describe('switching phones', () => {
  it('asks for approval; the old phone works until the switch is approved', async () => {
    const c = await openClass();
    const student = await loginStudent(ctx.app, 'ca01');
    const oldPhone = await link(student, { model: 'Old Phone' });
    const newPhone = await link(student, { model: 'New Phone' });
    expect(newPhone.status).toBe('pending');

    const mine = expectStatus(await as(ctx.app, student).get('/v1/devices/mine'), 200);
    expect(mine).toMatchObject({ active: { id: oldPhone.deviceId }, pending: { id: newPhone.deviceId } });

    const qr = await c.currentQr();
    expect(errorCode(await scanWith(student, newPhone, qr))).toBe('DEVICE_PENDING');

    // The admin sees the request, with the phone it replaces and the history.
    const list = expectStatus(await as(ctx.app, c.admin).get('/v1/devices'), 200);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: newPhone.deviceId,
      model: 'New Phone',
      student: { username: 'ca01', unitPath: ['Computer Engineering', 'SY', 'Div A'] },
      replaces: { id: oldPhone.deviceId, model: 'Old Phone' },
      history: { phones: 1 },
    });
    expect(expectStatus(await as(ctx.app, c.admin).get('/v1/devices/pending-count'), 200)).toEqual({ count: 1 });

    expectStatus(await scanWith(student, oldPhone, qr), 200);

    const approved = expectStatus(await as(ctx.app, c.admin).post(`/v1/devices/${newPhone.deviceId}/approve`), 200);
    expect(approved.status).toBe('active');
    const qr2 = await c.currentQr();
    expect(errorCode(await scanWith(student, oldPhone, qr2))).toBe('DEVICE_REVOKED');
    expect((await scanWith(student, newPhone, qr2)).statusCode).toBe(200);

    const linked = expectStatus(await as(ctx.app, c.admin).get('/v1/devices?status=revoked'), 200);
    expect(linked.items[0]).toMatchObject({ id: oldPhone.deviceId, endReason: 'Replaced by a new phone' });

    const actions = (await ctx.db.select({ action: auditLogs.action }).from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['device.linked', 'device.change_requested', 'device.change_approved']));
  });

  it('keeps the old phone when the request is turned down, and supersedes older requests', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    const oldPhone = await link(student);
    const first = await link(student);
    const second = await link(student);
    const rejected = expectStatus(await as(ctx.app, c.admin).get('/v1/devices?status=rejected'), 200);
    expect(rejected.items.map((d: { id: string }) => d.id)).toEqual([first.deviceId]);
    expect(rejected.items[0].endReason).toBe('Superseded by a newer request');

    const res = expectStatus(
      await as(ctx.app, c.admin).post(`/v1/devices/${second.deviceId}/reject`, { reason: 'Not your phone — see the office' }),
      200,
    );
    expect(res).toMatchObject({ status: 'rejected', endReason: 'Not your phone — see the office' });
    const mine = expectStatus(await as(ctx.app, student).get('/v1/devices/mine'), 200);
    expect(mine).toMatchObject({ active: { id: oldPhone.deviceId }, pending: null });

    // Acting on a request that was already handled.
    const again = await as(ctx.app, c.admin).post(`/v1/devices/${second.deviceId}/approve`);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('DEVICE_STATE_CHANGED');
  });

  it('replaces the key without approval when the app is reinstalled on the same, unmodified phone', async () => {
    await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    const before = await link(student, { phoneId: 'my-phone' });
    const after = await link(student, { phoneId: 'my-phone' });
    expect(after.status).toBe('active');
    const mine = expectStatus(await as(ctx.app, student).get('/v1/devices/mine'), 200);
    expect(mine.active.id).toBe(after.deviceId);
    expect(mine.active.id).not.toBe(before.deviceId);
  });

  it('asks for approval when the same phone has been rooted (unlocked bootloader)', async () => {
    await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    await link(student, { phoneId: 'my-phone' });
    const rooted = await link(student, { phoneId: 'my-phone', bootState: VerifiedBootState.unverified, locked: false });
    expect(rooted.status).toBe('pending');
  });

  it('links the next phone straight away after an admin unlinks a lost one', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    const lost = await link(student);
    const revoked = expectStatus(
      await as(ctx.app, c.admin).post(`/v1/devices/${lost.deviceId}/revoke`, { reason: 'Phone stolen' }),
      200,
    );
    expect(revoked).toMatchObject({ status: 'revoked', endReason: 'Phone stolen' });
    expect((await link(student)).status).toBe('active');
  });

  it('refuses to approve a phone that another student has linked meanwhile', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const s1 = await loginStudent(ctx.app, 'ca01');
    const s2 = await loginStudent(ctx.app, 'ca02');
    await link(s1);
    const request = await link(s1, { phoneId: 'contested' });
    await link(s2, { phoneId: 'contested' });
    const res = await as(ctx.app, c.admin).post(`/v1/devices/${request.deviceId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PHONE_IN_USE');
  });
});

describe('who can manage phones', () => {
  it('lets a HOD handle requests from their department only', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    await createUserAs(ctx.app, c.admin, { role: 'hod', username: 'hod.comp', unitId: c.s.comp });
    await createUserAs(ctx.app, c.admin, { role: 'student', username: 'me01', unitId: c.s.mechA });
    const hod = await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' });

    const comp = await loginStudent(ctx.app, 'ca01');
    const mech = await loginStudent(ctx.app, 'me01');
    await link(comp);
    await link(mech);
    const compRequest = await link(comp);
    const mechRequest = await link(mech);

    const seen = expectStatus(await as(ctx.app, hod).get('/v1/devices'), 200);
    expect(seen.items.map((d: { id: string }) => d.id)).toEqual([compRequest.deviceId]);
    expect(expectStatus(await as(ctx.app, hod).get('/v1/devices/pending-count'), 200).count).toBe(1);
    expect((await as(ctx.app, hod).post(`/v1/devices/${mechRequest.deviceId}/approve`)).statusCode).toBe(403);
    expectStatus(await as(ctx.app, hod).post(`/v1/devices/${compRequest.deviceId}/approve`), 200);

    // Search and class filters.
    const admin = as(ctx.app, c.admin);
    expect(expectStatus(await admin.get('/v1/devices?status=active&q=me01'), 200).total).toBe(1);
    expect(expectStatus(await admin.get(`/v1/devices?status=active&unitId=${c.s.comp}`), 200).total).toBe(1);
  });

  it('is not for faculty or students, and stays inside the institute', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const student = await loginStudent(ctx.app, 'ca01');
    await link(student);
    const request = await link(student);
    expect((await as(ctx.app, c.profTokens).get('/v1/devices')).statusCode).toBe(403);
    expect((await as(ctx.app, student).post(`/v1/devices/${request.deviceId}/approve`)).statusCode).toBe(403);

    const other = await setupInstitute(ctx.app, ctx.db, 'BETA');
    expect(expectStatus(await as(ctx.app, other.admin).get('/v1/devices'), 200).total).toBe(0);
    expect((await as(ctx.app, other.admin).post(`/v1/devices/${request.deviceId}/approve`)).statusCode).toBe(404);
  });
});
