import { describe, expect, it } from 'vitest';
import type { Email } from '../src/modules/notifications/email.js';
import { Monitor } from '../src/modules/system/monitor.js';
import { as, expectStatus, setupInstitute, useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('health and the System page', () => {
  it('/health says ok, or 503 with the problem when background work stalls', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok' });
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['strict-transport-security']).toBeUndefined(); // production only

    ctx.app.monitor.expect('sweeper', 1); // should succeed every millisecond: soon "stalled"
    await new Promise((r) => setTimeout(r, 20));
    const stalled = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(stalled.statusCode).toBe(503);
    expect(stalled.json()).toEqual({ status: 'error', problems: ['background work stalled: sweeper'] });
    ctx.app.monitor.ok('sweeper');
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('shows the platform owner the server status and recent errors', async () => {
    ctx.app.get('/v1/test-boom', async () => {
      throw new Error('kaboom');
    });
    const { owner, admin } = await setupInstitute(ctx.app, ctx.db);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/test-boom' })).statusCode).toBe(500);

    const status = expectStatus(await as(ctx.app, owner).get('/v1/platform/system'), 200);
    expect(status).toMatchObject({
      version: expect.any(String),
      database: { ok: true, error: null },
      backlog: { notifications: 0, webhooks: 0 },
      totals: { institutes: 1, activeUsers: 1 },
      channels: { email: false, push: false, alertEmails: false },
    });
    expect(status.database.sizeMb).toBeGreaterThan(0);
    expect(status.errors[0]).toMatchObject({ where: 'GET /v1/test-boom', message: 'kaboom' });
    expectStatus(await as(ctx.app, admin).get('/v1/platform/system'), 403);
  });

  it('emails the owner about errors and stalled work, at most once an hour', async () => {
    const sent: Email[] = [];
    const email = { send: async (e: Email) => void sent.push(e) };
    const monitor = new Monitor();
    const t0 = new Date();
    await monitor.alert(email, ['owner@example.com'], 'https://qra.example.com', undefined, t0);
    expect(sent).toHaveLength(0); // nothing to report

    monitor.recordError('POST /v1/attendance/scan', 'connection terminated', t0);
    monitor.recordError('GET /v1/reports/summary', 'connection terminated', t0);
    await monitor.alert(email, ['owner@example.com'], 'https://qra.example.com', undefined, t0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: { email: 'owner@example.com' }, subject: 'QR Attendance: 2 server errors' });
    expect(sent[0]!.text).toContain('POST /v1/attendance/scan: connection terminated');
    expect(sent[0]!.text).toContain('https://qra.example.com/platform/system');

    monitor.recordError('GET /v1/me', 'again', t0);
    await monitor.alert(email, ['owner@example.com'], undefined, undefined, new Date(t0.getTime() + 60_000));
    expect(sent).toHaveLength(1); // within the hour

    monitor.expect('webhooks', 1000);
    await monitor.alert(email, ['owner@example.com'], undefined, undefined, new Date(t0.getTime() + 2 * 3600_000));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe('QR Attendance: background work has stopped');
    expect(sent[1]!.text).toMatch(/^Background work has stopped: webhooks\./);

    // Database errors are reported by their cause, not the query that failed.
    const wrapped = new Error('Failed query: update webhook_deliveries set …\nparams: 1', { cause: new Error('connection terminated unexpectedly') });
    const m = new Monitor();
    m.expect('webhooks', 1000);
    m.failed('webhooks', wrapped);
    expect(m.recentErrors()[0]).toMatchObject({ where: 'background: webhooks', message: 'connection terminated unexpectedly' });

    // No email provider or no address: nothing to do.
    await new Monitor().alert(null, ['owner@example.com'], undefined);
    await new Monitor().alert(email, [], undefined);
    expect(sent).toHaveLength(2);
  });
});
