import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { closeExpiredSessions } from './modules/attendance/sessions.js';

const SWEEP_INTERVAL_MS = 15_000;

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const app = await buildApp({ config, db });

// Close sessions whose scanning time is up, so live screens hear about it promptly.
// (Scans are refused after closing time regardless; this just tidies up.)
const sweeper = setInterval(() => {
  closeExpiredSessions(db, app.live, app.now()).catch((err) => app.log.error({ err }, 'session sweep failed'));
}, SWEEP_INTERVAL_MS);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
