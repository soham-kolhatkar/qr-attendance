import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, setupInstitute, setupStructure, type Tokens, useTestApp } from './helpers.js';

const ctx = useTestApp();

/** Structure + term + subjects + two faculty + students spread over the classes. */
async function setup() {
  const { admin } = await setupInstitute(ctx.app, ctx.db);
  const s = await setupStructure(ctx.app, admin);
  const api = as(ctx.app, admin);
  const term = expectStatus(await api.post('/v1/terms', { name: 'Odd', startsOn: '2026-07-01', endsOn: '2026-11-30' }), 201);
  const ds = expectStatus(await api.post('/v1/subjects', { code: 'CS301', name: 'Data Structures', unitId: s.comp }), 201);
  const lab = expectStatus(await api.post('/v1/subjects', { code: 'CS302L', name: 'DBMS Lab', unitId: s.comp }), 201);
  const profA = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
  const profB = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.b' });

  const stu = async (username: string, unitId: string, rollNo: string, groupIds: string[] = []) =>
    (await createUserAs(ctx.app, admin, { role: 'student', username, unitId, rollNo, groupIds })).id;
  const students = {
    a1: await stu('ca01', s.compA, '1', [s.a1]),
    a2: await stu('ca02', s.compA, '2', [s.a2]),
    b1: await stu('cb01', s.compB, '1'),
    m1: await stu('ma01', s.mechA, '1'),
  };
  return { admin, api, s, term, ds, lab, profA, profB, students };
}

const create = async (tokens: Tokens, body: object) => as(ctx.app, tokens).post('/v1/offerings', body);
const rosterOf = async (tokens: Tokens, id: string) =>
  expectStatus(await as(ctx.app, tokens).get(`/v1/offerings/${id}/students`), 200).map((r: { username: string }) => r.username);

describe('offerings', () => {
  it('creates an offering for a class and resolves its roster', async () => {
    const { admin, s, term, ds, profA } = await setup();
    const offering = expectStatus(
      await create(admin, { termId: term.id, subjectId: ds.id, facultyIds: [profA.id], audience: { unitIds: [s.compA] } }),
      201,
    );
    expect(offering).toMatchObject({
      subject: { code: 'CS301' },
      faculty: [{ username: 'prof.a' }],
      audience: { units: [{ name: 'Div A', path: ['Computer Engineering', 'SY', 'Div A'] }], groups: [] },
    });
    expect(await rosterOf(admin, offering.id)).toEqual(['ca01', 'ca02']);
    expect(expectStatus(await as(ctx.app, admin).get(`/v1/offerings/${offering.id}`), 200).studentCount).toBe(2);
  });

  it('a batch audience includes only its members; a year audience includes every division', async () => {
    const { admin, s, term, lab, ds } = await setup();
    const labOffering = expectStatus(await create(admin, { termId: term.id, subjectId: lab.id, audience: { groupIds: [s.a1] } }), 201);
    expect(await rosterOf(admin, labOffering.id)).toEqual(['ca01']);

    const yearOffering = expectStatus(await create(admin, { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.compSy] } }), 201);
    expect(await rosterOf(admin, yearOffering.id)).toEqual(['ca01', 'ca02', 'cb01']);
  });

  it('combines units and groups without duplicates, and leaves out disabled students', async () => {
    const { admin, api, s, term, ds, students } = await setup();
    const o = expectStatus(
      await create(admin, { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.compA, s.mechA], groupIds: [s.a1] } }),
      201,
    );
    expect(await rosterOf(admin, o.id)).toEqual(['ca01', 'ca02', 'ma01']);
    await api.patch(`/v1/users/${students.a2}`, { status: 'disabled' });
    expect(await rosterOf(admin, o.id)).toEqual(['ca01', 'ma01']);
  });

  it('validates the audience, teachers, term and subject', async () => {
    const { admin, s, term, ds, students } = await setup();
    const base = { termId: term.id, subjectId: ds.id };
    expect((await create(admin, { ...base, audience: {} })).statusCode).toBe(400);
    expect((await create(admin, { ...base, facultyIds: [students.a1], audience: { unitIds: [s.compA] } })).json().error.code).toBe(
      'INVALID_FACULTY',
    );
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await create(admin, { ...base, audience: { unitIds: [missing] } })).json().error.code).toBe('UNKNOWN_UNITS');
    expect((await create(admin, { termId: missing, subjectId: ds.id, audience: { unitIds: [s.compA] } })).statusCode).toBe(404);
  });

  it('shows faculty only the offerings they teach', async () => {
    const { admin, s, term, ds, lab, profA, profB } = await setup();
    const mine = expectStatus(await create(admin, { termId: term.id, subjectId: ds.id, facultyIds: [profA.id], audience: { unitIds: [s.compA] } }), 201);
    const theirs = expectStatus(await create(admin, { termId: term.id, subjectId: lab.id, facultyIds: [profB.id], audience: { groupIds: [s.a1] } }), 201);
    const prof = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' }));

    const list = expectStatus(await prof.get('/v1/offerings'), 200);
    expect(list.items.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    expect((await prof.get(`/v1/offerings/${theirs.id}`)).statusCode).toBe(404);
    expect((await prof.get(`/v1/offerings/${mine.id}/students`)).statusCode).toBe(200);
    expect((await prof.post('/v1/offerings', { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.compA] } })).statusCode).toBe(403);

    const adminMine = expectStatus(await as(ctx.app, admin).get(`/v1/offerings?facultyId=${profB.id}`), 200);
    expect(adminMine.items.map((o: { id: string }) => o.id)).toEqual([theirs.id]);
  });

  it('lets a HOD manage offerings for their department only', async () => {
    const { admin, s, term, ds } = await setup();
    await createUserAs(ctx.app, admin, { role: 'hod', username: 'hod.comp', unitId: s.comp });
    const mechOffering = expectStatus(await create(admin, { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.mechA] } }), 201);
    const hodTokens = await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' });
    const hod = as(ctx.app, hodTokens);

    const own = expectStatus(await create(hodTokens, { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.compB], groupIds: [s.a2] } }), 201);
    expect((await create(hodTokens, { termId: term.id, subjectId: ds.id, audience: { unitIds: [s.mechA] } })).statusCode).toBe(403);

    const visible = expectStatus(await hod.get('/v1/offerings'), 200).items.map((o: { id: string }) => o.id);
    expect(visible).toEqual([own.id]);
    expect((await hod.patch(`/v1/offerings/${mechOffering.id}`, { facultyIds: [] })).statusCode).toBe(403);
    expect((await hod.patch(`/v1/offerings/${own.id}`, { audience: { unitIds: [s.mechA] } })).statusCode).toBe(403);
  });

  it('replaces teachers and audience, and deletes', async () => {
    const { admin, api, s, term, ds, profA, profB } = await setup();
    const o = expectStatus(await create(admin, { termId: term.id, subjectId: ds.id, facultyIds: [profA.id], audience: { unitIds: [s.compA] } }), 201);
    const updated = expectStatus(await api.patch(`/v1/offerings/${o.id}`, { facultyIds: [profB.id], audience: { unitIds: [s.compB] } }), 200);
    expect(updated.faculty.map((f: { username: string }) => f.username)).toEqual(['prof.b']);
    expect(await rosterOf(admin, o.id)).toEqual(['cb01']);

    // Groups and terms in use cannot be deleted while the offering exists.
    const labO = expectStatus(await create(admin, { termId: term.id, subjectId: ds.id, audience: { groupIds: [s.a1] } }), 201);
    expect((await api.delete(`/v1/groups/${s.a1}`)).json().error.code).toBe('GROUP_IN_USE');
    expect((await api.delete(`/v1/terms/${term.id}`)).json().error.code).toBe('TERM_IN_USE');
    expect((await api.delete(`/v1/subjects/${ds.id}`)).json().error.code).toBe('SUBJECT_IN_USE');

    expectStatus(await api.delete(`/v1/offerings/${o.id}`), 204);
    expectStatus(await api.delete(`/v1/offerings/${labO.id}`), 204);
    expectStatus(await api.delete(`/v1/groups/${s.a1}`), 204);
  });
});
