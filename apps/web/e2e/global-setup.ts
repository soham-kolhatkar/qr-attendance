import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { E2E_DATABASE_URL } from '../playwright.config';

/** Fresh database with the DEMO institute (see apps/api/src/db/seed.ts). */
export default async function globalSetup() {
  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
  const api = fileURLToPath(new URL('../../api', import.meta.url));
  const env = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    SEED_PLATFORM_ADMIN_USERNAME: 'owner',
    SEED_PLATFORM_ADMIN_PASSWORD: 'owner-pass-123',
  };
  execSync('npx tsx src/db/migrate.ts', { cwd: api, env, stdio: 'inherit' });
  execSync('npx tsx src/db/seed.ts', { cwd: api, env, stdio: 'inherit' });
}
