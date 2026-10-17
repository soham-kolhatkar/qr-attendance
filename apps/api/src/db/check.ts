/**
 * Read-only health check for a database URL: encryption, server version, latency, and
 * whether live updates (LISTEN/NOTIFY) work on it. Changes nothing in the database.
 *
 *   npm run db:check                                  # uses DATABASE_URL from .env
 *   npx tsx --env-file=.env.neon src/db/check.ts      # any other env file
 */
import pg from 'pg';
import { connectionConfig } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const listenUrl = process.env.DATABASE_LISTEN_URL ?? url;

const host = (u: string) => new URL(u).hostname;
const ok = (label: string, value: string) => console.log(`  ✔ ${label.padEnd(18)} ${value}`);
const bad = (label: string, value: string) => console.log(`  ✘ ${label.padEnd(18)} ${value}`);

console.log(`Checking ${host(url)} (password not shown)`);

// Hosted databases name their region in the host, e.g. ep-xyz.ap-southeast-1.aws.neon.tech.
const region = host(url)
  .split('.')
  .find((part) => /^[a-z]{2}-[a-z]+-\d$/.test(part));
if (region) console.log(`  · ${'region'.padEnd(18)} ${region}${region === 'ap-southeast-1' ? ' (Singapore, next to the Render service)' : ' — the Render service runs in Singapore (ap-southeast-1)'}`);
if (host(url).includes('-pooler')) {
  bad('address', 'pooled ("-pooler"); use the direct address so live updates work');
}

const CONNECT_TIMEOUT_MS = 10_000;
const client = new pg.Client({ ...connectionConfig(url), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
const started = Date.now();
try {
  await client.connect();
} catch (err) {
  const code = (err as { code?: string }).code ?? (err as Error).message;
  bad('connected', `could not reach the database (${code})`);
  if (/ETIMEDOUT|ENETUNREACH|timeout/i.test(code)) {
    console.log(
      `\n  Nothing answered on port ${new URL(url).port || 5432}. Office and company networks often block database\n` +
        '  ports; try from another network (e.g. a phone hotspot). Hosting servers like Render are not affected.',
    );
  }
  process.exit(1);
}
ok('connected', `in ${Date.now() - started} ms`);

try {
  const { rows } = await client.query<{ version: string; ssl: boolean | null; db: string }>(
    `select version(), (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl, current_database() as db`,
  );
  const info = rows[0]!;
  ok('server', info.version.split(',')[0]!);
  ok('database', info.db);
  const local = ['localhost', '127.0.0.1', '::1'].includes(host(url));
  if (info.ssl) ok('encrypted (TLS)', 'yes');
  else if (local) ok('encrypted (TLS)', 'no (fine for a database on this machine)');
  else bad('encrypted (TLS)', 'NO — add ?sslmode=require to the URL');

  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await client.query('select 1');
    timings.push(Date.now() - t);
  }
  timings.sort((a, b) => a - b);
  const median = timings[2]!;
  (median < 60 ? ok : bad)('round trip', `${median} ms median from this machine${median >= 60 ? ' — far away; prefer a region near the server' : ''}`);
} finally {
  await client.end();
}

// Live updates: LISTEN on one connection, NOTIFY from another, expect delivery.
if (host(listenUrl).includes('-pooler')) {
  bad('live updates', 'not possible on a pooled address; use the direct one (or set DATABASE_LISTEN_URL)');
} else {
  const listener = new pg.Client({ ...connectionConfig(listenUrl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const sender = new pg.Client({ ...connectionConfig(url), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await Promise.all([listener.connect(), sender.connect()]);
  try {
    const channel = `qra_check_${process.pid}`;
    const received = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      listener.on('notification', (msg) => {
        if (msg.channel === channel) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    await listener.query(`LISTEN ${channel}`);
    await sender.query('select pg_notify($1, $2)', [channel, 'ping']);
    (await received) ? ok('live updates', 'LISTEN/NOTIFY works') : bad('live updates', 'no notification received within 5 s');
  } finally {
    await Promise.all([listener.end(), sender.end()]);
  }
}
