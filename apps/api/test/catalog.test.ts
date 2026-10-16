import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, setupInstitute, setupStructure, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('terms', () => {
  it('creates, lists newest first, updates and deletes', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const odd = expectStatus(await api.post('/v1/terms', { name: '2026-27 Odd', startsOn: '2026-07-01', endsOn: '2026-11-30' }), 201);
    expectStatus(await api.post('/v1/terms', { name: '2026-27 Even', startsOn: '2027-01-01', endsOn: '2027-05-31' }), 201);
    const list = expectStatus(await api.get('/v1/terms'), 200);
    expect(list.map((t: { name: string }) => t.name)).toEqual(['2026-27 Even', '2026-27 Odd']);

    expectStatus(await api.patch(`/v1/terms/${odd.id}`, { endsOn: '2026-12-15' }), 200);
    expectStatus(await api.delete(`/v1/terms/${odd.id}`), 204);
  });

  it('validates dates and name uniqueness', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const api = as(ctx.app, admin);
    const backwards = await api.post('/v1/terms', { name: 'T', startsOn: '2026-07-01', endsOn: '2026-06-01' });
    expect(backwards.json().error.code).toBe('INVALID_DATES');
    expect((await api.post('/v1/terms', { name: 'T', startsOn: '2026-13-01', endsOn: '2026-12-01' })).statusCode).toBe(400);

    const t = expectStatus(await api.post('/v1/terms', { name: 'Term 1', startsOn: '2026-07-01', endsOn: '2026-11-30' }), 201);
    expect((await api.post('/v1/terms', { name: 'TERM 1', startsOn: '2026-07-01', endsOn: '2026-11-30' })).statusCode).toBe(409);
    // Moving only the start past the existing end is caught too.
    expect((await api.patch(`/v1/terms/${t.id}`, { startsOn: '2026-12-01' })).json().error.code).toBe('INVALID_DATES');
  });
});

describe('subjects', () => {
  it('creates and searches subjects; codes are unique regardless of case', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    const api = as(ctx.app, admin);
    const ds = expectStatus(await api.post('/v1/subjects', { code: 'CS301', name: 'Data Structures', unitId: s.comp }), 201);
    expect(ds.unitPath).toEqual(['Computer Engineering']);
    expectStatus(await api.post('/v1/subjects', { code: 'ME201', name: 'Thermodynamics', unitId: s.mech }), 201);
    expect((await api.post('/v1/subjects', { code: 'cs301', name: 'Dup' })).json().error.code).toBe('SUBJECT_CODE_TAKEN');

    const comp = expectStatus(await api.get(`/v1/subjects?unitId=${s.comp}`), 200);
    expect(comp.map((x: { code: string }) => x.code)).toEqual(['CS301']);
    const search = expectStatus(await api.get('/v1/subjects?q=thermo'), 200);
    expect(search.map((x: { code: string }) => x.code)).toEqual(['ME201']);
  });

  it("lets a HOD manage only their department's subjects", async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    await createUserAs(ctx.app, admin, { role: 'hod', username: 'hod.comp', unitId: s.comp });
    const mechSubject = expectStatus(await as(ctx.app, admin).post('/v1/subjects', { code: 'ME201', name: 'Thermo', unitId: s.mech }), 201);
    const hod = as(ctx.app, await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' }));

    expectStatus(await hod.post('/v1/subjects', { code: 'CS999', name: 'Seminar', unitId: s.comp }), 201);
    expect((await hod.post('/v1/subjects', { code: 'ME999', name: 'X', unitId: s.mech })).statusCode).toBe(403);
    expect((await hod.post('/v1/subjects', { code: 'GEN1', name: 'X' })).statusCode).toBe(403);
    expect((await hod.patch(`/v1/subjects/${mechSubject.id}`, { name: 'Y' })).statusCode).toBe(403);
  });
});
