import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { TEST_DATABASE_URL } from './helpers.js';

/** The API serving the built web app from the same address (SERVE_WEB=true). */
describe('serving the web app', () => {
  let app: App;
  const { db, pool } = createDb(TEST_DATABASE_URL);

  beforeAll(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'qra-web-'));
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>QR Attendance</title><div id="root"></div>');
    await writeFile(join(dist, 'assets', 'index-abc123.js'), 'console.log("app")');
    await writeFile(join(dist, 'favicon.svg'), '<svg/>');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-that-is-definitely-long-enough',
      SERVE_WEB: 'true',
      WEB_DIST_DIR: dist,
    });
    app = await buildApp({ config, db });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('serves index.html at / and for client-side routes', async () => {
    for (const url of ['/', '/login', '/sessions/123/projector', '/students?unitId=x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<div id="root">');
    }
  });

  it('serves fingerprinted assets with long-term caching', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('console.log');
    expect(res.headers['cache-control']).toContain('immutable');

    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('keeps API errors as JSON and the API docs working', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
    // Non-GET requests to unknown paths are not pages.
    expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(404);
  });
});
