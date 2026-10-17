import { describe, expect, it } from 'vitest';
import { connectionConfig, createDb } from '../src/db/client.js';
import { TEST_DATABASE_URL } from './helpers.js';

describe('database connection settings', () => {
  it("handles a hosted (Neon-style) URL's TLS settings", () => {
    const config = connectionConfig(
      'postgresql://app:secret@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    );
    const url = new URL(config.connectionString!);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.has('channel_binding')).toBe(false);
    expect(config.enableChannelBinding).toBe(true);
    expect(url.password).toBe('secret');
  });

  it('leaves plain local URLs alone', () => {
    const config = connectionConfig(TEST_DATABASE_URL);
    expect(config.connectionString).toBe(TEST_DATABASE_URL);
    expect(config.enableChannelBinding).toBe(false);
  });

  it('survives the server dropping an idle connection', async () => {
    const { pool } = createDb(TEST_DATABASE_URL);
    try {
      // Without a listener, an 'error' event on the pool would crash the process.
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
      expect((await pool.query('select 1 as ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });
});
