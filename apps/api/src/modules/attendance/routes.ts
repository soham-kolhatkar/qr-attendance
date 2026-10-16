import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ATTENDANCE_STATUSES, SESSION_KINDS } from '../../db/schema.js';
import { resolveScope } from '../../lib/scope.js';
import {
  errorResponseSchema,
  idParamsSchema,
  nonEmptyPatch,
  paginated,
  paginationQuerySchema,
} from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import type { LiveEvent } from './live.js';
import { scanQr } from './scan.js';
import {
  cancelSession,
  closeSession,
  extendSession,
  getCurrentQr,
  getQrConfig,
  getSession,
  listRecords,
  listSessions,
  markRecords,
  startSession,
} from './sessions.js';
import { getAttendanceSettings, updateAttendanceSettings } from './settings.js';

const security = [{ bearerAuth: [] }];
const SSE_PING_MS = 15_000;

const countsSchema = z.object({
  present: z.number().int(),
  absent: z.number().int(),
  excused: z.number().int(),
  total: z.number().int(),
});

const sessionDtoSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SESSION_KINDS),
  topic: z.string().nullable(),
  status: z.enum(['open', 'closed', 'cancelled']),
  startedAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  offering: z.object({
    id: z.uuid(),
    subject: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
    term: z.object({ id: z.uuid(), name: z.string() }),
  }),
  createdBy: z.object({ id: z.uuid(), fullName: z.string() }),
  audience: z.object({ unitIds: z.array(z.uuid()), groupIds: z.array(z.uuid()) }).nullable(),
  counts: countsSchema,
});

const reasonSchema = z.string().trim().min(3).max(300);

/** Running attendance: start a session, show the QR, watch it fill up, fix by hand. */
export const sessionRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['sessions'];
  app.addHook('preHandler', guard('admin', 'hod', 'faculty'));

  // Live streams never finish by themselves, so end them when the server shuts down;
  // otherwise a restart would wait forever. Screens reconnect to the new instance.
  const liveStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of liveStreams) res.end();
  });
  const ctx = async (req: Parameters<typeof getInstituteAuth>[0]) => {
    const auth = getInstituteAuth(req);
    return { auth, scope: await resolveScope(app.db, auth) };
  };

  app.post(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'Start a session: snapshots the class list (everyone absent) and opens QR scanning',
        body: z.object({
          offeringId: z.uuid(),
          kind: z.enum(SESSION_KINDS).optional(),
          topic: z.string().trim().min(1).max(300).optional(),
          scanMinutes: z.number().int().min(1).max(240).optional().describe('Defaults to the institute setting'),
          audience: z
            .object({ unitIds: z.array(z.uuid()).max(50).default([]), groupIds: z.array(z.uuid()).max(50).default([]) })
            .optional()
            .describe('Narrow the offering audience, e.g. to one lab batch'),
        }),
        response: { 201: sessionDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const { auth, scope } = await ctx(req);
      const session = await startSession(app.db, app.live, auth, scope, req.body, app.now(), req.ip);
      return reply.code(201).send(session);
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'List sessions you can see, newest first',
        querystring: paginationQuerySchema.extend({
          offeringId: z.uuid().optional(),
          status: z.enum(['open', 'closed', 'cancelled']).optional(),
          mine: z.stringbool().optional().describe('Only sessions you started'),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
        response: { 200: paginated(sessionDtoSchema) },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return listSessions(app.db, auth, scope, req.query, app.now());
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags,
        security,
        summary: 'One session with its counts',
        params: idParamsSchema,
        response: { 200: sessionDtoSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return getSession(app.db, auth, scope, req.params.id, app.now());
    },
  );

  app.get(
    '/:id/qr-config',
    {
      schema: {
        tags,
        security,
        summary: 'Secret and timing for the projector screen to generate rotating QR codes itself',
        params: idParamsSchema,
        response: {
          200: z.object({
            sessionId: z.uuid(),
            secret: z.string(),
            rotationSeconds: z.number().int(),
            graceSeconds: z.number().int(),
            serverTime: z.iso.datetime(),
            closesAt: z.iso.datetime(),
          }),
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return getQrConfig(app.db, auth, scope, req.params.id, app.now());
    },
  );

  app.get(
    '/:id/qr',
    {
      schema: {
        tags,
        security,
        summary: 'The QR payload to show right now (for screens that do not generate codes locally)',
        params: idParamsSchema,
        response: {
          200: z.object({ payload: z.string(), step: z.number().int(), nextChangeAt: z.iso.datetime() }),
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return getCurrentQr(app.db, auth, scope, req.params.id, app.now());
    },
  );

  app.get(
    '/:id/records',
    {
      schema: {
        tags,
        security,
        summary: 'Everyone expected at the session with their status',
        params: idParamsSchema,
        response: {
          200: z.array(
            z.object({
              studentId: z.uuid(),
              username: z.string(),
              fullName: z.string(),
              rollNo: z.string().nullable(),
              unitPath: z.array(z.string()),
              status: z.enum(ATTENDANCE_STATUSES),
              method: z.enum(['qr', 'manual']).nullable(),
              markedAt: z.iso.datetime().nullable(),
              reason: z.string().nullable(),
            }),
          ),
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return listRecords(app.db, auth, scope, req.params.id);
    },
  );

  app.post(
    '/:id/mark',
    {
      schema: {
        tags,
        security,
        summary: 'Mark one or more students by hand (a reason is required and logged)',
        params: idParamsSchema,
        body: z.object({
          studentIds: z.array(z.uuid()).min(1).max(1000),
          status: z.enum(ATTENDANCE_STATUSES),
          reason: reasonSchema.describe('e.g. "Phone not working", "Medical leave", "On duty"'),
        }),
        response: {
          200: z.object({ updated: z.number().int(), counts: countsSchema }),
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return markRecords(app.db, app.live, auth, scope, req.params.id, req.body, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/close',
    {
      schema: {
        tags,
        security,
        summary: 'Stop QR scanning now (records stay editable)',
        params: idParamsSchema,
        response: { 200: sessionDtoSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return closeSession(app.db, app.live, auth, scope, req.params.id, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/extend',
    {
      schema: {
        tags,
        security,
        summary: 'Keep scanning open longer, or re-open a closed session',
        params: idParamsSchema,
        body: z.object({ minutes: z.number().int().min(1).max(240) }),
        response: { 200: sessionDtoSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return extendSession(app.db, app.live, auth, scope, req.params.id, req.body.minutes, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/cancel',
    {
      schema: {
        tags,
        security,
        summary: 'Cancel a session started by mistake; it is left out of attendance reports',
        params: idParamsSchema,
        body: z.object({ reason: reasonSchema }),
        response: { 200: sessionDtoSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return cancelSession(app.db, app.live, auth, scope, req.params.id, req.body.reason, app.now(), req.ip);
    },
  );

  app.get(
    '/:id/live',
    {
      schema: {
        tags,
        security,
        summary: 'Server-sent events: a "snapshot", then "marked" and "session" events as they happen',
        params: idParamsSchema,
      },
    },
    async (req, reply) => {
      const { auth, scope } = await ctx(req);
      const sessionId = req.params.id;
      await getSession(app.db, auth, scope, sessionId, app.now()); // permission check before streaming

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Subscribe before taking the snapshot, and hold events until the snapshot is
      // out, so no scan can fall in the gap between the two.
      const pending: LiveEvent[] = [];
      let ready = false;
      const unsubscribe = await app.live.subscribe(sessionId, (e) => (ready ? send(e.type, e) : pending.push(e)));
      const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
      liveStreams.add(res);
      const stop = () => {
        clearInterval(ping);
        unsubscribe();
        liveStreams.delete(res);
      };
      req.raw.on('close', stop);

      try {
        send('snapshot', await getSession(app.db, auth, scope, sessionId, app.now()));
      } catch (err) {
        req.log.error({ err }, 'live snapshot failed');
        stop();
        res.end();
        return;
      }
      for (const e of pending) send(e.type, e);
      ready = true;
    },
  );
};

/** Students scan here. */
export const scanRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/scan',
    {
      preHandler: guard('student'),
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => `scan:${req.headers.authorization ?? req.ip}`,
        },
      },
      schema: {
        tags: ['attendance'],
        security,
        summary: 'Mark yourself present by submitting the scanned QR code',
        body: z.object({ qr: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            status: z.literal('present'),
            alreadyMarked: z.boolean(),
            markedAt: z.iso.datetime(),
            session: z.object({
              id: z.uuid(),
              kind: z.string(),
              startedAt: z.iso.datetime(),
              subject: z.object({ code: z.string(), name: z.string() }),
            }),
          }),
          400: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    (req) => scanQr(app.db, app.live, getInstituteAuth(req), req.body.qr, app.now(), req.ip),
  );
};

const attendanceSettingsSchema = z.object({
  qrRotationSeconds: z.number().int().min(3).max(30).describe('How often the QR code changes'),
  qrGraceSeconds: z
    .number()
    .int()
    .min(2)
    .max(60)
    .describe('How long a code still works after the screen moved on (covers slow networks)'),
  defaultScanMinutes: z.number().int().min(1).max(240).describe('How long scanning stays open after a session starts'),
});

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['settings'];

  app.get(
    '/attendance',
    {
      preHandler: guard('admin', 'hod', 'faculty'),
      schema: { tags, security, summary: 'Attendance settings', response: { 200: attendanceSettingsSchema } },
    },
    (req) => getAttendanceSettings(app.db, getInstituteAuth(req).instituteId),
  );

  app.patch(
    '/attendance',
    {
      preHandler: guard('admin'),
      schema: {
        tags,
        security,
        summary: 'Change attendance settings (applies to sessions started afterwards)',
        body: nonEmptyPatch(attendanceSettingsSchema.partial()),
        response: { 200: attendanceSettingsSchema },
      },
    },
    (req) => updateAttendanceSettings(app.db, getInstituteAuth(req), req.body, req.ip),
  );
};
