import { describe, expect, it } from 'vitest';
import { generateQrSecret, qrPayload, stepAt } from '../src/modules/attendance/qr.js';
import { as, expectStatus, login, loginStudent, setupClass, setupInstitute, signedScan, useTestApp } from './helpers.js';

const ctx = useTestApp();

async function openSession() {
  const c = await setupClass(ctx.app, ctx.db);
  const session = expectStatus(await as(ctx.app, c.profTokens).post('/v1/sessions', { offeringId: c.offering.id }), 201);
  const currentQr = async () => expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}/qr`), 200).payload as string;
  return { ...c, session, currentQr };
}

const scan = (tokens: Parameters<typeof as>[1], qr: string) => signedScan(ctx, tokens, qr);

describe('scanning', () => {
  it('marks the student present and tells them which class it was', async () => {
    const c = await openSession();
    const student = await loginStudent(ctx.app, 'ca01');
    const res = expectStatus(await scan(student, await c.currentQr()), 200);
    expect(res).toMatchObject({ status: 'present', alreadyMarked: false, session: { id: c.session.id, subject: { code: 'CS301' } } });

    const records = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${c.session.id}/records`), 200);
    expect(records[0]).toMatchObject({ username: 'ca01', status: 'present', method: 'qr' });
  });

  it('works with a code the projector generated locally from the secret', async () => {
    const c = await openSession();
    const config = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${c.session.id}/qr-config`), 200);
    const local = qrPayload(c.session.id, config.secret, stepAt(Date.now(), config.rotationSeconds));
    expectStatus(await scan(await loginStudent(ctx.app, 'ca02'), local), 200);
  });

  it('is harmless to scan twice', async () => {
    const c = await openSession();
    const student = await loginStudent(ctx.app, 'ca01');
    const first = expectStatus(await scan(student, await c.currentQr()), 200);
    const second = expectStatus(await scan(student, await c.currentQr()), 200);
    expect(second).toMatchObject({ alreadyMarked: true, markedAt: first.markedAt });
  });

  it('rejects an expired code — a forwarded screenshot', async () => {
    const c = await openSession();
    const screenshot = await c.currentQr();
    ctx.advance(16_000); // 5 s rotation + 10 s grace has passed
    const res = await scan(await loginStudent(ctx.app, 'ca01'), screenshot);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('QR_EXPIRED');
    // The current code still works.
    expectStatus(await scan(await loginStudent(ctx.app, 'ca01'), await c.currentQr()), 200);
  });

  it('accepts a code that just changed on screen (slow network)', async () => {
    const c = await openSession();
    const qr = await c.currentQr();
    ctx.advance(8_000);
    expectStatus(await scan(await loginStudent(ctx.app, 'ca01'), qr), 200);
  });

  it('rejects forged and tampered codes', async () => {
    const c = await openSession();
    const student = await loginStudent(ctx.app, 'ca01');
    const forged = qrPayload(c.session.id, generateQrSecret(), stepAt(Date.now(), 5));
    expect((await scan(student, forged)).json().error.code).toBe('QR_INVALID');
    const real = await c.currentQr();
    const step = Number(real.split('.')[2]);
    const tampered = real.replace(`.${step}.`, `.${step - 1}.`);
    expect((await scan(student, tampered)).json().error.code).toBe('QR_INVALID');
    expect((await scan(student, 'https://example.com')).json().error.code).toBe('QR_INVALID');
  });

  it("refuses students who aren't on the class list", async () => {
    const c = await openSession();
    const res = await scan(await loginStudent(ctx.app, 'cb01'), await c.currentQr());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_IN_SESSION');
  });

  it("doesn't accept a code from another institute's session", async () => {
    const c = await openSession();
    const beta = await setupInstitute(ctx.app, ctx.db, 'BETA');
    await as(ctx.app, beta.admin).post('/v1/structure/levels', { name: 'Class' });
    const unit = expectStatus(await as(ctx.app, beta.admin).post('/v1/structure/units', { name: 'X' }), 201);
    await as(ctx.app, beta.admin).post('/v1/students', { username: 'ca01', fullName: 'Same Name', unitId: unit.id, password: 'correct-horse-battery' });
    const betaStudent = await login(ctx.app, { instituteCode: 'BETA', username: 'ca01' });
    expect((await scan(betaStudent, await c.currentQr())).json().error.code).toBe('QR_INVALID');
  });

  it('refuses scans once the session is closed, timed out or cancelled', async () => {
    const c = await openSession();
    const student = await loginStudent(ctx.app, 'ca01');
    const qr = await c.currentQr();
    await as(ctx.app, c.profTokens).post(`/v1/sessions/${c.session.id}/close`);
    expect((await scan(student, qr)).json().error.code).toBe('SESSION_CLOSED');

    await as(ctx.app, c.profTokens).post(`/v1/sessions/${c.session.id}/extend`, { minutes: 1 });
    const fresh = await c.currentQr();
    ctx.advance(61_000);
    expect((await scan(student, fresh)).json().error.code).toBe('SESSION_CLOSED');
  });

  it("can't override what the teacher marked by hand", async () => {
    const c = await openSession();
    await as(ctx.app, c.profTokens).post(`/v1/sessions/${c.session.id}/mark`, {
      studentIds: [c.students.a1],
      status: 'absent',
      reason: 'Left after attendance',
    });
    const res = await scan(await loginStudent(ctx.app, 'ca01'), await c.currentQr());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MARKED_BY_FACULTY');
  });

  it('is for students only', async () => {
    const c = await openSession();
    const res = await as(ctx.app, c.profTokens).post('/v1/attendance/scan', { qr: await c.currentQr() });
    expect(res.statusCode).toBe(403);
  });

  it('handles a whole class scanning at the same moment', async () => {
    const c = await openSession();
    const tokens = await Promise.all(['ca01', 'ca02', 'ca03'].map((u) => loginStudent(ctx.app, u)));
    const qr = await c.currentQr();
    const results = await Promise.all(tokens.flatMap((t) => [scan(t, qr), scan(t, qr)]));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const session = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${c.session.id}`), 200);
    expect(session.counts).toMatchObject({ present: 3, absent: 0 });
  });
});
