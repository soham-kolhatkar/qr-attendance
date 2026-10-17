import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { closeExpiredSessions } from './modules/attendance/sessions.js';
import { deliverNotifications } from './modules/notifications/delivery.js';
import { runScheduledJobs } from './modules/notifications/jobs.js';
import { refreshTallies } from './modules/reports/tallies.js';

const SWEEP_INTERVAL_MS = 15_000;
/** Daily and weekly notifications are checked this often (each runs once per period). */
const JOBS_EVERY_SWEEPS = 20; // 5 minutes

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const app = await buildApp({ config, db });

// Close sessions whose scanning time is up, so live screens hear about it promptly
// (scans are refused after closing time regardless), bring report totals up to date so
// dashboards rarely have to wait for a recount, and send waiting notifications.
let sweeping = false;
let sweeps = 0;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await closeExpiredSessions(db, app.live, app.now());
    await refreshTallies(db, null, app.now(), 100);
    if (sweeps++ % JOBS_EVERY_SWEEPS === 0) await runScheduledJobs(db, app.now(), app.log);
    await deliverNotifications(db, app.delivery, app.now(), app.log);
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
