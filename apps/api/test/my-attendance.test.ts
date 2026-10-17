import { describe, expect, it } from 'vitest';
import { as, expectStatus, loginStudent, setupClass, signedScan, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe("a student's own attendance", () => {
  it('counts finished sessions per subject; excused absences count neither way', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const student = await loginStudent(ctx.app, 'ca01');

    // A second subject for the same class.
    const lab = expectStatus(await as(ctx.app, c.admin).post('/v1/subjects', { code: 'CS302L', name: 'DBMS Lab' }), 201);
    const labOffering = expectStatus(
      await as(ctx.app, c.admin).post('/v1/offerings', {
        termId: c.term.id,
        subjectId: lab.id,
        facultyIds: [c.prof.id],
        audience: { unitIds: [c.s.compA] },
      }),
      201,
    );

    const run = async (offeringId: string, mark: (sessionId: string) => Promise<void>, end: 'close' | 'cancel' = 'close') => {
      const session = expectStatus(await prof.post('/v1/sessions', { offeringId, topic: 'Topic' }), 201);
      await mark(session.id);
      if (end === 'close') expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
      else expectStatus(await prof.post(`/v1/sessions/${session.id}/cancel`, { reason: 'Holiday declared' }), 200);
      return session.id as string;
    };
    const scanned = async (id: string) => {
      const { payload } = expectStatus(await prof.get(`/v1/sessions/${id}/qr`), 200);
      expectStatus(await signedScan(ctx, student, payload), 200);
    };
    const absent = async () => {};
    const excused = async (id: string) => {
      expectStatus(await prof.post(`/v1/sessions/${id}/mark`, { studentIds: [c.students.a1], status: 'excused', reason: 'Medical certificate' }), 200);
    };

    await run(c.offering.id, scanned);
    await run(c.offering.id, scanned);
    await run(c.offering.id, absent);
    await run(c.offering.id, excused);
    await run(c.offering.id, scanned, 'cancel'); // doesn't count at all
    await run(labOffering.id, absent);
    const live = expectStatus(await prof.post('/v1/sessions', { offeringId: labOffering.id }), 201); // still open

    const mine = expectStatus(await as(ctx.app, student).get('/v1/attendance/mine'), 200);
    expect(mine.term).toEqual({ id: c.term.id, name: 'Odd' });
    expect(mine.subjects).toEqual([
      { offeringId: c.offering.id, subject: { code: 'CS301', name: 'Data Structures' }, present: 2, absent: 1, excused: 1, total: 4, percentage: 66.7 },
      { offeringId: labOffering.id, subject: { code: 'CS302L', name: 'DBMS Lab' }, present: 0, absent: 1, excused: 0, total: 1, percentage: 0 },
    ]);
    expect(mine.overall).toEqual({ present: 2, absent: 2, excused: 1, total: 5, percentage: 50 });
    expect(mine.recent).toHaveLength(6);
    expect(mine.recent[0]).toMatchObject({ sessionId: live.id, open: true, status: 'absent', subject: { code: 'CS302L' } });
    expect(mine.recent.filter((r: { open: boolean }) => !r.open).map((r: { status: string }) => r.status)).toEqual([
      'absent',
      'excused',
      'absent',
      'present',
      'present',
    ]);

    // Nobody else's records leak in.
    const other = expectStatus(await as(ctx.app, await loginStudent(ctx.app, 'cb01')).get('/v1/attendance/mine'), 200);
    expect(other).toMatchObject({ term: null, terms: [], subjects: [], recent: [], overall: { total: 0, percentage: null } });
  });

  it('is for students only', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    expect((await as(ctx.app, c.profTokens).get('/v1/attendance/mine')).statusCode).toBe(403);
  });
});
