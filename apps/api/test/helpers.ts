import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';

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
  const ctx = { app: undefined as unknown as App, db };

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_logs, refresh_tokens, users, institutes RESTART IDENTITY CASCADE`);
    ctx.app = await buildApp({ config, db });
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

/** Creates a user via the admin API with the shared test password. */
export async function createUserAs(
  app: App,
  adminTokens: Tokens,
  user: { role: 'admin' | 'hod' | 'faculty' | 'student'; username: string; fullName?: string },
): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: bearer(adminTokens),
    payload: { fullName: user.username, ...user, password: PASSWORD, mustChangePassword: false },
  });
  if (res.statusCode !== 201) throw new Error(`create user failed: ${res.body}`);
  return (res.json() as { user: { id: string } }).user;
}
