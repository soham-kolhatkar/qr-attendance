import { isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLogs, refreshTokens } from '../src/db/schema.js';
import { bearer, createPlatformAdmin, createUserAs, login, PASSWORD, setupInstitute, useTestApp } from './helpers.js';

const ctx = useTestApp();

const post = (url: string, payload: object, headers?: Record<string, string>) =>
  ctx.app.inject({ method: 'POST', url, payload, headers });

describe('login', () => {
  it('logs in a platform admin without an institute code', async () => {
    await createPlatformAdmin(ctx.db);
    const res = await post('/v1/auth/login', { username: 'owner', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ username: 'owner', role: 'platform_admin', instituteId: null });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
  });

  it('normalises institute code and username case', async () => {
    await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const res = await post('/v1/auth/login', { instituteCode: 'alpha', username: 'ADMIN', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('admin');
  });

  it('gives the same error for wrong password, unknown user and unknown institute', async () => {
    await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const attempts = [
      { instituteCode: 'ALPHA', username: 'admin', password: 'wrong-password' },
      { instituteCode: 'ALPHA', username: 'nobody', password: PASSWORD },
      { instituteCode: 'NOPE', username: 'admin', password: PASSWORD },
    ];
    for (const payload of attempts) {
      const res = await post('/v1/auth/login', payload);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('does not let an institute user log in as a platform admin (no institute code)', async () => {
    await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const res = await post('/v1/auth/login', { username: 'admin', password: PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  it('rejects disabled users only after the password is proven', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const student = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/users/${student.id}`,
      headers: bearer(admin),
      payload: { status: 'disabled' },
    });

    const wrong = await post('/v1/auth/login', { instituteCode: 'ALPHA', username: 'stu1', password: 'wrong-password' });
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const right = await post('/v1/auth/login', { instituteCode: 'ALPHA', username: 'stu1', password: PASSWORD });
    expect(right.statusCode).toBe(401);
    expect(right.json().error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('records failed and successful logins in the audit log', async () => {
    await setupInstitute(ctx.app, ctx.db);
    await post('/v1/auth/login', { instituteCode: 'ALPHA', username: 'admin', password: 'wrong-password' });
    const actions = (await ctx.db.select({ action: auditLogs.action }).from(auditLogs)).map((r) => r.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.login_failed');
  });

  it('rate-limits repeated attempts on one account', async () => {
    await setupInstitute(ctx.app, ctx.db);
    const payload = { instituteCode: 'ALPHA', username: 'admin', password: 'wrong-password' };
    // setupInstitute already used one attempt for this account.
    for (let i = 0; i < 9; i++) expect((await post('/v1/auth/login', payload)).statusCode).toBe(401);
    const limited = await post('/v1/auth/login', payload);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });

  it('returns a validation error for malformed input', async () => {
    const res = await post('/v1/auth/login', { username: 'a', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('access tokens', () => {
  it('/me returns the user and institute', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'admin' }, institute: { code: 'ALPHA' } });
  });

  it('rejects missing and tampered tokens', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const tampered = { authorization: `Bearer ${admin.accessToken.slice(0, -2)}xx` };
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: tampered });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_INVALID');
  });

  it('stops working immediately when the institute is suspended', async () => {
    const { owner, institute, admin } = await setupInstitute(ctx.app, ctx.db);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/platform/institutes/${institute.id}`,
      headers: bearer(owner),
      payload: { status: 'suspended' },
    });
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(admin) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INSTITUTE_SUSPENDED');
    const relogin = await post('/v1/auth/login', { instituteCode: 'ALPHA', username: 'admin', password: PASSWORD });
    expect(relogin.json().error.code).toBe('INSTITUTE_SUSPENDED');
  });
});

describe('refresh tokens', () => {
  it('rotates: a refresh returns a new pair that works', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await post('/v1/auth/refresh', { refreshToken: admin.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.refreshToken).not.toBe(admin.refreshToken);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(next) })).statusCode).toBe(200);
  });

  it('treats an immediate re-use of a rotated token as a race, not theft', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const next = (await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).json();
    expect((await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).statusCode).toBe(401);
    // The legitimate newer token keeps working.
    expect((await post('/v1/auth/refresh', { refreshToken: next.refreshToken })).statusCode).toBe(200);
  });

  it('revokes the whole login when an old rotated token is replayed later', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const next = (await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).json();
    // Pretend the rotation happened a minute ago (outside the race grace window).
    await ctx.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(isNotNull(refreshTokens.replacedById));

    expect((await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { refreshToken: next.refreshToken })).statusCode).toBe(401);
    const actions = (await ctx.db.select({ action: auditLogs.action }).from(auditLogs)).map((r) => r.action);
    expect(actions).toContain('auth.refresh_reuse_detected');
  });

  it('logout ends the session', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    expect((await post('/v1/auth/logout', { refreshToken: admin.refreshToken })).statusCode).toBe(204);
    expect((await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).statusCode).toBe(401);
  });

  it('rejects unknown and expired tokens', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    expect((await post('/v1/auth/refresh', { refreshToken: 'not-a-real-token' })).statusCode).toBe(401);
    await ctx.db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).statusCode).toBe(401);
  });
});

describe('change password', () => {
  it('requires the current password', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await post(
      '/v1/auth/change-password',
      { currentPassword: 'wrong-password', newPassword: 'brand-new-pass' },
      bearer(admin),
    );
    expect(res.statusCode).toBe(401);
  });

  it('changes the password, clears the must-change flag and signs out other sessions', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await post(
      '/v1/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'brand-new-pass' },
      bearer(admin),
    );
    expect(res.statusCode).toBe(200);

    expect((await post('/v1/auth/refresh', { refreshToken: admin.refreshToken })).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { refreshToken: res.json().refreshToken })).statusCode).toBe(200);
    const relogin = await login(ctx.app, { instituteCode: 'ALPHA', username: 'admin', password: 'brand-new-pass' });
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(relogin) });
    expect(me.json().user.mustChangePassword).toBe(false);
  });
});
