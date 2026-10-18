import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle that may be the root connection or an open transaction. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Connection options from a database URL, applying the libpq-style settings hosted
 * Postgres URLs carry (e.g. Neon's `?sslmode=require&channel_binding=require`):
 * - node-postgres already treats sslmode=require as full certificate verification;
 *   naming it verify-full keeps that behaviour without a warning on every start.
 * - channel_binding is not read from the URL by node-postgres, so enable it explicitly.
 */
export function connectionConfig(databaseUrl: string): pg.ClientConfig {
  const url = new URL(databaseUrl);
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  const enableChannelBinding = url.searchParams.get('channel_binding') === 'require';
  url.searchParams.delete('channel_binding');
  return { connectionString: url.toString(), enableChannelBinding };
}

/**
 * A connection pool. Statements that run longer than `statementTimeoutMs` are stopped by
 * the database, and a connection left idle inside a transaction is closed, so one stuck
 * request can't hold rows or connections for ever. 0 turns the limits off (migrations).
 */
export function createDb(
  databaseUrl: string,
  poolMax = 10,
  { statementTimeoutMs = 30_000 }: { statementTimeoutMs?: number } = {},
): { db: Db; pool: pg.Pool } {
  const limits = statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs, idle_in_transaction_session_timeout: 2 * statementTimeoutMs } : {};
  const pool = new pg.Pool({ ...connectionConfig(databaseUrl), ...limits, max: poolMax });
  // The server may close idle connections (restart, maintenance, a hosted database
  // scaling to zero). Without a listener that error would crash the process; the pool
  // simply opens a new connection on next use.
  pool.on('error', (err) => console.warn(`Idle database connection closed: ${err.message}`));
  const db = drizzle(pool, { schema });
  return { db, pool };
}
