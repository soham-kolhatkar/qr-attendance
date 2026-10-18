import { createHmac } from 'node:crypto';
import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { users, webhookDeliveries, webhookEndpoints } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { webhookDisabled } from '../notifications/messages.js';
import { notify } from '../notifications/service.js';
import { forgetListeners } from './events.js';
import { postWebhook } from './http.js';

export type WebhookOptions = { allowPrivate: boolean; timeoutMs?: number };

/** Wait before retry n (1-based): about a day of retries in all. */
export const RETRY_AFTER_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000];
export const MAX_ATTEMPTS = RETRY_AFTER_MS.length + 1;
/** An endpoint that has failed for this long with no success is switched off. */
export const DISABLE_AFTER_MS = 24 * 3600_000;
const LEASE_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
/** Deliveries are kept this long for the Integrations page, then deleted. */
const KEEP_MS = 30 * 24 * 3600_000;

/**
 * The QRA-Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed
 * with the endpoint's secret. Receivers recompute it and also reject old timestamps.
 */
export const signature = (secret: string, timestamp: number, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

type Delivery = typeof webhookDeliveries.$inferSelect;
type Endpoint = typeof webhookEndpoints.$inferSelect;

export type AttemptResult = { ok: boolean; responseStatus: number | null; error: string | null };

/**
 * One HTTP attempt, with its outcome saved on the delivery and the endpoint. A `test`
 * attempt (the "Send test event" button) is never retried and doesn't count towards
 * switching a failing endpoint off.
 */
export async function attemptDelivery(
  db: Db,
  d: Delivery,
  endpoint: Endpoint | undefined,
  options: WebhookOptions,
  now: Date,
  log?: FastifyBaseLogger,
  { test = false } = {},
): Promise<AttemptResult> {
  if (!endpoint?.enabled) {
    const error = 'The endpoint is switched off';
    await db.update(webhookDeliveries).set({ status: 'failed', lastError: error }).where(eq(webhookDeliveries.id, d.id));
    return { ok: false, responseStatus: null, error };
  }

  const body = JSON.stringify(d.payload);
  const t = Math.floor(now.getTime() / 1000);
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const res = await postWebhook(
      new URL(endpoint.url),
      body,
      {
        'user-agent': 'QR-Attendance-Webhooks/1',
        'qra-event': d.eventType,
        'qra-event-id': d.eventId,
        'qra-delivery': d.id,
        'qra-signature': `t=${t},v1=${signature(endpoint.secret, t, body)}`,
      },
      { allowPrivate: options.allowPrivate, timeoutMs: options.timeoutMs ?? TIMEOUT_MS },
    );
    responseStatus = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const attempts = d.attempts + 1;
  if (!error) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'succeeded', attempts, responseStatus, lastError: null, lastAttemptAt: now, deliveredAt: now })
      .where(eq(webhookDeliveries.id, d.id));
    if (!test) await db.update(webhookEndpoints).set({ lastSuccessAt: now, failingSince: null }).where(eq(webhookEndpoints.id, endpoint.id));
    return { ok: true, responseStatus, error: null };
  }

  const final = test || attempts >= MAX_ATTEMPTS;
  await db
    .update(webhookDeliveries)
    .set({
      status: final ? 'failed' : 'pending',
      attempts,
      responseStatus,
      lastError: error.slice(0, 500),
      lastAttemptAt: now,
      nextAttemptAt: final ? now : new Date(now.getTime() + RETRY_AFTER_MS[attempts - 1]!),
    })
    .where(eq(webhookDeliveries.id, d.id));
  if (test) return { ok: false, responseStatus, error };
  const [marked] = await db
    .update(webhookEndpoints)
    .set({ failingSince: sql`coalesce(${webhookEndpoints.failingSince}, ${now})` })
    .where(eq(webhookEndpoints.id, endpoint.id))
    .returning({ failingSince: webhookEndpoints.failingSince });
  if (marked?.failingSince && now.getTime() - marked.failingSince.getTime() >= DISABLE_AFTER_MS) {
    await disableEndpoint(db, endpoint, error, now, log);
  }
  return { ok: false, responseStatus, error };
}

/** After a day of failures: stop sending, drop what's waiting, and tell the institute's admins. */
async function disableEndpoint(db: Db, endpoint: Endpoint, lastError: string, now: Date, log?: FastifyBaseLogger) {
  await db.transaction(async (tx) => {
    const [off] = await tx
      .update(webhookEndpoints)
      .set({ enabled: false, disabledReason: `Deliveries failed for a day. Last error: ${lastError.slice(0, 200)}` })
      .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.enabled, true)))
      .returning({ id: webhookEndpoints.id });
    if (!off) return; // another server got there first
    await tx
      .update(webhookDeliveries)
      .set({ status: 'failed', lastError: 'The endpoint was switched off' })
      .where(and(eq(webhookDeliveries.endpointId, endpoint.id), eq(webhookDeliveries.status, 'pending')));
    await writeAudit(tx, {
      instituteId: endpoint.instituteId,
      actorUserId: null,
      action: 'webhook.disabled',
      entityType: 'webhook',
      entityId: endpoint.id,
      data: { url: endpoint.url, lastError: lastError.slice(0, 200) },
    });
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.instituteId, endpoint.instituteId), eq(users.role, 'admin'), eq(users.status, 'active')));
    await notify(
      tx,
      admins.map((a) => ({ instituteId: endpoint.instituteId, userId: a.id, ...webhookDisabled(endpoint.url, lastError) })),
      now,
    );
  });
  forgetListeners(endpoint.instituteId);
  log?.warn({ endpointId: endpoint.id }, 'webhook endpoint switched off after a day of failures');
}

/**
 * Sends webhook deliveries that are due. Safe to run on several servers at once: each
 * claims its batch with a short lease first. Returns how many it handled.
 */
export async function deliverWebhooks(
  db: Db,
  options: WebhookOptions,
  now: Date,
  log?: FastifyBaseLogger,
  { limit = 100, concurrency = 10 } = {},
): Promise<number> {
  const due = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  const claimed = await db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(webhookDeliveries.id, due))
    .returning();
  if (claimed.length === 0) return 0;

  const endpointIds = [...new Set(claimed.map((d) => d.endpointId))];
  const endpoints = new Map(
    (await db.select().from(webhookEndpoints).where(inArray(webhookEndpoints.id, endpointIds))).map((e) => [e.id, e]),
  );
  let next = 0;
  const worker = async () => {
    while (next < claimed.length) {
      const d = claimed[next++]!;
      try {
        await attemptDelivery(db, d, endpoints.get(d.endpointId), options, now, log);
      } catch (err) {
        log?.error({ err, deliveryId: d.id }, 'webhook delivery crashed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, worker));
  return claimed.length;
}

/** Deletes deliveries older than a month, a batch at a time. */
export async function pruneWebhookDeliveries(db: Db, now: Date): Promise<void> {
  const old = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, new Date(now.getTime() - KEEP_MS)))
    .limit(5000);
  await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, old));
}
