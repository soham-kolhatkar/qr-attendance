import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, loginStudent, setupClass, signedScan, useTestApp } from './helpers.js';

const ctx = useTestApp();
const DAY = 24 * 3600_000;

/** CS301 (prof.a, Div A: ca01–ca03): one finished session where ca01 scanned and the rest are absent. */
async function finishedClass() {
  const c = await setupClass(ctx.app, ctx.db);
  const prof = as(ctx.app, c.profTokens);
  const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
  const ca01 = await loginStudent(ctx.app, 'ca01');
  const { payload } = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200);
  expectStatus(await signedScan(ctx, ca01, payload), 200);
  expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
  const ca02 = await loginStudent(ctx.app, 'ca02');
  return { ...c, prof, sessionId: session.id as string, ca01, ca02, student: as(ctx.app, ca02) };
}

const myRecent = async (api: ReturnType<typeof as>, sessionId: string) =>
  (expectStatus(await api.get('/v1/attendance/mine'), 200).recent as { sessionId: string; canRequest: string[]; correction: { status: string } | null }[]).find(
    (r) => r.sessionId === sessionId,
  )!;

const notificationsOf = async (api: ReturnType<typeof as>) =>
  expectStatus(await api.get('/v1/notifications'), 200) as { items: { kind: string; title: string; body: string; read: boolean; id: string }[]; unread: number };

describe('correction requests', () => {
  it('a student asks, the teacher approves: the mark, reports, the student and the log all follow', async () => {
    const c = await finishedClass();
    expect((await myRecent(c.student, c.sessionId)).canRequest).toEqual(['present', 'excused']);

    const request = expectStatus(
      await c.student.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'My scan failed, I was in the front row' }),
      201,
    );
    expect(request).toMatchObject({ status: 'pending', requestedStatus: 'present' });
    expect(await myRecent(c.student, c.sessionId)).toMatchObject({ canRequest: [], correction: { status: 'pending' } });

    // Who can answer: the teacher, the HOD of the department and admins; not another teacher.
    expect(expectStatus(await c.prof.get('/v1/corrections/pending-count'), 200).count).toBe(1);
    expect(expectStatus(await as(ctx.app, c.admin).get('/v1/corrections/pending-count'), 200).count).toBe(1);
    await createUserAs(ctx.app, c.admin, { role: 'hod', username: 'hod.comp', unitId: c.s.comp });
    const hod = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' }));
    expect(expectStatus(await hod.get('/v1/corrections/pending-count'), 200).count).toBe(1);
    const profB = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' }));
    expect(expectStatus(await profB.get('/v1/corrections/pending-count'), 200).count).toBe(0);
    expectStatus(await profB.post(`/v1/corrections/${request.id}/approve`), 404);

    const list = expectStatus(await c.prof.get('/v1/corrections?status=pending'), 200);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      reason: 'My scan failed, I was in the front row',
      previousStatus: 'absent',
      currentStatus: 'absent',
      student: { username: 'ca02', unitPath: ['Computer Engineering', 'SY', 'Div A'] },
      session: { id: c.sessionId, status: 'closed', subject: { code: 'CS301' }, teacher: 'Prof A' },
    });

    const approved = expectStatus(await c.prof.post(`/v1/corrections/${request.id}/approve`, { note: 'Seen you in class' }), 200);
    expect(approved).toMatchObject({ status: 'approved', currentStatus: 'present', reviewer: { fullName: 'Prof A' }, reviewNote: 'Seen you in class' });
    expectStatus(await c.prof.post(`/v1/corrections/${request.id}/approve`), 409);

    const records = expectStatus(await c.prof.get(`/v1/sessions/${c.sessionId}/records`), 200);
    expect(records.find((r: { username: string }) => r.username === 'ca02')).toMatchObject({
      status: 'present',
      method: 'manual',
      reason: 'Correction request: My scan failed, I was in the front row',
    });
    const report = expectStatus(await c.prof.get('/v1/reports/students?q=ca02'), 200);
    expect(report.items[0]).toMatchObject({ present: 1, total: 1, percentage: 100 });
    expect(await myRecent(c.student, c.sessionId)).toMatchObject({ canRequest: [], correction: { status: 'approved' } });

    const inbox = await notificationsOf(c.student);
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0]).toMatchObject({ kind: 'correction.approved', title: 'Correction approved: CS301' });
    expect(inbox.items[0]!.body).toMatch(/^Prof A changed your mark to present for the Data Structures lecture on .+\n\nSeen you in class$/);

    const log = expectStatus(await as(ctx.app, c.admin).get('/v1/audit?category=attendance'), 200);
    expect(log.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['correction.requested', 'correction.approved']),
    );
    expect(log.items.find((e: { action: string }) => e.action === 'correction.approved').summary).toMatch(
      /^Approved Student ca02’s correction for CS301 on .+: absent → present \(Seen you in class\)$/,
    );
  });

  it('turned down: the student is told why and cannot ask again for that class', async () => {
    const c = await finishedClass();
    const request = expectStatus(
      await c.student.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'excused', reason: 'I was at the doctor' }),
      201,
    );
    expectStatus(await c.prof.post(`/v1/corrections/${request.id}/reject`, { note: 'x' }), 400);
    const rejected = expectStatus(await c.prof.post(`/v1/corrections/${request.id}/reject`, { note: 'Bring the certificate to the office' }), 200);
    expect(rejected).toMatchObject({ status: 'rejected', currentStatus: 'absent', reviewNote: 'Bring the certificate to the office' });

    const inbox = await notificationsOf(c.student);
    expect(inbox.items[0]).toMatchObject({ kind: 'correction.rejected', title: 'Correction turned down: CS301' });
    expect(inbox.items[0]!.body).toMatch(/Bring the certificate to the office$/);

    const again = await c.student.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'Please look again' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CORRECTION_DECIDED');
    expect(expectStatus(await c.prof.get('/v1/corrections?status=rejected'), 200).total).toBe(1);
  });

  it('only for finished classes, within the window, when the mark can go up, one at a time', async () => {
    const c = await finishedClass();
    const ask = (api: ReturnType<typeof as>, body: object) =>
      api.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'My scan failed', ...body });
    const code = async (res: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => (await res).json().error.code;

    expect(await code(ask(as(ctx.app, c.ca01), {}))).toBe('NOTHING_TO_CORRECT'); // already present
    const cb01 = as(ctx.app, await loginStudent(ctx.app, 'cb01'));
    expect((await ask(cb01, {})).statusCode).toBe(404); // not in that class

    const first = expectStatus(await ask(c.student, {}), 201);
    expect(await code(ask(c.student, {}))).toBe('CORRECTION_PENDING');
    expectStatus(await c.student.post(`/v1/corrections/${first.id}/withdraw`), 200);
    expectStatus(await c.student.post(`/v1/corrections/${first.id}/withdraw`), 409);
    expect((await myRecent(c.student, c.sessionId)).canRequest).toEqual(['present', 'excused']);
    expectStatus(await ask(c.student, { requestedStatus: 'excused' }), 201); // asking again after withdrawing is fine

    // Still taking attendance: scan instead.
    const open = expectStatus(await c.prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expect(await code(c.student.post('/v1/corrections', { sessionId: open.id, requestedStatus: 'present', reason: 'My scan failed' }))).toBe(
      'SESSION_STILL_OPEN',
    );
    expectStatus(await c.prof.post(`/v1/sessions/${open.id}/close`), 200);

    // A week later (the default window is 7 days) it's too late.
    ctx.advance(8 * DAY);
    expect((await myRecent(c.student, open.id)).canRequest).toEqual([]);
    expect(await code(c.student.post('/v1/corrections', { sessionId: open.id, requestedStatus: 'present', reason: 'My scan failed' }))).toBe(
      'CORRECTION_TOO_LATE',
    );

    // Institutes can turn requests off.
    expectStatus(await as(ctx.app, c.admin).patch('/v1/settings/attendance', { correctionWindowDays: 0 }), 200);
    const off = await c.student.post('/v1/corrections', { sessionId: open.id, requestedStatus: 'present', reason: 'My scan failed' });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('CORRECTIONS_OFF');
    expect(expectStatus(await c.student.get('/v1/attendance/mine'), 200).correctionWindowDays).toBe(0);

    // Staff can't ask, students can't answer.
    expectStatus(await c.prof.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'x'.repeat(10) }), 403);
    expectStatus(await c.student.get('/v1/corrections'), 403);
  });

  it('marking by hand settles a matching request; cancelling the class closes it', async () => {
    const c = await finishedClass();
    const ca03 = as(ctx.app, await loginStudent(ctx.app, 'ca03'));
    const r2 = expectStatus(await c.student.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'My scan failed' }), 201);
    const r3 = expectStatus(await ca03.post('/v1/corrections', { sessionId: c.sessionId, requestedStatus: 'present', reason: 'My scan failed' }), 201);

    // ca02 marked present (what they asked); ca03 marked excused (not what they asked).
    expectStatus(await c.prof.post(`/v1/sessions/${c.sessionId}/mark`, { studentIds: [c.students.a2], status: 'present', reason: 'Was in class' }), 200);
    expectStatus(await c.prof.post(`/v1/sessions/${c.sessionId}/mark`, { studentIds: [c.students.a3], status: 'excused', reason: 'On duty' }), 200);

    const approved = expectStatus(await c.prof.get('/v1/corrections?status=approved'), 200);
    expect(approved.items).toEqual([expect.objectContaining({ id: r2.id, reviewNote: 'Marked by hand' })]);
    expect((await notificationsOf(c.student)).items[0]).toMatchObject({ kind: 'correction.approved' });
    expect((await notificationsOf(ca03)).items[0]).toMatchObject({ kind: 'attendance.changed', title: 'Attendance changed: CS301' });
    expect((await notificationsOf(ca03)).items[0]!.body).toMatch(/^Prof A marked you excused for the Data Structures lecture on .+\n\nReason: On duty$/);

    expectStatus(await c.prof.post(`/v1/sessions/${c.sessionId}/cancel`, { reason: 'Wrong class' }), 200);
    const withdrawn = expectStatus(await c.prof.get('/v1/corrections?status=withdrawn'), 200);
    expect(withdrawn.items).toEqual([expect.objectContaining({ id: r3.id, reviewNote: 'The class was cancelled' })]);
    expect(expectStatus(await c.prof.get('/v1/corrections/pending-count'), 200).count).toBe(0);
  });
});
