import { and, count, eq, gte, isNotNull, min, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { attendanceSessions, institutes, notifications, offerings, users, webhookDeliveries } from '../../db/schema.js';
import { guard } from '../../plugins/auth.js';

const security = [{ bearerAuth: [] }];

/** The platform owner's view of the running server: is everything working, and how full is it? */
export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      preHandler: guard('platform_admin'),
      schema: {
        tags: ['platform'],
        security,
        summary: 'Server status: version, database, background work, backlogs, recent errors',
        response: {
          200: z.object({
            version: z.string(),
            startedAt: z.iso.datetime(),
            uptimeSeconds: z.number().int(),
            runtime: z.object({ node: z.string(), rssMb: z.number().int(), heapUsedMb: z.number().int() }),
            database: z.object({ ok: z.boolean(), latencyMs: z.number().int().nullable(), sizeMb: z.number().nullable(), error: z.string().nullable() }),
            loops: z.array(
              z.object({
                name: z.string(),
                everySeconds: z.number(),
                lastOkAt: z.iso.datetime().nullable(),
                lastErrorAt: z.iso.datetime().nullable(),
                lastError: z.string().nullable(),
                stalled: z.boolean(),
              }),
            ),
            backlog: z
              .object({
                notifications: z.number().int().describe('Waiting to be emailed or pushed'),
                webhooks: z.number().int().describe('Webhook deliveries waiting (including retries)'),
                oldestWebhookAt: z.iso.datetime().nullable(),
                staleOfferings: z.number().int().describe('Classes whose report totals are waiting to be recounted'),
              })
              .nullable(),
            totals: z.object({ institutes: z.number().int(), activeUsers: z.number().int(), sessionsLastDay: z.number().int() }).nullable(),
            channels: z.object({ email: z.boolean(), push: z.boolean(), alertEmails: z.boolean() }),
            errors: z.array(z.object({ at: z.iso.datetime(), where: z.string(), message: z.string() })),
          }),
        },
      },
    },
    async () => {
      const now = app.now();
      const mem = process.memoryUsage();
      const database = { ok: true, latencyMs: null as number | null, sizeMb: null as number | null, error: null as string | null };
      let backlog = null;
      let totals = null;
      try {
        const t = performance.now();
        const [size] = await app.db.execute<{ bytes: string }>(sql`select pg_database_size(current_database()) as bytes`).then((r) => r.rows);
        database.latencyMs = Math.round(performance.now() - t);
        database.sizeMb = Math.round(Number(size!.bytes) / 1048576);
        const [[n], [w], [s], [i], [u], [d]] = await Promise.all([
          app.db.select({ n: count() }).from(notifications).where(or(eq(notifications.emailStatus, 'pending'), eq(notifications.pushStatus, 'pending'))),
          app.db.select({ n: count(), oldest: min(webhookDeliveries.createdAt) }).from(webhookDeliveries).where(eq(webhookDeliveries.status, 'pending')),
          app.db.select({ n: count() }).from(offerings).where(eq(offerings.talliesStale, true)),
          app.db.select({ n: count() }).from(institutes).where(eq(institutes.status, 'active')),
          app.db.select({ n: count() }).from(users).where(and(eq(users.status, 'active'), isNotNull(users.instituteId))),
          app.db.select({ n: count() }).from(attendanceSessions).where(gte(attendanceSessions.startedAt, new Date(now.getTime() - 86_400_000))),
        ]);
        backlog = { notifications: n!.n, webhooks: w!.n, oldestWebhookAt: w!.oldest?.toISOString() ?? null, staleOfferings: s!.n };
        totals = { institutes: i!.n, activeUsers: u!.n, sessionsLastDay: d!.n };
      } catch (err) {
        database.ok = false;
        database.error = err instanceof Error ? err.message : String(err);
      }
      return {
        version: app.monitor.version,
        startedAt: app.monitor.startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        runtime: { node: process.version, rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
        database,
        loops: app.monitor.loopStatus(now),
        backlog,
        totals,
        channels: { email: app.delivery.email !== null, push: app.delivery.push !== null, alertEmails: app.config.ALERT_EMAIL.length > 0 && app.delivery.email !== null },
        errors: app.monitor.recentErrors(),
      };
    },
  );
};
