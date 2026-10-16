import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, setupInstitute, setupStructure, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('structure levels', () => {
  it('adds levels top-down, renames and lists them in order', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const dept = expectStatus(await api.post('/v1/structure/levels', { name: 'Department' }), 201);
    const year = expectStatus(await api.post('/v1/structure/levels', { name: 'Year' }), 201);
    expect([dept.depth, year.depth]).toEqual([0, 1]);

    expectStatus(await api.patch(`/v1/structure/levels/${year.id}`, { name: 'Class' }), 200);
    const { levels } = expectStatus(await api.get('/v1/structure'), 200);
    expect(levels.map((l: { name: string }) => l.name)).toEqual(['Department', 'Class']);
  });

  it('rejects duplicate level names regardless of case', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    await api.post('/v1/structure/levels', { name: 'Year' });
    const res = await api.post('/v1/structure/levels', { name: 'YEAR' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LEVEL_NAME_TAKEN');
  });

  it('only removes the lowest level, and only when no unit uses it', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const s = await setupStructure(ctx.app, admin);
    const { levels } = expectStatus(await api.get('/v1/structure'), 200);

    const notLowest = await api.delete(`/v1/structure/levels/${levels[0].id}`);
    expect(notLowest.json().error.code).toBe('NOT_DEEPEST_LEVEL');
    const inUse = await api.delete(`/v1/structure/levels/${levels[2].id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error.code).toBe('LEVEL_IN_USE');

    for (const id of [s.a1, s.a2]) expectStatus(await api.delete(`/v1/groups/${id}`), 204);
    for (const id of [s.compA, s.compB, s.mechA]) expectStatus(await api.delete(`/v1/structure/units/${id}`), 204);
    expectStatus(await api.delete(`/v1/structure/levels/${levels[2].id}`), 204);
  });

  it('caps the number of levels', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    for (let i = 0; i < 8; i++) expectStatus(await api.post('/v1/structure/levels', { name: `L${i}` }), 201);
    expect((await api.post('/v1/structure/levels', { name: 'L8' })).json().error.code).toBe('TOO_MANY_LEVELS');
  });
});

describe('units', () => {
  it('builds a tree where each unit sits at the level below its parent', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    const { levels, units } = expectStatus(await as(ctx.app, admin).get('/v1/structure'), 200);
    const byId = new Map(units.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(s.comp)).toMatchObject({ depth: 0, parentId: null, levelId: levels[0].id });
    expect(byId.get(s.compA)).toMatchObject({ depth: 2, parentId: s.compSy, levelId: levels[2].id });
  });

  it('requires a level to exist for the new depth', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    expect((await api.post('/v1/structure/units', { name: 'COMP' })).json().error.code).toBe('NO_LEVEL_DEFINED');
    const s = await setupStructure(ctx.app, admin);
    const tooDeep = await api.post('/v1/structure/units', { name: 'Batch X', parentId: s.compA });
    expect(tooDeep.json().error.code).toBe('NO_LEVEL_DEFINED');
  });

  it('keeps sibling names unique, but allows the same name under different parents', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const s = await setupStructure(ctx.app, admin); // both COMP and MECH have an "SY" and a "Div A"
    const dup = await api.post('/v1/structure/units', { name: 'div a', parentId: s.compSy });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('UNIT_NAME_TAKEN');
    const rootDup = await api.post('/v1/structure/units', { name: 'COMPUTER ENGINEERING' });
    expect(rootDup.statusCode).toBe(409);
  });

  it('renames units and refuses to delete ones still in use', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const s = await setupStructure(ctx.app, admin);
    const renamed = expectStatus(await api.patch(`/v1/structure/units/${s.compB}`, { name: 'Div B (Evening)', code: 'SYB' }), 200);
    expect(renamed).toMatchObject({ name: 'Div B (Evening)', code: 'SYB' });

    const hasChildren = await api.delete(`/v1/structure/units/${s.compSy}`);
    expect(hasChildren.json().error.code).toBe('UNIT_IN_USE');
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compB });
    expect((await api.delete(`/v1/structure/units/${s.compB}`)).json().error.code).toBe('UNIT_IN_USE');
  });

  it('reports direct and total student counts', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', unitId: s.compA });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu2', unitId: s.compA });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu3', unitId: s.compB });
    const { units } = expectStatus(await as(ctx.app, admin).get('/v1/structure'), 200);
    const byId = new Map(units.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(s.compA)).toMatchObject({ studentCount: 2, totalStudentCount: 2 });
    expect(byId.get(s.comp)).toMatchObject({ studentCount: 0, totalStudentCount: 3 });
    expect(byId.get(s.mech)).toMatchObject({ totalStudentCount: 0 });
  });

  it('is readable by staff but managed only by admins, and is per institute', async () => {
    const a = await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const b = await setupInstitute(ctx.app, ctx.db, 'BETA');
    const s = await setupStructure(ctx.app, a.admin);
    await createUserAs(ctx.app, a.admin, { role: 'faculty', username: 'prof.a' });
    await createUserAs(ctx.app, a.admin, { role: 'student', username: 'stu1', unitId: s.compA });
    const faculty = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' }));
    const student = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'stu1' }));

    expect((await faculty.get('/v1/structure')).statusCode).toBe(200);
    expect((await faculty.post('/v1/structure/units', { name: 'X' })).statusCode).toBe(403);
    expect((await student.get('/v1/structure')).statusCode).toBe(403);

    const beta = as(ctx.app, b.admin);
    expect(expectStatus(await beta.get('/v1/structure'), 200).units).toEqual([]);
    await beta.post('/v1/structure/levels', { name: 'Department' });
    await beta.post('/v1/structure/levels', { name: 'Year' });
    // Beta cannot attach a unit under Alpha's department.
    expect((await beta.post('/v1/structure/units', { name: 'SY', parentId: s.comp })).statusCode).toBe(404);
    expect((await beta.delete(`/v1/structure/units/${s.compA}`)).statusCode).toBe(404);
  });
});
