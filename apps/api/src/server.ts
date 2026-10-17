import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { closeExpiredSessions } from './modules/attendance/sessions.js';
import { refreshTallies } from './modules/reports/tallies.js';

const SWEEP_INTERVAL_MS = 15_000;

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const app = await buildApp({ config, db });

// Close sessions whose scanning time is up, so live screens hear about it promptly
// (scans are refused after closing time regardless), then bring report totals up to
// date so dashboards rarely have to wait for a recount.
let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await closeExpiredSessions(db, app.live, app.now());
    await refreshTallies(db, null, app.now(), 100);
  } catch (err) {
    app.log.error({ err }, 'sweep failed');
  } finally {
    sweeping = false;
  }
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
