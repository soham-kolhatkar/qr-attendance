import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema.js';
import { closeExpiredSessions } from '../src/modules/attendance/sessions.js';
import { as, createUserAs, expectStatus, login, setupClass, useTestApp } from './helpers.js';

const ctx = useTestApp();

async function start(tokens: Parameters<typeof as>[1], body: object) {
  return as(ctx.app, tokens).post('/v1/sessions', body);
}

describe('starting a session', () => {
  it('snapshots the class list with everyone absent and opens scanning', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id, topic: 'Linked lists' }), 201);
    expect(session).toMatchObject({
      status: 'open',
      kind: 'lecture',
      topic: 'Linked lists',
      offering: { subject: { code: 'CS301' } },
      createdBy: { fullName: 'Prof A' },
      counts: { present: 0, absent: 3, excused: 0, total: 3 },
    });
    // Default scan window: 10 minutes.
    expect(new Date(session.closesAt).getTime() - new Date(session.startedAt).getTime()).toBe(10 * 60_000);

    const records = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}/records`), 200);
    expect(records.map((r: { username: string; status: string }) => `${r.username}:${r.status}`)).toEqual([
      'ca01:absent',
      'ca02:absent',
      'ca03:absent',
    ]);
  });

  it('can narrow the audience to one lab batch', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(
      await start(c.profTokens, { offeringId: c.offering.id, kind: 'lab', audience: { groupIds: [c.s.a2] } }),
      201,
    );
    expect(session.counts.total).toBe(1);
    expect(session.audience).toEqual({ unitIds: [], groupIds: [c.s.a2] });
  });

  it('refuses an audience with nobody from the class in it', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const res = await start(c.profTokens, { offeringId: c.offering.id, audience: { unitIds: [c.s.compB] } });
    expect(res.json().error.code).toBe('EMPTY_ROSTER');
  });

  it("keeps the old class list when students move later (history doesn't change)", async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    await as(ctx.app, c.admin).patch(`/v1/students/${c.students.a1}`, { unitId: c.s.compB });
    const again = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}`), 200);
    expect(again.counts.total).toBe(3);
  });

  it('only lets the teachers of the offering (or HOD/admin) start it', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const other = await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' });
    expect((await start(other, { offeringId: c.offering.id })).statusCode).toBe(404);
    await createUserAs(ctx.app, c.admin, { role: 'hod', username: 'hod.comp', unitId: c.s.comp });
    const hod = await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' });
    expectStatus(await start(hod, { offeringId: c.offering.id }), 201);
    const student = await login(ctx.app, { instituteCode: 'ALPHA', username: 'ca01' });
    expect((await start(student, { offeringId: c.offering.id })).statusCode).toBe(403);
  });

  it('allows one open session per teacher, but not after it has timed out', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const first = expectStatus(await start(c.profTokens, { offeringId: c.offering.id, scanMinutes: 5 }), 201);
    const again = await start(c.profTokens, { offeringId: c.offering.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'SESSION_ALREADY_OPEN', details: { sessionId: first.id } });

    ctx.advance(6 * 60_000);
    expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const old = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${first.id}`), 200);
    expect(old.status).toBe('closed');
  });

  it('uses the institute settings in force when the session starts', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    expectStatus(await as(ctx.app, c.admin).patch('/v1/settings/attendance', { qrRotationSeconds: 8, defaultScanMinutes: 3 }), 200);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const config = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}/qr-config`), 200);
    expect(config).toMatchObject({ rotationSeconds: 8, graceSeconds: 10 });
    expect(new Date(session.closesAt).getTime() - new Date(session.startedAt).getTime()).toBe(3 * 60_000);
  });
});

describe('QR for the projector', () => {
  it('gives the screen the secret, and the current code, only while open', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const prof = as(ctx.app, c.profTokens);
    const config = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr-config`), 200);
    expect(config.secret).toMatch(/^[\w-]{43}$/);
    const qr = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200);
    expect(qr.payload).toMatch(/^QA1\./);

    // The secret never appears in session listings.
    expect(JSON.stringify(expectStatus(await prof.get('/v1/sessions'), 200))).not.toContain(config.secret);

    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    expect((await prof.get(`/v1/sessions/${session.id}/qr-config`)).json().error.code).toBe('SESSION_CLOSED');
  });
});

describe('manual marking', () => {
  it('marks several students with a reason and logs who changed what', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const prof = as(ctx.app, c.profTokens);
    const res = expectStatus(
      await prof.post(`/v1/sessions/${session.id}/mark`, {
        studentIds: [c.students.a1, c.students.a2],
        status: 'present',
        reason: 'Phone battery dead',
      }),
      200,
    );
    expect(res).toMatchObject({ updated: 2, counts: { present: 2, absent: 1, total: 3 } });

    const records = expectStatus(await prof.get(`/v1/sessions/${session.id}/records`), 200);
    expect(records[0]).toMatchObject({ status: 'present', method: 'manual', reason: 'Phone battery dead' });

    const [audit] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'attendance.marked_manually'));
    expect(audit!.data).toMatchObject({ reason: 'Phone battery dead', changes: [{ from: 'absent', to: 'present' }, { from: 'absent', to: 'present' }] });
  });

  it('requires a reason and only accepts students on the list', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const prof = as(ctx.app, c.profTokens);
    expect((await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a1], status: 'present' })).statusCode).toBe(400);
    const outsider = await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.b1], status: 'present', reason: 'Visiting' });
    expect(outsider.json().error).toMatchObject({ code: 'NOT_IN_SESSION', details: { studentIds: [c.students.b1] } });
  });

  it('still works after scanning has closed', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    ctx.advance(60 * 60_000);
    const res = await as(ctx.app, c.profTokens).post(`/v1/sessions/${session.id}/mark`, {
      studentIds: [c.students.a3],
      status: 'excused',
      reason: 'Medical certificate',
    });
    expect(expectStatus(res, 200).counts.excused).toBe(1);
  });
});

describe('closing, extending, cancelling', () => {
  it('close stops scanning; extend re-opens it', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const closed = expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const reopened = expectStatus(await prof.post(`/v1/sessions/${session.id}/extend`, { minutes: 5 }), 200);
    expect(reopened).toMatchObject({ status: 'open', closedAt: null });
  });

  it('cancel keeps the records but marks the session cancelled', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    const cancelled = expectStatus(await prof.post(`/v1/sessions/${session.id}/cancel`, { reason: 'Started for the wrong class' }), 200);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Started for the wrong class', counts: { total: 3 } });
    expect((await prof.post(`/v1/sessions/${session.id}/extend`, { minutes: 5 })).json().error.code).toBe('SESSION_CANCELLED');
    // A cancelled session frees the teacher to start the right one.
    expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
  });

  it('the sweeper closes sessions whose time is up', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await start(c.profTokens, { offeringId: c.offering.id, scanMinutes: 1 }), 201);
    expect(await closeExpiredSessions(ctx.db, ctx.app.live, new Date())).toBe(0);
    expect(await closeExpiredSessions(ctx.db, ctx.app.live, new Date(Date.now() + 2 * 60_000))).toBe(1);
    const after = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/sessions/${session.id}`), 200);
    expect(after.closedAt).toBe(session.closesAt);
  });
});

describe('listing', () => {
  it('filters by status and who started the session', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const first = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);
    await prof.post(`/v1/sessions/${first.id}/close`);
    const second = expectStatus(await start(c.profTokens, { offeringId: c.offering.id }), 201);

    const open = expectStatus(await prof.get('/v1/sessions?status=open'), 200);
    expect(open.items.map((s: { id: string }) => s.id)).toEqual([second.id]);
    const all = expectStatus(await prof.get('/v1/sessions?mine=true'), 200);
    expect(all.total).toBe(2);

    const otherProf = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' }));
    expect(expectStatus(await otherProf.get('/v1/sessions'), 200).total).toBe(0);
    expect((await otherProf.get(`/v1/sessions/${first.id}`)).statusCode).toBe(404);
  });
});
