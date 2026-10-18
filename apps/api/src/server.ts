import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { closeExpiredSessions } from './modules/attendance/sessions.js';
import { deliverNotifications } from './modules/notifications/delivery.js';
import { runScheduledJobs } from './modules/notifications/jobs.js';
import { refreshTallies } from './modules/reports/tallies.js';
import { deliverWebhooks, pruneWebhookDeliveries } from './modules/webhooks/delivery.js';

const SWEEP_INTERVAL_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 60_000;
/** Daily and weekly notifications are checked this often (each runs once per period). */
const JOBS_EVERY_SWEEPS = 20; // 5 minutes

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const app = await buildApp({ config, db });
// Background loops report in; one that stops succeeding shows on /health and the System page.
app.monitor.expect('sweeper', 30_000);
app.monitor.expect('webhooks', 30_000);

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
    if (sweeps++ % JOBS_EVERY_SWEEPS === 0) {
      await runScheduledJobs(db, app.now(), app.log);
      await pruneWebhookDeliveries(db, app.now());
    }
    await deliverNotifications(db, app.delivery, app.now(), app.log);
    app.monitor.ok('sweeper');
  } catch (err) {
    app.monitor.failed('sweeper', err);
    app.log.error({ err }, 'sweep failed');
  } finally {
    sweeping = false;
  }
}, SWEEP_INTERVAL_MS);

// Webhooks go out within a couple of seconds; a backlog (e.g. scans at the start of
// every class) is worked through in batches back to back.
const WEBHOOK_INTERVAL_MS = 2_000;
const WEBHOOK_BATCH = 100;
let sendingWebhooks = false;
const webhookSender = setInterval(async () => {
  if (sendingWebhooks) return;
  sendingWebhooks = true;
  try {
    for (let round = 0; round < 20; round++) {
      const sent = await deliverWebhooks(db, { allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_URLS }, app.now(), app.log, { limit: WEBHOOK_BATCH });
      if (sent < WEBHOOK_BATCH) break;
    }
    app.monitor.ok('webhooks');
  } catch (err) {
    app.monitor.failed('webhooks', err);
    app.log.error({ err }, 'webhook delivery failed');
  } finally {
    sendingWebhooks = false;
  }
}, WEBHOOK_INTERVAL_MS);

// Emails the platform owner about errors and stalled work (needs no database).
const watchdog = setInterval(() => {
  void app.monitor.alert(app.delivery.email, config.ALERT_EMAIL, config.PUBLIC_URL, app.log);
}, WATCHDOG_INTERVAL_MS);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  clearInterval(webhookSender);
  clearInterval(watchdog);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
