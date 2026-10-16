import { describe, expect, it } from 'vitest';
import { bearer, createPlatformAdmin, login, setupInstitute, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('institute onboarding (platform admin)', () => {
  it('creates an institute and its first admin with a temporary password', async () => {
    await createPlatformAdmin(ctx.db);
    const owner = await login(ctx.app, { username: 'owner' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/institutes',
      headers: bearer(owner),
      payload: { code: 'mit-wpu', name: 'MIT World Peace University', admin: { username: 'it.admin', fullName: 'IT Admin' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.institute).toMatchObject({ code: 'MIT-WPU', status: 'active' });
    expect(body.admin).toMatchObject({ role: 'admin', instituteId: body.institute.id, mustChangePassword: true });

    await login(ctx.app, { instituteCode: 'MIT-WPU', username: 'it.admin', password: body.temporaryPassword });
  });

  it('rejects a duplicate institute code', async () => {
    const { owner } = await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/platform/institutes',
      headers: bearer(owner),
      payload: { code: 'alpha', name: 'Another', admin: { username: 'admin2', fullName: 'Admin' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSTITUTE_CODE_TAKEN');
  });

  it('is only available to platform admins', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/platform/institutes', headers: bearer(admin) });
    expect(res.statusCode).toBe(403);
  });

  it('lists and searches institutes', async () => {
    const { owner } = await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    await setupInstitute(ctx.app, ctx.db, 'BETA');
    const all = await ctx.app.inject({ method: 'GET', url: '/v1/platform/institutes', headers: bearer(owner) });
    expect(all.json().total).toBe(2);
    const search = await ctx.app.inject({ method: 'GET', url: '/v1/platform/institutes?q=beta', headers: bearer(owner) });
    expect(search.json().items.map((i: { code: string }) => i.code)).toEqual(['BETA']);
  });

  it('returns 404 when updating an unknown institute', async () => {
    const { owner } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/platform/institutes/00000000-0000-4000-8000-000000000000',
      headers: bearer(owner),
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('system endpoints', () => {
  it('health check reports ok', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('serves an OpenAPI spec covering every route', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/v1/auth/login',
        '/v1/auth/refresh',
        '/v1/me',
        '/v1/platform/institutes',
        '/v1/users/',
        '/v1/users/{id}',
      ]),
    );
  });
});
