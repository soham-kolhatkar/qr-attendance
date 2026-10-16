import { describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema.js';
import { bearer, createUserAs, login, PASSWORD, setupInstitute, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('user management (institute admin)', () => {
  it('creates a user with a one-time temporary password', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin),
      payload: { role: 'faculty', username: 'EMP042', fullName: 'Asha Patil', designation: 'Lecturer' },
    });
    expect(res.statusCode).toBe(201);
    const { user, temporaryPassword } = res.json();
    expect(user).toMatchObject({ username: 'emp042', role: 'faculty', mustChangePassword: true, designation: 'Lecturer' });
    expect(temporaryPassword).toMatch(/^[A-Za-z2-9]{10}$/);

    const tokens = await login(ctx.app, { instituteCode: 'ALPHA', username: 'emp042', password: temporaryPassword });
    expect(tokens.accessToken).toBeTypeOf('string');
  });

  it('sends students to /v1/students, since they need a class', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin),
      payload: { role: 'student', username: 'stu1', fullName: 'Someone' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate usernames within an institute', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin),
      payload: { role: 'faculty', username: 'PROF.A', fullName: 'Someone' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('allows the same username in different institutes', async () => {
    const a = await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const b = await setupInstitute(ctx.app, ctx.db, 'BETA');
    await createUserAs(ctx.app, a.admin, { role: 'student', username: 'stu1' });
    await createUserAs(ctx.app, b.admin, { role: 'student', username: 'stu1' });
  });

  it('rejects invalid input with field details', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin),
      payload: { role: 'platform_admin', username: 'x', fullName: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.details.length).toBeGreaterThan(0);
  });

  it('only lets admins manage users', async () => {
    const { owner, admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    await createUserAs(ctx.app, admin, { role: 'hod', username: 'hod.a' });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });

    for (const username of ['prof.a', 'hod.a', 'stu1']) {
      const tokens = await login(ctx.app, { instituteCode: 'ALPHA', username });
      const res = await ctx.app.inject({ method: 'GET', url: '/v1/users', headers: bearer(tokens) });
      expect(res.statusCode).toBe(403);
    }
    // The platform admin is not an institute admin either.
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/users', headers: bearer(owner) })).statusCode).toBe(403);
  });

  it('lists, filters and searches', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1', fullName: 'Asha Patil' });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu2', fullName: 'Rohan Desai' });
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a', fullName: 'Meera Joshi' });

    const students = await ctx.app.inject({ method: 'GET', url: '/v1/users?role=student', headers: bearer(admin) });
    expect(students.json().total).toBe(2);

    const search = await ctx.app.inject({ method: 'GET', url: '/v1/users?q=patil', headers: bearer(admin) });
    expect(search.json().items.map((u: { username: string }) => u.username)).toEqual(['stu1']);

    const page = await ctx.app.inject({ method: 'GET', url: '/v1/users?pageSize=2&page=2', headers: bearer(admin) });
    expect(page.json()).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.json().items).toHaveLength(2);
  });

  it('treats "%" in a search as a literal character', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/users?q=%25', headers: bearer(admin) });
    expect(res.json().total).toBe(0);
  });

  it('writes an audit entry when a user is created', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const rows = await ctx.db.select().from(auditLogs);
    expect(rows.some((r) => r.action === 'user.created' && (r.data as { username?: string })?.username === 'stu1')).toBe(
      true,
    );
  });
});

describe('tenant isolation', () => {
  it("never exposes or modifies another institute's users", async () => {
    const a = await setupInstitute(ctx.app, ctx.db, 'ALPHA');
    const b = await setupInstitute(ctx.app, ctx.db, 'BETA');
    const betaStudent = await createUserAs(ctx.app, b.admin, { role: 'student', username: 'beta.s1' });

    const list = await ctx.app.inject({ method: 'GET', url: '/v1/users', headers: bearer(a.admin) });
    expect(list.json().items.map((u: { username: string }) => u.username)).toEqual(['admin']);

    const requests = [
      { method: 'GET' as const, url: `/v1/users/${betaStudent.id}` },
      { method: 'PATCH' as const, url: `/v1/users/${betaStudent.id}`, payload: { status: 'disabled' } },
      { method: 'POST' as const, url: `/v1/users/${betaStudent.id}/reset-password` },
    ];
    for (const r of requests) {
      const res = await ctx.app.inject({ ...r, headers: bearer(a.admin) });
      expect(res.statusCode).toBe(404);
    }
    // And the beta student is untouched.
    await login(ctx.app, { instituteCode: 'BETA', username: 'beta.s1' });
  });
});

describe('updating users', () => {
  it('prevents admins from disabling or demoting themselves', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const me = (await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(admin) })).json().user;
    for (const payload of [{ status: 'disabled' }, { role: 'faculty' }]) {
      const res = await ctx.app.inject({ method: 'PATCH', url: `/v1/users/${me.id}`, headers: bearer(admin), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CANNOT_CHANGE_SELF');
    }
  });

  it('disabling a user cuts off their access token and refresh token at once', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const student = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const studentTokens = await login(ctx.app, { instituteCode: 'ALPHA', username: 'stu1' });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/users/${student.id}`,
      headers: bearer(admin),
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);

    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(studentTokens) });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('ACCOUNT_INACTIVE');
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: studentTokens.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('a role change takes effect without logging in again', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const faculty = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const facultyTokens = await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/users/${faculty.id}`,
      headers: bearer(admin),
      payload: { role: 'admin' },
    });
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/users', headers: bearer(facultyTokens) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an empty update', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const student = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const res = await ctx.app.inject({ method: 'PATCH', url: `/v1/users/${student.id}`, headers: bearer(admin), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('password reset replaces the old password and forces a change', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const student = await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/users/${student.id}/reset-password`,
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    const { temporaryPassword } = res.json();

    const old = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { instituteCode: 'ALPHA', username: 'stu1', password: PASSWORD },
    });
    expect(old.statusCode).toBe(401);
    const tokens = await login(ctx.app, { instituteCode: 'ALPHA', username: 'stu1', password: temporaryPassword });
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(tokens) });
    expect(me.json().user.mustChangePassword).toBe(true);
  });
});

describe('staff directory', () => {
  it('lists active teaching staff for all staff, without contact details, and not for students', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a', fullName: 'Asha' });
    const off = await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.b', fullName: 'Bina' });
    await ctx.app.inject({ method: 'PATCH', url: `/v1/users/${off.id}`, headers: bearer(admin), payload: { status: 'disabled' } });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });

    const faculty = await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' });
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/directory/staff', headers: bearer(faculty) });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((u: { username: string }) => u.username)).toEqual(['admin', 'prof.a']);
    expect(res.json()[0].email).toBeUndefined();

    const student = await login(ctx.app, { instituteCode: 'ALPHA', username: 'stu1' });
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/directory/staff', headers: bearer(student) })).statusCode).toBe(403);
  });
});
