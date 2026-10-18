import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apiKeys, auditLogs, users } from '../src/db/schema.js';
import { overRateLimit } from '../src/modules/integration/keys.js';
import { as, createUserAs, expectStatus, login, loginStudent, setupClass, signedScan, type Tokens, useTestApp } from './helpers.js';

const ctx = useTestApp();

/** Calls the API with an API key. */
function withKey(key: string) {
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}` } });
  return { get: (url: string) => call('GET', url), post: (url: string, body: object = {}) => call('POST', url, body), patch: (url: string, body: object) => call('PATCH', url, body) };
}

async function newKey(admin: Tokens, scopes: string[], name = 'ERP sync', extra: object = {}) {
  return expectStatus(await as(ctx.app, admin).post('/v1/api-keys', { name, scopes, ...extra }), 201) as { key: string; apiKey: { id: string; prefix: string } };
}

describe('API keys', () => {
  it('are shown once, work within their scopes, and stop working when revoked or expired', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const { key, apiKey } = await newKey(c.admin, ['students:read', 'attendance:read']);
    expect(key).toMatch(/^qra_[a-z2-7]{12}_[a-z2-7]{40}$/);
    expect(key.startsWith(`${apiKey.prefix}_`)).toBe(true);
    const listed = expectStatus(await as(ctx.app, c.admin).get('/v1/api-keys'), 200);
    expect(listed).toEqual([expect.objectContaining({ name: 'ERP sync', status: 'active', createdBy: expect.objectContaining({ fullName: 'Admin' }) })]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const erp = withKey(key);
    expect(expectStatus(await erp.get('/v1/integration/key'), 200)).toMatchObject({
      institute: { code: 'ALPHA' },
      key: { name: 'ERP sync', scopes: ['students:read', 'attendance:read'] },
    });
    expect(expectStatus(await erp.get('/v1/students'), 200).total).toBe(4);
    expect(expectStatus(await erp.get('/v1/reports/summary'), 200).term.name).toBe('Odd');

    const code = async (res: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => {
      const r = await res;
      return `${r.statusCode} ${r.json().error.code}`;
    };
    expect(await code(erp.post('/v1/students', { username: 'x100', fullName: 'X', unitId: c.s.compA }))).toBe('403 API_KEY_SCOPE');
    expect(await code(erp.get('/v1/users'))).toBe('403 API_KEY_NOT_ALLOWED'); // not open to keys at all
    expect(await code(erp.get('/v1/api-keys'))).toBe('403 API_KEY_NOT_ALLOWED'); // keys can't make keys
    expect(await code(withKey(`${apiKey.prefix}_${'a'.repeat(40)}`).get('/v1/students'))).toBe('401 API_KEY_INVALID');
    expect(await code(withKey('qra_nonsense').get('/v1/students'))).toBe('401 API_KEY_INVALID');

    const [row] = await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(row!.lastUsedAt).not.toBeNull();
    expect(row!.secretHash).not.toContain(key.slice(-40));

    expectStatus(await as(ctx.app, c.admin).post(`/v1/api-keys/${apiKey.id}/revoke`), 200);
    expect(await code(erp.get('/v1/students'))).toBe('401 API_KEY_INVALID');

    // Expiry.
    const later = await newKey(c.admin, ['students:read'], 'Short-lived', { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    expectStatus(await withKey(later.key).get('/v1/students'), 200);
    ctx.advance(2 * 3600_000);
    expect(await code(withKey(later.key).get('/v1/students'))).toBe('401 API_KEY_INVALID');
    expect(expectStatus(await as(ctx.app, c.admin).get('/v1/api-keys'), 200).map((k: { status: string }) => k.status).sort()).toEqual(['expired', 'revoked']);

    // Only admins manage keys.
    expectStatus(await as(ctx.app, c.profTokens).get('/v1/api-keys'), 403);
  });

  it('act for the admin who made them: they stop when that admin is disabled, and changes are labelled', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const second = await createUserAs(ctx.app, c.admin, { role: 'admin', username: 'admin2', fullName: 'Second Admin' });
    const admin2 = await login(ctx.app, { instituteCode: 'ALPHA', username: 'admin2' });
    const { key } = await newKey(admin2, ['students:write', 'students:read']);
    const erp = withKey(key);

    const rows = [
      { username: '2024x001', fullName: 'New Student One', class: ['Computer Engineering', 'SY', 'Div B'], rollNo: '7' },
      { username: '2024x002', fullName: 'New Student Two', class: ['Computer Engineering', 'SY', 'Div C'], groups: [] },
    ];
    const preview = expectStatus(await erp.post('/v1/integration/students', { rows, dryRun: true }), 200);
    expect(preview).toMatchObject({ dryRun: true, summary: { create: 2, errors: 0 }, newUnits: ['Computer Engineering › SY › Div C'] });
    const saved = expectStatus(await erp.post('/v1/integration/students', { rows, createMissing: true }), 200);
    expect(saved).toMatchObject({ dryRun: false, summary: { create: 2 } });
    expect(saved.credentials).toHaveLength(2);

    // Problems are reported per row, and nothing is saved.
    const bad = await erp.post('/v1/integration/students', {
      rows: [{ username: '2024x003', fullName: 'Ok', class: ['Computer Engineering', 'SY', 'Div A'] }, { username: '2024x004', fullName: 'No class' }],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'IMPORT_HAS_ERRORS', details: { summary: { errors: 1 }, errors: [{ row: 2 }] } });
    expect(expectStatus(await erp.get('/v1/students?q=2024x003'), 200).total).toBe(0);
    expectStatus(await erp.post('/v1/integration/students', { rows: [{ username: 'u1', fullName: 'Deep', class: ['a', 'b', 'c', 'd'] }] }), 400);

    const [entry] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'import.students'));
    expect(entry).toMatchObject({ actorUserId: second.id, data: expect.objectContaining({ create: 2, viaApiKey: { id: expect.any(String), name: 'ERP sync' } }) });
    const activity = expectStatus(await as(ctx.app, c.admin).get('/v1/audit?category=people'), 200);
    expect(activity.items[0].summary).toBe('Imported students: 2 new accounts, 0 updates · through the API key “ERP sync”');

    // The admin is disabled: their keys stop working.
    expectStatus(await as(ctx.app, c.admin).patch(`/v1/users/${second.id}`, { status: 'disabled' }), 200);
    const refused = await erp.get('/v1/students');
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.message).toMatch(/no longer an active admin/);
  });

  it('can add faculty and HODs in bulk, but never touch admin accounts', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const { key } = await newKey(c.admin, ['staff:write', 'staff:read']);
    const erp = withKey(key);
    const created = expectStatus(
      await erp.post('/v1/integration/staff', {
        rows: [
          { username: 'prof.c', fullName: 'Prof C', designation: 'Lecturer' },
          { username: 'hod.mech', fullName: 'HOD Mech', role: 'hod', unit: ['Mechanical Engineering'] },
        ],
      }),
      200,
    );
    expect(created.summary).toMatchObject({ create: 2, errors: 0 });
    expect(expectStatus(await erp.get('/v1/directory/staff'), 200).map((s: { username: string }) => s.username)).toEqual(
      expect.arrayContaining(['prof.c', 'hod.mech']),
    );
    const newAdmin = await erp.post('/v1/integration/staff', { rows: [{ username: 'sneaky', fullName: 'Sneaky', role: 'admin' }] });
    expect(newAdmin.json().error.code).toBe('ADMIN_NOT_ALLOWED');
    const editAdmin = await erp.post('/v1/integration/staff', { rows: [{ username: 'admin', fullName: 'Renamed', email: 'x@evil.example' }] });
    expect(editAdmin.json().error.code).toBe('ADMIN_NOT_ALLOWED');
    // Admins themselves still can, from the web app.
    expectStatus(await as(ctx.app, c.admin).post('/v1/integration/staff', { rows: [{ username: 'admin3', fullName: 'Admin 3', role: 'admin' }] }), 200);
  });

  it('are rate limited per key, per minute', () => {
    const t = Date.UTC(2026, 9, 18, 10, 0, 5);
    expect([1, 2, 3].map(() => overRateLimit('k1', 3, t))).toEqual([0, 0, 0]);
    expect(overRateLimit('k1', 3, t)).toBe(55); // wait until the next minute
    expect(overRateLimit('k2', 3, t)).toBe(0); // other keys are separate
    expect(overRateLimit('k1', 3, t + 60_000)).toBe(0);
  });
});

describe('change feeds', () => {
  it('list marks and sessions in the order they changed, resumable with a cursor', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const { key } = await newKey(c.admin, ['attendance:read']);
    const erp = withKey(key);
    const prof = as(ctx.app, c.profTokens);

    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id, topic: 'Heaps' }), 201);
    const { payload } = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200);
    expectStatus(await signedScan(ctx, await loginStudent(ctx.app, 'ca01'), payload), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a2], status: 'excused', reason: 'Medical' }), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);

    // Changes show after half a minute.
    expect(expectStatus(await erp.get('/v1/integration/attendance'), 200).items).toHaveLength(0);
    ctx.advance(31_000);

    // Page through two at a time.
    const seen: { student: { username: string }; status: string; session: { status: string; topic: string } }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = expectStatus(await erp.get(`/v1/integration/attendance?limit=2${cursor ? `&after=${cursor}` : ''}`), 200);
      seen.push(...res.items);
      cursor = res.cursor;
      if (!res.hasMore) break;
    }
    // Three students; ca01 and ca02 changed after the list was made, so they come last.
    expect(seen.map((r) => r.student.username).slice(-2).sort()).toEqual(['ca01', 'ca02']);
    const latest = new Map(seen.map((r) => [r.student.username, r]));
    expect(Object.fromEntries([...latest].map(([u, r]) => [u, r.status]))).toEqual({ ca01: 'present', ca02: 'excused', ca03: 'absent' });
    expect(latest.get('ca01')!.session).toMatchObject({ topic: 'Heaps', status: 'closed', subject: { code: 'CS301' } });

    // Nothing new since the cursor… until a mark changes.
    expect(expectStatus(await erp.get(`/v1/integration/attendance?after=${cursor}`), 200)).toMatchObject({ items: [], cursor, hasMore: false });
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a3], status: 'present', reason: 'Late' }), 200);
    ctx.advance(31_000);
    const next = expectStatus(await erp.get(`/v1/integration/attendance?after=${cursor}`), 200);
    expect(next.items).toEqual([expect.objectContaining({ student: expect.objectContaining({ username: 'ca03' }), status: 'present', method: 'manual', reason: 'Late' })]);

    const sessions = expectStatus(await erp.get('/v1/integration/sessions'), 200);
    expect(sessions.items).toEqual([
      expect.objectContaining({ id: session.id, status: 'closed', counts: { present: 2, absent: 0, excused: 1, total: 3 }, startedBy: expect.objectContaining({ fullName: 'Prof A' }) }),
    ]);
    expect(expectStatus(await erp.get(`/v1/integration/sessions?since=${new Date(Date.now() + 86_400_000).toISOString()}`), 200).items).toHaveLength(0);
    expect((await erp.get('/v1/integration/attendance?after=bogus')).json().error.code).toBe('CURSOR_INVALID');
  });
});

describe('integration docs', () => {
  it('list exactly what API keys can use, and the webhook events', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/integration/openapi.json' });
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/v1/integration/attendance', '/v1/students/', '/v1/reports/summary']));
    expect(Object.keys(spec.paths)).not.toContain('/v1/users/');
    expect(Object.keys(spec.paths)).not.toContain('/v1/api-keys/');
    expect(Object.keys(spec.webhooks).sort()).toEqual(['attendance.recorded', 'session.cancelled', 'session.closed', 'session.started']);
    expect(spec.info.description).toContain('600 requests a minute per key');
    expect(spec.paths['/v1/integration/attendance'].get.security).toEqual([{ apiKey: [] }]);
    const page = await ctx.app.inject({ method: 'GET', url: '/docs/integration' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('/v1/integration/openapi.json');
  });

  it('keys stay unusable by people who are not admins', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    await ctx.db.update(users).set({ role: 'faculty' }).where(eq(users.username, 'admin'));
    const res = await as(ctx.app, c.admin).get('/v1/api-keys');
    expect(res.statusCode).toBe(403);
  });
});
