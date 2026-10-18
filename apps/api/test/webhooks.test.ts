import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs, notifications, webhookDeliveries, webhookEndpoints } from '../src/db/schema.js';
import { deliverWebhooks, MAX_ATTEMPTS } from '../src/modules/webhooks/delivery.js';
import { isPrivateAddress, parseWebhookUrl, postWebhook, safeLookup } from '../src/modules/webhooks/http.js';
import { as, expectStatus, loginStudent, setupClass, signedScan, useTestApp } from './helpers.js';

const ctx = useTestApp();

/** A webhook receiver on this machine: records requests, answers with `status`. */
type Received = { url: string; headers: http.IncomingHttpHeaders; body: string; json: { id: string; type: string; data: Record<string, unknown> } };
const receiver = { status: 200, received: [] as Received[], url: '' };
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      receiver.received.push({ url: req.url ?? '', headers: req.headers, body, json: JSON.parse(body) });
      res.writeHead(receiver.status).end('thanks');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  receiver.status = 200;
  receiver.received = [];
});

const deliver = () => deliverWebhooks(ctx.db, { allowPrivate: true, timeoutMs: 2000 }, new Date(Date.now() + ctx.clockOffsetMs));

function verified(r: Received, secret: string): boolean {
  const { t, v1 } = Object.fromEntries((r.headers['qra-signature'] as string).split(',').map((p) => p.split('=') as [string, string]));
  return createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') === v1;
}

describe('webhooks', () => {
  it('tell the receiver about scans, marks by hand and sessions, signed', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const admin = as(ctx.app, c.admin);
    const { endpoint, secret } = expectStatus(
      await admin.post('/v1/webhooks', { url: receiver.url, description: 'ERP', events: ['attendance.recorded', 'session.started', 'session.closed', 'session.cancelled'] }),
      201,
    );
    expect(secret).toMatch(/^whsec_/);
    // A second endpoint that only wants closed sessions.
    const closedOnly = expectStatus(await admin.post('/v1/webhooks', { url: `${receiver.url}?only=closed`, events: ['session.closed'] }), 201);

    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id, topic: 'Graphs' }), 201);
    const { payload } = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200);
    expectStatus(await signedScan(ctx, await loginStudent(ctx.app, 'ca01'), payload), 200);
    expectStatus(await signedScan(ctx, await loginStudent(ctx.app, 'ca01'), payload), 200); // again: nothing new
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a2, c.students.a1], status: 'present', reason: 'No phone' }), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    const other = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expectStatus(await prof.post(`/v1/sessions/${other.id}/cancel`, { reason: 'Started by mistake' }), 200);

    expect(await deliver()).toBe(7);
    const byType = (type: string) => receiver.received.filter((r) => r.json.type === type);
    expect(byType('session.started')).toHaveLength(2);
    expect(byType('attendance.recorded')).toHaveLength(2); // ca01's scan, ca02 by hand (ca01 was already present)
    expect(byType('session.closed')).toHaveLength(2); // one to each endpoint, same event
    expect(byType('session.cancelled')).toHaveLength(1);
    // Each endpoint's deliveries are signed with its own secret.
    for (const r of receiver.received) expect(verified(r, r.url.includes('only=closed') ? closedOnly.secret : secret)).toBe(true);

    const scan = byType('attendance.recorded').find((r) => r.json.data.via === 'scan')!;
    expect(scan.headers).toMatchObject({ 'qra-event': 'attendance.recorded', 'user-agent': 'QR-Attendance-Webhooks/1' });
    expect(scan.headers['qra-event-id']).toBe(scan.json.id);
    expect(scan.json).toMatchObject({
      type: 'attendance.recorded',
      institute: { code: 'ALPHA' },
      data: {
        session: { id: session.id, topic: 'Graphs', status: 'open', subject: { code: 'CS301' } },
        student: { username: 'ca01', rollNo: '1' },
        status: 'present',
        previousStatus: 'absent',
        method: 'qr',
      },
    });
    expect(byType('attendance.recorded').find((r) => r.json.data.via === 'teacher')!.json.data).toMatchObject({
      student: { username: 'ca02' },
      method: 'manual',
      reason: 'No phone',
    });
    const closed = byType('session.closed');
    expect(closed[0]!.json.id).toBe(closed[1]!.json.id);
    expect(closed[0]!.json.data).toMatchObject({ counts: { present: 2, absent: 1, total: 3 }, session: { status: 'closed' } });
    expect((closed[0]!.json.data.records as unknown[]).length).toBe(3);
    expect(byType('session.cancelled')[0]!.json.data).toMatchObject({ reason: 'Started by mistake', session: { status: 'cancelled' } });

    const listed = expectStatus(await admin.get('/v1/webhooks'), 200);
    expect(listed.find((e: { id: string }) => e.id === endpoint.id)).toMatchObject({ lastDay: { succeeded: 6, failed: 0, pending: 0 } });
    expect(expectStatus(await admin.get(`/v1/webhooks/${endpoint.id}/deliveries`), 200).total).toBe(6);
  });

  it('retry failures with growing waits, and switch an endpoint off after a day of them', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const admin = as(ctx.app, c.admin);
    const { endpoint } = expectStatus(await admin.post('/v1/webhooks', { url: receiver.url, events: ['session.started'] }), 201);
    const prof = as(ctx.app, c.profTokens);
    const start = async () => {
      const s = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
      expectStatus(await prof.post(`/v1/sessions/${s.id}/close`), 200);
    };

    receiver.status = 503;
    await start();
    expect(await deliver()).toBe(1);
    const [first] = await ctx.db.select().from(webhookDeliveries);
    expect(first).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 503, lastError: 'HTTP 503: thanks' });
    expect(await deliver()).toBe(0); // waits 30 seconds
    ctx.advance(31_000);
    receiver.status = 200;
    expect(await deliver()).toBe(1);
    expect((await ctx.db.select().from(webhookDeliveries))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });

    // Failing for more than a day: switched off, waiting deliveries dropped, admins told.
    receiver.status = 500;
    await ctx.db.update(webhookEndpoints).set({ failingSince: new Date(Date.now() + ctx.clockOffsetMs - 25 * 3600_000) });
    await start();
    await start();
    await deliver();
    const [off] = await ctx.db.select().from(webhookEndpoints);
    expect(off).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/^Deliveries failed for a day/) });
    expect((await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, 'pending'))).length).toBe(0);
    const [note] = await ctx.db.select().from(notifications).where(eq(notifications.kind, 'webhook.disabled'));
    expect(note).toMatchObject({ title: 'A webhook was switched off', emailStatus: 'pending' });
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'webhook.disabled'))).length).toBe(1);

    // Nothing new is queued while it's off; switching on and retrying brings the failed ones back.
    await start();
    expect((await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, 'pending'))).length).toBe(0);
    expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/deliveries/retry`), 400); // switch it on first
    expect(expectStatus(await admin.patch(`/v1/webhooks/${endpoint.id}`, { enabled: true }), 200)).toMatchObject({ enabled: true, failingSince: null });
    receiver.status = 200;
    expect(expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/deliveries/retry`), 200).queued).toBe(2);
    receiver.received = [];
    expect(await deliver()).toBe(2);
    expect(receiver.received).toHaveLength(2);
    expect(MAX_ATTEMPTS).toBe(9);
  });

  it('can be tested from the web app, and the secret shown or replaced', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const admin = as(ctx.app, c.admin);
    const { endpoint, secret } = expectStatus(await admin.post('/v1/webhooks', { url: receiver.url, events: ['session.closed'] }), 201);
    const test = expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/test`), 200);
    expect(test).toMatchObject({ ok: true, responseStatus: 200, delivery: { eventType: 'ping', status: 'succeeded' } });
    expect(receiver.received[0]!.json).toMatchObject({ type: 'ping', institute: { code: 'ALPHA' } });
    expect(verified(receiver.received[0]!, secret)).toBe(true);

    receiver.status = 404;
    const failed = expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/test`), 200);
    expect(failed).toMatchObject({ ok: false, responseStatus: 404, error: 'HTTP 404: thanks', delivery: { status: 'failed' } });
    expect((await ctx.db.select().from(webhookEndpoints))[0]!.failingSince).toBeNull(); // tests don't count

    expect(expectStatus(await admin.get(`/v1/webhooks/${endpoint.id}/secret`), 200).secret).toBe(secret);
    const rotated = expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/rotate-secret`), 200).secret;
    expect(rotated).not.toBe(secret);
    receiver.status = 200;
    expectStatus(await admin.post(`/v1/webhooks/${endpoint.id}/test`), 200);
    expect(verified(receiver.received.at(-1)!, rotated)).toBe(true);

    expectStatus(await as(ctx.app, c.profTokens).get('/v1/webhooks'), 403);
    expectStatus(await admin.delete(`/v1/webhooks/${endpoint.id}`), 204);
    expect(await ctx.db.select().from(webhookDeliveries)).toHaveLength(0);
    const log = expectStatus(await admin.get('/v1/audit?category=integrations'), 200);
    expect(log.items.map((e: { summary: string }) => e.summary)).toEqual([
      `Deleted the webhook to ${receiver.url}`,
      'Replaced the signing secret of the webhook to ' + receiver.url,
      `Added a webhook to ${receiver.url} (session.closed)`,
    ]);
  });

  it('never call private addresses in production', async () => {
    expect(() => parseWebhookUrl('http://erp.example.edu/hook', false)).toThrow(/https/);
    for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://10.1.2.3/', 'https://169.254.169.254/latest/meta-data']) {
      expect(() => parseWebhookUrl(url, false), url).toThrow(/public internet/);
    }
    expect(() => parseWebhookUrl('https://user:pw@erp.example.edu/', false)).toThrow(/credentials/);
    expect(parseWebhookUrl('https://erp.example.edu/hooks', false).hostname).toBe('erp.example.edu');
    expect(['169.254.169.254', '192.168.1.5', '::ffff:10.0.0.1', '::ffff:a00:1', 'fd00::5', '100.64.1.1'].filter((a) => !isPrivateAddress(a))).toEqual([]);
    expect(['8.8.8.8', '2606:4700::1111', '104.16.0.1'].filter(isPrivateAddress)).toEqual([]);

    // A name that resolves to a private address is refused when connecting.
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup(false)('localhost', {}, (err) => resolve(err)));
    expect(error?.code).toBe('EPRIVATE');
    await expect(postWebhook(new URL(receiver.url), '{}', {}, { allowPrivate: false, timeoutMs: 1000 })).rejects.toThrow(/https/);

    // Creating one through the API checks too (here private addresses are allowed, but not credentials or ftp).
    const c = await setupClass(ctx.app, ctx.db);
    expectStatus(await as(ctx.app, c.admin).post('/v1/webhooks', { url: 'ftp://erp.example.edu/x', events: ['session.closed'] }), 400);
  });
});
