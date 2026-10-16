import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './helpers.js';

/** Rebuilds the test database from the migrations once per test run. */
export default async function setup() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}
