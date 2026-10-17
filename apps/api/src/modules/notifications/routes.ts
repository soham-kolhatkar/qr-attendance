import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { listNotifications, markRead, registerPushToken, removePushToken, unreadCount } from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['notifications'];
const USERS = ['admin', 'hod', 'faculty', 'student'] as const;

const notificationSchema = z.object({
  id: z.uuid(),
  kind: z
    .string()
    .describe('attendance.changed, correction.approved, correction.rejected, attendance.low or summary.weekly'),
  title: z.string(),
  body: z.string().describe('Plain text; blank lines separate paragraphs, "• " lines are list items'),
  data: z.object({ sessionId: z.uuid().optional(), correctionId: z.uuid().optional(), termId: z.uuid().optional() }),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});

const pushTokenSchema = z.object({
  token: z.string().min(20).max(4096).describe("The phone's push registration (Firebase Cloud Messaging token on Android)"),
  platform: z.enum(['android', 'ios']),
});

/** Your notifications, and where the app should receive them. */
export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard(...USERS));

  app.get(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'Your notifications, newest first',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(30),
          before: z.iso.datetime().optional().describe('Only older than this (the createdAt of the last one you have)'),
          unread: z.stringbool().optional(),
        }),
        response: { 200: z.object({ items: z.array(notificationSchema), unread: z.number().int() }) },
      },
    },
    (req) => listNotifications(app.db, getInstituteAuth(req), req.query),
  );

  app.get(
    '/unread-count',
    { schema: { tags, security, summary: 'How many you haven’t read', response: { 200: z.object({ count: z.number().int() }) } } },
    async (req) => ({ count: await unreadCount(app.db, getInstituteAuth(req)) }),
  );

  app.post(
    '/read',
    {
      schema: {
        tags,
        security,
        summary: 'Mark notifications read (all of them when ids is left out)',
        body: z.object({ ids: z.array(z.uuid()).min(1).max(100).optional() }).default({}),
        response: { 200: z.object({ unread: z.number().int() }) },
      },
    },
    async (req) => ({ unread: await markRead(app.db, getInstituteAuth(req), req.body.ids, app.now()) }),
  );

  app.post(
    '/push-tokens',
    {
      schema: {
        tags,
        security,
        summary: 'Receive push notifications on this phone (the app calls this after signing in)',
        body: pushTokenSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await registerPushToken(app.db, getInstituteAuth(req), req.body);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/push-tokens/remove',
    {
      schema: {
        tags,
        security,
        summary: 'Stop push notifications to this phone (the app calls this when signing out)',
        body: pushTokenSchema.pick({ token: true }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await removePushToken(app.db, getInstituteAuth(req), req.body.token);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/channels',
    {
      schema: {
        tags,
        security,
        summary: 'Which delivery channels this server has set up',
        response: { 200: z.object({ email: z.boolean(), push: z.boolean() }) },
      },
    },
    () => ({ email: app.delivery.email !== null, push: app.delivery.push !== null }),
  );
};
