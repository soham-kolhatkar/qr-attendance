import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  // Building an index on a big table can take minutes: no statement time limit here.
  const { db, pool } = createDb(databaseUrl, 1, { statementTimeoutMs: 0 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  await runMigrations(url);
  console.log('Migrations applied.');
}
