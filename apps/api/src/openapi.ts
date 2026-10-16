/**
 * Writes the OpenAPI spec to openapi.json without starting a server or touching a
 * database. The web app generates its typed API client from this file.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

const config = loadConfig({
  NODE_ENV: 'test',
  // The pool connects lazily, and generating the spec runs no queries.
  DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  JWT_SECRET: 'x'.repeat(32),
});
const { db, pool } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });
await app.ready();

const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await pool.end();
console.log(`Wrote ${out}`);
