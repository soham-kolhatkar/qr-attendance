import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse as Response } from 'fastify';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { type AttestOptions, attestNewKey, type FakePhoneKey, TEST_SIGNING_DIGEST, testAuthority } from './attestation-fixture.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://qra:qra@localhost:55432/qr_attendance_test';

export const PASSWORD = 'correct-horse-battery';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-that-is-definitely-long-enough',
});

/**
 * Registers hooks giving each test a fresh app (so in-memory rate limits don't leak
 * between tests) and an empty database. Call once at the top of a test file.
 */
export function useTestApp() {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  const ctx = {
    app: undefined as unknown as App,
    db,
    /** Serial numbers the test app treats as revoked by Google. */
    revokedSerials: new Set<string>(),
    /** Each student's linked test phone, by user id (see signedScan). */
    phones: new Map<string, Promise<TestPhone>>(),
    /** Added to the real clock as the app sees it; reset before each test. */
    clockOffsetMs: 0,
    /** Moves the app's clock forward. */
    advance(ms: number) {
      ctx.clockOffsetMs += ms;
    },
  };

  beforeEach(async () => {
    // institutes is referenced (directly or indirectly) by every table, so CASCADE empties them all.
    await db.execute(sql`TRUNCATE institutes, users, audit_logs RESTART IDENTITY CASCADE`);
    ctx.clockOffsetMs = 0;
    ctx.revokedSerials = new Set();
    ctx.phones = new Map();
    ctx.app = await buildApp({
      config,
      db,
      clock: () => Date.now() + ctx.clockOffsetMs,
      attestation: {
        roots: [(await testAuthority).rootPem],
        signingCertDigests: [TEST_SIGNING_DIGEST],
        revokedSerials: async () => ctx.revokedSerials,
      },
    });
  });
  afterEach(async () => {
    await ctx.app.close();
  });
  afterAll(async () => {
    await pool.end();
  });
  return ctx;
}

export type Tokens = { accessToken: string; refreshToken: string };
export type TestContext = ReturnType<typeof useTestApp>;

/** Idempotent, so several institutes can be set up in one test. */
export async function createPlatformAdmin(db: Db, username = 'owner'): Promise<void> {
  await db
    .insert(users)
    .values({ role: 'platform_admin', username, fullName: 'Owner', passwordHash: await hashPassword(PASSWORD) })
    .onConflictDoNothing();
}

export async function login(
  app: App,
  body: { instituteCode?: string; username: string; password?: string },
): Promise<Tokens> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: PASSWORD, ...body } });
  if (res.statusCode !== 200) throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  return res.json();
}

export const bearer = (tokens: Tokens) => ({ authorization: `Bearer ${tokens.accessToken}` });

/** Short-hand HTTP client acting as one logged-in user. */
export function as(app: App, tokens: Tokens) {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<Response> =>
    app.inject({ method, url, payload, headers: bearer(tokens) });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: object = {}) => call('POST', url, body),
    patch: (url: string, body: object) => call('PATCH', url, body),
    delete: (url: string) => call('DELETE', url),
  };
}

/** Fails the test with the response body when the status is unexpected. */
export function expectStatus(res: Response, status: number) {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : undefined;
}

/** Platform admin + one institute with an admin. Returns tokens for both. */
export async function setupInstitute(app: App, db: Db, code = 'ALPHA') {
  await createPlatformAdmin(db);
  const owner = await login(app, { username: 'owner' });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/platform/institutes',
    headers: bearer(owner),
    payload: { code, name: `${code} College`, admin: { username: 'admin', fullName: 'Admin', password: PASSWORD } },
  });
  if (res.statusCode !== 201) throw new Error(`create institute failed: ${res.body}`);
  const { institute } = res.json() as { institute: { id: string; code: string } };
  const admin = await login(app, { instituteCode: code, username: 'admin' });
  return { owner, institute, admin };
}

/**
 * A typical engineering-college structure:
 *   Department › Year › Division
 *   COMP › SY › Div A (batches A1, A2), Div B
 *   MECH › SY › Div A
 */
export async function setupStructure(app: App, admin: Tokens) {
  const api = as(app, admin);
  for (const name of ['Department', 'Year', 'Division']) expectStatus(await api.post('/v1/structure/levels', { name }), 201);
  const unit = async (name: string, parentId?: string) =>
    expectStatus(await api.post('/v1/structure/units', { name, parentId }), 201).id as string;
  const comp = await unit('Computer Engineering');
  const compSy = await unit('SY', comp);
  const compA = await unit('Div A', compSy);
  const compB = await unit('Div B', compSy);
  const mech = await unit('Mechanical Engineering');
  const mechSy = await unit('SY', mech);
  const mechA = await unit('Div A', mechSy);
  const group = async (name: string, unitId: string) =>
    expectStatus(await api.post('/v1/groups', { name, unitId }), 201).id as string;
  const a1 = await group('A1', compA);
  const a2 = await group('A2', compA);
  return { comp, compSy, compA, compB, mech, mechSy, mechA, a1, a2 };
}

/** A single-level structure with one unit, for tests that just need somewhere to put students. */
async function defaultUnit(app: App, admin: Tokens): Promise<string> {
  const api = as(app, admin);
  const structure = expectStatus(await api.get('/v1/structure'), 200);
  if (structure.units.length > 0) return structure.units[0].id;
  if (structure.levels.length === 0) expectStatus(await api.post('/v1/structure/levels', { name: 'Class' }), 201);
  return expectStatus(await api.post('/v1/structure/units', { name: 'Default' }), 201).id;
}

/**
 * Creates a user with the shared test password: students through /v1/students, staff
 * through /v1/users. Students and HODs land in `unitId` or a default unit.
 */
export async function createUserAs(
  app: App,
  adminTokens: Tokens,
  user: {
    role: 'admin' | 'hod' | 'faculty' | 'student';
    username: string;
    fullName?: string;
    unitId?: string;
    rollNo?: string;
    groupIds?: string[];
  },
): Promise<{ id: string }> {
  const api = as(app, adminTokens);
  const { role, ...rest } = user;
  const fullName = user.fullName ?? user.username;
  if (role === 'student') {
    const unitId = user.unitId ?? (await defaultUnit(app, adminTokens));
    const res = await api.post('/v1/students', { ...rest, fullName, unitId, password: PASSWORD });
    return expectStatus(res, 201).student;
  }
  const unitId = user.unitId ?? (role === 'hod' ? await defaultUnit(app, adminTokens) : undefined);
  const res = await api.post('/v1/users', { ...rest, role, fullName, unitId, password: PASSWORD, mustChangePassword: false });
  return expectStatus(res, 201).user;
}

/** A multipart/form-data body with one file field named "file". */
export function multipartFile(filename: string, content: Buffer | string, contentType = 'text/csv') {
  const boundary = `----qra${Math.random().toString(16).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * Ready-to-teach class: COMP SY Div A (batches A1/A2) and Div B, a term, subject
 * CS301 taught by prof.a to Div A, and students. Returns tokens and ids.
 */
export async function setupClass(app: App, db: Db) {
  const { admin, owner } = await setupInstitute(app, db);
  const s = await setupStructure(app, admin);
  const api = as(app, admin);
  const term = expectStatus(await api.post('/v1/terms', { name: 'Odd', startsOn: '2026-07-01', endsOn: '2026-11-30' }), 201);
  const subject = expectStatus(await api.post('/v1/subjects', { code: 'CS301', name: 'Data Structures', unitId: s.comp }), 201);
  const prof = await createUserAs(app, admin, { role: 'faculty', username: 'prof.a', fullName: 'Prof A' });
  await createUserAs(app, admin, { role: 'faculty', username: 'prof.b', fullName: 'Prof B' });
  const offering = expectStatus(
    await api.post('/v1/offerings', { termId: term.id, subjectId: subject.id, facultyIds: [prof.id], audience: { unitIds: [s.compA] } }),
    201,
  );
  const student = async (username: string, unitId: string, rollNo: string, groupIds: string[] = []) =>
    (await createUserAs(app, admin, { role: 'student', username, fullName: `Student ${username}`, unitId, rollNo, groupIds })).id;
  const students = {
    a1: await student('ca01', s.compA, '1', [s.a1]),
    a2: await student('ca02', s.compA, '2', [s.a1]),
    a3: await student('ca03', s.compA, '3', [s.a2]),
    b1: await student('cb01', s.compB, '1'),
  };
  const profTokens = await login(app, { instituteCode: 'ALPHA', username: 'prof.a' });
  return { admin, owner, s, term, subject, offering, prof, profTokens, students };
}

export const loginStudent = (app: App, username: string) => login(app, { instituteCode: 'ALPHA', username });

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

export type TestPhone = { deviceId: string; status: string; phoneId: string; key: FakePhoneKey };

const userIdOf = (tokens: Tokens) =>
  (JSON.parse(Buffer.from(tokens.accessToken.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;

/**
 * Links a phone the way the app does: challenge, key with attestation, register. Returns
 * the raw response; `phone` is set when it succeeded.
 */
export async function linkPhone(
  app: App,
  tokens: Tokens,
  opts: Partial<AttestOptions> & { phoneId?: string; model?: string } = {},
) {
  const api = as(app, tokens);
  const { challenge } = expectStatus(await api.post('/v1/devices/challenge'), 200);
  const key = await attestNewKey({ challenge, ...opts });
  const phoneId = opts.phoneId ?? `phone-${Math.random().toString(16).slice(2)}`;
  const res = await api.post('/v1/devices', {
    platform: 'android',
    challenge: opts.challenge ?? challenge,
    certificateChain: key.chain,
    phoneId,
    model: opts.model ?? 'Test Phone',
    osVersion: '16',
    appVersion: '1.0.0',
  });
  const phone: TestPhone | undefined =
    res.statusCode === 201 ? { deviceId: res.json().device.id, status: res.json().device.status, phoneId, key } : undefined;
  return { res, phone, key };
}

/** Scans as the student would with the app: signed by their linked phone (linked on first use). */
export async function signedScan(ctx: TestContext, tokens: Tokens, qr: string): Promise<Response> {
  const userId = userIdOf(tokens);
  if (!ctx.phones.has(userId)) {
    ctx.phones.set(
      userId,
      linkPhone(ctx.app, tokens).then(({ res, phone }) => phone ?? Promise.reject(new Error(`linking a phone failed: ${res.body}`))),
    );
  }
  const phone = await ctx.phones.get(userId)!;
  return as(ctx.app, tokens).post('/v1/attendance/scan', {
    qr,
    device: { id: phone.deviceId, signature: phone.key.sign(phone.deviceId, qr) },
  });
}
