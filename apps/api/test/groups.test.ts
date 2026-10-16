import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, setupInstitute, setupStructure, useTestApp } from './helpers.js';

const ctx = useTestApp();

async function setup() {
  const { admin } = await setupInstitute(ctx.app, ctx.db);
  const s = await setupStructure(ctx.app, admin);
  return { admin, api: as(ctx.app, admin), s };
}

describe('groups', () => {
  it('creates groups under a unit and lists them with their place in the structure', async () => {
    const { api, s } = await setup();
    const elective = expectStatus(await api.post('/v1/groups', { name: 'ML Elective', kind: 'Elective', unitId: s.compSy }), 201);
    expect(elective).toMatchObject({ kind: 'elective', unitPath: ['Computer Engineering', 'SY'], memberCount: 0 });

    const underDivA = expectStatus(await api.get(`/v1/groups?unitId=${s.compA}`), 200);
    expect(underDivA.map((g: { name: string }) => g.name)).toEqual(['A1', 'A2']);
    const underComp = expectStatus(await api.get(`/v1/groups?unitId=${s.comp}`), 200);
    expect(underComp).toHaveLength(3);
  });

  it('keeps names unique within a unit only', async () => {
    const { api, s } = await setup();
    expect((await api.post('/v1/groups', { name: 'a1', unitId: s.compA })).json().error.code).toBe('GROUP_NAME_TAKEN');
    expectStatus(await api.post('/v1/groups', { name: 'A1', unitId: s.compB }), 201);
  });

  it('only accepts members from its unit or below', async () => {
    const { admin, api, s } = await setup();
    const inA = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu.a', unitId: s.compA, rollNo: '2' });
    const inA2 = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu.a2', unitId: s.compA, rollNo: '10' });
    const inB = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu.b', unitId: s.compB });

    const wrong = await api.post(`/v1/groups/${s.a1}/members`, { add: [inA.id, inB.id] });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatchObject({ code: 'STUDENT_OUTSIDE_GROUP_UNIT', details: { studentIds: [inB.id] } });

    expect(expectStatus(await api.post(`/v1/groups/${s.a1}/members`, { add: [inA2.id, inA.id] }), 200).memberCount).toBe(2);
    const members = expectStatus(await api.get(`/v1/groups/${s.a1}/members`), 200);
    expect(members.map((m: { username: string }) => m.username)).toEqual(['stu.a', 'stu.a2']); // roll 2 before 10

    expect(expectStatus(await api.post(`/v1/groups/${s.a1}/members`, { remove: [inA.id] }), 200).memberCount).toBe(1);
  });

  it('rejects unknown student ids', async () => {
    const { api, s } = await setup();
    const res = await api.post(`/v1/groups/${s.a1}/members`, { add: ['00000000-0000-4000-8000-000000000000'] });
    expect(res.json().error.code).toBe('UNKNOWN_STUDENTS');
  });

  it('lets a HOD manage groups in their department only', async () => {
    const { admin, s } = await setup();
    await createUserAs(ctx.app, admin, { role: 'hod', username: 'hod.comp', unitId: s.comp });
    const hod = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' }));

    expectStatus(await hod.post('/v1/groups', { name: 'A3', unitId: s.compA }), 201);
    expect((await hod.post('/v1/groups', { name: 'M1', unitId: s.mechA })).statusCode).toBe(403);
    expect((await hod.post('/v1/groups', { name: 'Everyone' })).statusCode).toBe(403);
    expectStatus(await hod.patch(`/v1/groups/${s.a1}`, { name: 'A1 (Morning)' }), 200);
  });

  it('is read-only for faculty', async () => {
    const { admin, s } = await setup();
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const faculty = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' }));
    expect((await faculty.get('/v1/groups')).statusCode).toBe(200);
    expect((await faculty.post('/v1/groups', { name: 'X', unitId: s.compA })).statusCode).toBe(403);
  });
});
