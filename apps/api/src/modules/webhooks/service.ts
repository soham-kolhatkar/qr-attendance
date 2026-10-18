import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { institutes, type WebhookEvent, webhookDeliveries, webhookEndpoints } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { type AttemptResult, attemptDelivery, type WebhookOptions } from './delivery.js';
import { parseWebhookUrl } from './http.js';

type EndpointRow = typeof webhookEndpoints.$inferSelect;

const MAX_ENDPOINTS = 10;

export const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

export type EndpointDto = {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  enabled: boolean;
  disabledReason: string | null;
  lastSuccessAt: string | null;
  failingSince: string | null;
  createdAt: string;
  /** Deliveries in the past 24 hours. */
  lastDay: { succeeded: number; failed: number; pending: number };
};

async function toDtos(db: Db, rows: EndpointRow[], now: Date): Promise<EndpointDto[]> {
  const ids = rows.map((r) => r.id);
  const stats = ids.length
    ? await db
        .select({ endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status, n: count() })
        .from(webhookDeliveries)
        .where(and(inArray(webhookDeliveries.endpointId, ids), gte(webhookDeliveries.createdAt, new Date(now.getTime() - 24 * 3600_000))))
        .groupBy(webhookDeliveries.endpointId, webhookDeliveries.status)
    : [];
  return rows.map((e) => {
    const lastDay = { succeeded: 0, failed: 0, pending: 0 };
    for (const s of stats) if (s.endpointId === e.id) lastDay[s.status] = s.n;
    return {
      id: e.id,
      url: e.url,
      description: e.description,
      events: e.events,
      enabled: e.enabled,
      disabledReason: e.disabledReason,
      lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
      failingSince: e.failingSince?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      lastDay,
    };
  });
}

async function findEndpoint(db: Db, instituteId: string, id: string): Promise<EndpointRow> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Webhook');
  return row;
}

export async function listEndpoints(db: Db, instituteId: string, now: Date) {
  const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.instituteId, instituteId)).orderBy(webhookEndpoints.createdAt);
  return toDtos(db, rows, now);
}

/** Returns the signing secret once; it can be shown again later with revealSecret. */
export async function createEndpoint(
  db: Db,
  auth: InstituteAuthContext,
  input: { url: string; description?: string; events: WebhookEvent[] },
  options: WebhookOptions,
  now: Date,
  ip?: string,
): Promise<{ endpoint: EndpointDto; secret: string }> {
  const url = parseWebhookUrl(input.url, options.allowPrivate).toString();
  const [existing] = await db.select({ n: count() }).from(webhookEndpoints).where(eq(webhookEndpoints.instituteId, auth.instituteId));
  if ((existing?.n ?? 0) >= MAX_ENDPOINTS) throw badRequest('TOO_MANY_WEBHOOKS', `At most ${MAX_ENDPOINTS} webhooks per institute`);
  const secret = newSecret();
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(webhookEndpoints)
      .values({
        instituteId: auth.instituteId,
        url,
        description: input.description ?? null,
        events: [...new Set(input.events)],
        secret,
        createdBy: auth.userId,
      })
      .returning();
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'webhook.created',
      entityType: 'webhook',
      entityId: created!.id,
      data: { url, events: created!.events },
      ip,
    });
    return created!;
  });
  const [endpoint] = await toDtos(db, [row], now);
  return { endpoint: endpoint!, secret };
}

/** Switching an endpoint back on clears its failure record. */
export async function updateEndpoint(
  db: Db,
  auth: InstituteAuthContext,
  id: string,
  input: { url?: string; description?: string | null; events?: WebhookEvent[]; enabled?: boolean },
  options: WebhookOptions,
  now: Date,
  ip?: string,
): Promise<EndpointDto> {
  const current = await findEndpoint(db, auth.instituteId, id);
  const url = input.url === undefined ? undefined : parseWebhookUrl(input.url, options.allowPrivate).toString();
  const reenabled = input.enabled === true && !current.enabled;
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(webhookEndpoints)
      .set({
        url,
        description: input.description,
        events: input.events && [...new Set(input.events)],
        enabled: input.enabled,
        ...(reenabled && { disabledReason: null, failingSince: null }),
        ...(input.enabled === false && { disabledReason: 'Switched off by an admin' }),
      })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'webhook.updated',
      entityType: 'webhook',
      entityId: id,
      data: { url: updated!.url, changes: { ...input, ...(url && { url }) } },
      ip,
    });
    return updated!;
  });
  const [endpoint] = await toDtos(db, [row], now);
  return endpoint!;
}

export async function deleteEndpoint(db: Db, auth: InstituteAuthContext, id: string, ip?: string): Promise<void> {
  const current = await findEndpoint(db, auth.instituteId, id);
  await db.transaction(async (tx) => {
    await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'webhook.deleted',
      entityType: 'webhook',
      entityId: id,
      data: { url: current.url },
      ip,
    });
  });
}

export async function revealSecret(db: Db, auth: InstituteAuthContext, id: string): Promise<string> {
  return (await findEndpoint(db, auth.instituteId, id)).secret;
}

/** A new secret takes effect at once; the receiver must switch to it. */
export async function rotateSecret(db: Db, auth: InstituteAuthContext, id: string, ip?: string): Promise<string> {
  const current = await findEndpoint(db, auth.instituteId, id);
  const secret = newSecret();
  await db.transaction(async (tx) => {
    await tx.update(webhookEndpoints).set({ secret }).where(eq(webhookEndpoints.id, id));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'webhook.secret_rotated',
      entityType: 'webhook',
      entityId: id,
      data: { url: current.url },
      ip,
    });
  });
  return secret;
}

export type DeliveryDto = {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  payload: Record<string, unknown>;
};

const toDelivery = (d: typeof webhookDeliveries.$inferSelect): DeliveryDto => ({
  id: d.id,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  responseStatus: d.responseStatus,
  lastError: d.lastError,
  createdAt: d.createdAt.toISOString(),
  lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
  nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
  deliveredAt: d.deliveredAt?.toISOString() ?? null,
  payload: d.payload,
});

/** Newest first. */
export async function listDeliveries(
  db: Db,
  auth: InstituteAuthContext,
  endpointId: string,
  query: { status?: DeliveryDto['status']; page: number; pageSize: number },
) {
  await findEndpoint(db, auth.instituteId, endpointId);
  const where = and(eq(webhookDeliveries.endpointId, endpointId), query.status ? eq(webhookDeliveries.status, query.status) : undefined);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: count() }).from(webhookDeliveries).where(where),
  ]);
  return { items: rows.map(toDelivery), total: total?.n ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Queues failed deliveries again (one, or every failed one from the past week), with a fresh set of retries. */
export async function retryDeliveries(
  db: Db,
  auth: InstituteAuthContext,
  endpointId: string,
  deliveryId: string | undefined,
  now: Date,
): Promise<number> {
  const endpoint = await findEndpoint(db, auth.instituteId, endpointId);
  if (!endpoint.enabled) throw badRequest('WEBHOOK_DISABLED', 'Switch the webhook on first');
  const rows = await db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null })
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.status, 'failed'),
        deliveryId ? eq(webhookDeliveries.id, deliveryId) : gte(webhookDeliveries.createdAt, new Date(now.getTime() - 7 * 24 * 3600_000)),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (deliveryId && rows.length === 0) throw notFound('Failed delivery');
  return rows.length;
}

/** Sends a "ping" event straight away and reports what the receiver answered. */
export async function sendTestEvent(
  db: Db,
  auth: InstituteAuthContext,
  endpointId: string,
  options: WebhookOptions,
  now: Date,
): Promise<AttemptResult & { delivery: DeliveryDto }> {
  const endpoint = await findEndpoint(db, auth.instituteId, endpointId);
  if (!endpoint.enabled) throw badRequest('WEBHOOK_DISABLED', 'Switch the webhook on first');
  const [institute] = await db.select({ code: institutes.code }).from(institutes).where(eq(institutes.id, auth.instituteId));
  const eventId = randomUUID();
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId,
      instituteId: auth.instituteId,
      eventId,
      eventType: 'ping',
      payload: {
        id: eventId,
        type: 'ping',
        createdAt: now.toISOString(),
        institute: { code: institute!.code },
        data: { message: 'A test from QR Attendance. Reply with any 2xx status.' },
      },
      // Kept away from the background sender: this one attempt is made here and now.
      nextAttemptAt: new Date(now.getTime() + 3600_000),
    })
    .returning();
  const result = await attemptDelivery(db, delivery!, endpoint, options, now, undefined, { test: true });
  const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery!.id));
  return { ...result, delivery: toDelivery(after!) };
}
