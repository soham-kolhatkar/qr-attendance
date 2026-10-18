import type { Db } from '../db/client.js';

/**
 * A query built once and reused, for the few that run on almost every request. Drizzle
 * otherwise rebuilds the SQL text each time (measurable CPU under load), and a named
 * prepared statement also lets Postgres skip parsing and planning it again.
 */
export function prepared<T>(build: (db: Db) => T): (db: Db) => T {
  const cache = new WeakMap<Db, T>();
  return (db) => {
    let query = cache.get(db);
    if (!query) {
      query = build(db);
      cache.set(db, query);
    }
    return query;
  };
}
