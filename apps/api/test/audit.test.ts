import { describe, expect, it } from 'vitest';
import { as, expectStatus, login, setupClass, setupInstitute, useTestApp } from './helpers.js';

const ctx = useTestApp();

type Entry = { action: string; summary: string; actor: { fullName: string } | null; entity: { type: string; label: string | null } | null };

describe('activity log', () => {
  it('says what happened in words, with names instead of ids, filtered by category, person and thing', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const admin = as(ctx.app, c.admin);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a1, c.students.a2], status: 'present', reason: 'Phones dead' }), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/cancel`, { reason: 'Wrong class' }), 200);
    expectStatus(await admin.patch('/v1/settings/attendance', { minimumPercent: 80, correctionWindowDays: 0 }), 200);
    expectStatus(await admin.patch(`/v1/users/${c.prof.id}`, { status: 'disabled' }), 200);

    const all = expectStatus(await admin.get('/v1/audit?pageSize=100'), 200);
    const find = (action: string) => (all.items as Entry[]).find((e) => e.action === action)!;
    expect(all.items.some((e: Entry) => e.action === 'auth.login')).toBe(false); // sign-ins are a category of their own
    expect(find('session.started')).toMatchObject({ actor: { fullName: 'Prof A' }, entity: { type: 'attendance_session' } });
    expect(find('session.started').summary).toMatch(/^Started CS301 on .+ for 3 students$/);
    expect(find('attendance.marked_manually').summary).toMatch(/^Marked Student ca01, Student ca02 present by hand in CS301 on .+: Phones dead$/);
    expect(find('session.cancelled').summary).toMatch(/^Cancelled CS301 on .+: Wrong class$/);
    expect(find('settings.attendance_updated').summary).toBe('Changed attendance settings: minimum attendance 80%, correction requests off');
    expect(find('user.updated').summary).toBe('Disabled Prof A’s account');
    expect(find('subject.created').summary).toBe('Created the subject CS301 Data Structures');
    expect(find('structure.unit_created').summary).toBe('Created Division Mechanical Engineering › SY › Div A') // the newest first;
    expect(find('offering.created').summary).toBe('Set up CS301 (Odd)');

    const attendance = expectStatus(await admin.get('/v1/audit?category=attendance'), 200);
    expect(new Set(attendance.items.map((e: Entry) => e.action))).toEqual(
      new Set(['session.started', 'attendance.marked_manually', 'session.cancelled']),
    );
    const signIns = expectStatus(await admin.get('/v1/audit?category=security'), 200);
    expect(signIns.items.every((e: Entry) => e.action.startsWith('auth.'))).toBe(true);
    expect(signIns.items[0].summary).toBe('Signed in');

    const byProf = expectStatus(await admin.get(`/v1/audit?actorId=${c.prof.id}`), 200);
    expect(byProf.total).toBe(3);
    const aboutSession = expectStatus(await admin.get(`/v1/audit?entityType=attendance_session&entityId=${session.id}`), 200);
    expect(aboutSession.total).toBe(3);

    // Admins only; another institute's log is never mixed in.
    expectStatus(await as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' })).get('/v1/audit'), 403);
    const other = await setupInstitute(ctx.app, ctx.db, 'BETA');
    const beta = expectStatus(await as(ctx.app, other.admin).get('/v1/audit?pageSize=100'), 200);
    expect(beta.items.every((e: Entry) => !e.action.startsWith('session.'))).toBe(true);

    // The platform owner sees every institute, labelled, or one at a time.
    const owner = as(ctx.app, other.owner);
    const everything = expectStatus(await owner.get('/v1/audit?category=settings&pageSize=100'), 200);
    expect(new Set(everything.items.map((e: { institute: { name: string } }) => e.institute.name))).toEqual(new Set(['ALPHA College', 'BETA College']));
    const onlyBeta = expectStatus(await owner.get(`/v1/audit?category=settings&instituteId=${other.institute.id}`), 200);
    expect(onlyBeta.items.map((e: Entry) => e.summary)).toEqual(['Created the institute BETA College']);
  });
});
