import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, setupInstitute, setupStructure, useTestApp } from './helpers.js';

const ctx = useTestApp();

async function setup() {
  const { admin } = await setupInstitute(ctx.app, ctx.db);
  const s = await setupStructure(ctx.app, admin);
  return { admin, api: as(ctx.app, admin), s };
}

describe('students', () => {
  it('creates a student in a class with groups', async () => {
    const { api, s } = await setup();
    const res = await api.post('/v1/students', {
      username: '2024COMP007',
      fullName: 'Asha Patil',
      unitId: s.compA,
      rollNo: '7',
      groupIds: [s.a1],
    });
    const { student, temporaryPassword } = expectStatus(res, 201);
    expect(student).toMatchObject({
      username: '2024comp007',
      rollNo: '7',
      unitPath: ['Computer Engineering', 'SY', 'Div A'],
      groups: [{ name: 'A1', kind: 'batch' }],
    });
    expect(temporaryPassword).toBeTypeOf('string');
  });

  it("refuses a group from another class", async () => {
    const { api, s } = await setup();
    const res = await api.post('/v1/students', { username: 'stu1', fullName: 'X', unitId: s.compB, groupIds: [s.a1] });
    expect(res.json().error.code).toBe('GROUP_OUTSIDE_STUDENT_UNIT');
  });

  it('filters by unit (including units below), group and search, in roll-number order', async () => {
    const { admin, api, s } = await setup();
    await createUserAs(ctx.app, admin, { role: 'student', username: 'a10', fullName: 'Tanvi', unitId: s.compA, rollNo: '10', groupIds: [s.a2] });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'a02', fullName: 'Rahul', unitId: s.compA, rollNo: '2', groupIds: [s.a1] });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'b01', fullName: 'Ishaan', unitId: s.compB, rollNo: '1' });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'm01', fullName: 'Neha', unitId: s.mechA, rollNo: '1' });

    const names = async (q: string) =>
      expectStatus(await api.get(`/v1/students?${q}`), 200).items.map((i: { username: string }) => i.username);
    expect(await names(`unitId=${s.compA}`)).toEqual(['a02', 'a10']);
    expect(await names(`unitId=${s.comp}`)).toHaveLength(3);
    expect(await names(`groupId=${s.a1}`)).toEqual(['a02']);
    expect(await names('q=neha')).toEqual(['m01']);
    expect(await names('')).toEqual(['a02', 'a10', 'b01', 'm01']);
  });

  it('moving to another class drops groups the new class cannot have', async () => {
    const { admin, api, s } = await setup();
    const stu = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compA, groupIds: [s.a1] });
    const moved = expectStatus(await api.patch(`/v1/students/${stu.id}`, { unitId: s.compB, rollNo: '31' }), 200);
    expect(moved).toMatchObject({ unitId: s.compB, rollNo: '31', groups: [] });
  });

  it('replaces groups when given', async () => {
    const { admin, api, s } = await setup();
    const stu = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compA, groupIds: [s.a1] });
    const updated = expectStatus(await api.patch(`/v1/students/${stu.id}`, { groupIds: [s.a2] }), 200);
    expect(updated.groups.map((g: { name: string }) => g.name)).toEqual(['A2']);
  });

  it("limits a HOD to their department's students", async () => {
    const { admin, s } = await setup();
    await createUserAs(ctx.app, admin, { role: 'hod', username: 'hod.mech', unitId: s.mech });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'c01', unitId: s.compA });
    const mechStudent = await createUserAs(ctx.app, admin, { role: 'student', username: 'm01', unitId: s.mechA });
    const compStudent = await createUserAs(ctx.app, admin, { role: 'student', username: 'c02', unitId: s.compA });
    const hod = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.mech' }));

    const list = expectStatus(await hod.get('/v1/students'), 200);
    expect(list.items.map((i: { username: string }) => i.username)).toEqual(['m01']);
    expect((await hod.get(`/v1/students/${mechStudent.id}`)).statusCode).toBe(200);
    expect((await hod.get(`/v1/students/${compStudent.id}`)).statusCode).toBe(403);
    expect((await hod.patch(`/v1/students/${mechStudent.id}`, { rollNo: '5' })).statusCode).toBe(403);
  });

  it('shows a student their class and groups on /me', async () => {
    const { admin, s } = await setup();
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compA, rollNo: '4', groupIds: [s.a2] });
    const me = expectStatus(await as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'stu1' })).get('/v1/me'), 200);
    expect(me.student).toMatchObject({ unitPath: ['Computer Engineering', 'SY', 'Div A'], rollNo: '4', groups: [{ name: 'A2' }] });
    expect(me.staff).toBeNull();
  });
});

describe('staff profiles', () => {
  it('requires a department for HODs and shows it on /me', async () => {
    const { api, s } = await setup();
    const noUnit = await api.post('/v1/users', { role: 'hod', username: 'hod.x', fullName: 'X' });
    expect(noUnit.json().error.code).toBe('HOD_NEEDS_UNIT');

    const { user } = expectStatus(
      await api.post('/v1/users', { role: 'hod', username: 'hod.comp', fullName: 'Dr K', unitId: s.comp, password: 'long-enough-1' }),
      201,
    );
    expect(user).toMatchObject({ unitId: s.comp });
    const me = expectStatus(
      await as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp', password: 'long-enough-1' })).get('/v1/me'),
      200,
    );
    expect(me.staff).toMatchObject({ unitId: s.comp, unitPath: ['Computer Engineering'] });
  });

  it('cannot promote a faculty member to HOD without a department', async () => {
    const { admin, api } = await setup();
    const prof = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    expect((await api.patch(`/v1/users/${prof.id}`, { role: 'hod' })).json().error.code).toBe('HOD_NEEDS_UNIT');
  });

  it('sets department and designation on staff', async () => {
    const { admin, api, s } = await setup();
    const prof = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const updated = expectStatus(await api.patch(`/v1/users/${prof.id}`, { unitId: s.mech, designation: 'Professor' }), 200);
    expect(updated).toMatchObject({ unitId: s.mech, designation: 'Professor' });
    expectStatus(await api.patch(`/v1/users/${prof.id}`, { role: 'hod' }), 200);
  });

  it('never converts between student and staff accounts', async () => {
    const { admin, api, s } = await setup();
    const stu = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compA });
    expect((await api.patch(`/v1/users/${stu.id}`, { role: 'faculty' })).json().error.code).toBe('ROLE_CHANGE_NOT_ALLOWED');
    expect((await api.patch(`/v1/users/${stu.id}`, { unitId: s.compB })).json().error.code).toBe('USE_STUDENTS_API');
  });
});
