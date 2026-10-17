import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ATTENDANCE_STATUSES, CORRECTION_STATUSES } from '../../db/schema.js';
import { resolveScope } from '../../lib/scope.js';
import { errorResponseSchema, idParamsSchema, paginated, paginationQuerySchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import {
  approveCorrection,
  countPendingCorrections,
  listCorrections,
  rejectCorrection,
  requestCorrection,
  withdrawCorrection,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['corrections'];
const STAFF = ['admin', 'hod', 'faculty'] as const;

export const myCorrectionSchema = z.object({
  id: z.uuid(),
  status: z.enum(CORRECTION_STATUSES),
  requestedStatus: z.enum(['present', 'excused']),
  reason: z.string(),
  reviewNote: z.string().nullable().describe("The teacher's reply"),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
});

const correctionSchema = z.object({
  id: z.uuid(),
  status: z.enum(CORRECTION_STATUSES),
  requestedStatus: z.enum(['present', 'excused']),
  previousStatus: z.enum(ATTENDANCE_STATUSES),
  currentStatus: z.enum(ATTENDANCE_STATUSES).describe("The student's mark now"),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNote: z.string().nullable(),
  reviewer: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  student: z.object({
    id: z.uuid(),
    username: z.string(),
    fullName: z.string(),
    rollNo: z.string().nullable(),
    unitPath: z.array(z.string()),
  }),
  session: z.object({
    id: z.uuid(),
    startedAt: z.iso.datetime(),
    kind: z.string(),
    topic: z.string().nullable(),
    status: z.enum(['open', 'closed', 'cancelled']),
    subject: z.object({ code: z.string(), name: z.string() }),
    teacher: z.string().describe('Who started the session'),
  }),
});

const noteSchema = z.string().trim().min(3).max(300);

/**
 * Students ask for a mark in a finished class to be changed ("my scan failed", "I was on
 * medical leave"); the class's teachers, the HOD or an admin approve or turn it down.
 */
export const correctionRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = async (req: Parameters<typeof getInstituteAuth>[0]) => {
    const auth = getInstituteAuth(req);
    return { auth, scope: await resolveScope(app.db, auth) };
  };

  app.post(
    '/',
    {
      preHandler: guard('student'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => `correction:${req.headers.authorization ?? req.ip}` } },
      schema: {
        tags,
        security,
        summary: 'Ask for your mark in a finished class to be changed (within the days your institute allows)',
        body: z.object({
          sessionId: z.uuid(),
          requestedStatus: z.enum(['present', 'excused']).describe('present: "I was there"; excused: a valid reason to be away'),
          reason: z.string().trim().min(5).max(500).describe('What happened, for your teacher'),
        }),
        response: { 201: myCorrectionSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const result = await requestCorrection(app.db, getInstituteAuth(req), req.body, app.now(), req.ip);
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/:id/withdraw',
    {
      preHandler: guard('student'),
      schema: {
        tags,
        security,
        summary: 'Take back your request before it is answered',
        params: idParamsSchema,
        response: { 200: myCorrectionSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    (req) => withdrawCorrection(app.db, getInstituteAuth(req), req.params.id, app.now(), req.ip),
  );

  app.get(
    '/',
    {
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Requests you can answer: for classes you teach, your department (HOD), or all (admin)',
        querystring: paginationQuerySchema.extend({
          status: z.enum(CORRECTION_STATUSES).default('pending'),
          sessionId: z.uuid().optional(),
          q: z.string().trim().min(1).max(100).optional().describe('Student name, username, roll no. or subject code'),
        }),
        response: { 200: paginated(correctionSchema) },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return listCorrections(app.db, auth, scope, req.query, app.now());
    },
  );

  app.get(
    '/pending-count',
    {
      preHandler: guard(...STAFF),
      schema: { tags, security, summary: 'How many requests are waiting for you', response: { 200: z.object({ count: z.number().int() }) } },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return { count: await countPendingCorrections(app.db, auth, scope) };
    },
  );

  app.post(
    '/:id/approve',
    {
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: "Change the student's mark to what they asked for; they are notified",
        params: idParamsSchema,
        body: z.object({ note: noteSchema.optional().describe('Optional message to the student') }).default({}),
        response: { 200: correctionSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return approveCorrection(app.db, app.live, auth, scope, req.params.id, req.body.note, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/reject',
    {
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Keep the mark as it is; the note tells the student why',
        params: idParamsSchema,
        body: z.object({ note: noteSchema.describe('e.g. "You left before the QR code was shown"') }),
        response: { 200: correctionSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await ctx(req);
      return rejectCorrection(app.db, auth, scope, req.params.id, req.body.note, app.now(), req.ip);
    },
  );
};
