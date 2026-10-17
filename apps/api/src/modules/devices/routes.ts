import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEVICE_STATUSES } from '../../db/schema.js';
import { resolveScope } from '../../lib/scope.js';
import { errorResponseSchema, idParamsSchema, paginated, paginationQuerySchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { issueChallenge } from './challenge.js';
import {
  approveDevice,
  countPendingDevices,
  getMyDevices,
  listDevices,
  registerDevice,
  rejectDevice,
  revokeDevice,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['devices'];

export const deviceDtoSchema = z.object({
  id: z.uuid(),
  platform: z.enum(['android', 'ios']),
  status: z.enum(DEVICE_STATUSES),
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  securityLevel: z.enum(['tee', 'strongbox']).describe('tee = the phone’s trusted environment; strongbox = a separate security chip'),
  bootState: z
    .enum(['verified', 'self_signed', 'unverified', 'failed', 'unknown'])
    .describe('verified = the phone runs its maker’s software; otherwise it may be rooted or modified'),
  bootloaderLocked: z.boolean().nullable(),
  osPatchLevel: z.number().int().nullable().describe('Security patch, e.g. 202609 = September 2026'),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: z.string().nullable(),
});

const managedDeviceSchema = deviceDtoSchema.extend({
  student: z.object({
    id: z.uuid(),
    username: z.string(),
    fullName: z.string(),
    rollNo: z.string().nullable(),
    unitPath: z.array(z.string()),
  }),
  replaces: deviceDtoSchema.nullable().describe('For a change request: the phone it would replace'),
  history: z.object({ phones: z.number().int(), lastLinkedAt: z.iso.datetime().nullable() }),
});

const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) });

/**
 * One phone per student. The app links a phone by proving its signing key lives in the
 * phone's secure hardware; switching phones needs an admin's or HOD's approval.
 */
export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/challenge',
    {
      preHandler: guard('student'),
      schema: {
        tags,
        security,
        summary: 'Start linking this phone: a one-time challenge for the key attestation',
        response: { 200: z.object({ challenge: z.string(), expiresAt: z.iso.datetime() }) },
      },
    },
    (req) => {
      const { challenge, expiresAt } = issueChallenge(app.config.JWT_SECRET, getInstituteAuth(req).userId, app.now());
      return { challenge, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    '/',
    {
      preHandler: guard('student'),
      config: {
        rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req) => `link:${req.headers.authorization ?? req.ip}` },
      },
      schema: {
        tags,
        security,
        summary: 'Link this phone (or ask to switch to it) with a hardware key attestation',
        description:
          'Active straight away for a first phone or a reinstall on the same phone; otherwise "pending" until an admin or HOD approves.',
        body: z.object({
          platform: z.literal('android'),
          challenge: z.string().min(10).max(128),
          certificateChain: z.array(z.string().min(1).max(8000)).min(2).max(10).describe('Base64 DER, key certificate first'),
          phoneId: z.string().trim().min(1).max(128).describe('ANDROID_ID'),
          model: z.string().trim().max(100).optional(),
          osVersion: z.string().trim().max(50).optional(),
          appVersion: z.string().trim().max(50).optional(),
        }),
        response: { 201: z.object({ device: deviceDtoSchema }), 400: errorResponseSchema, 409: errorResponseSchema, 429: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      const device = await registerDevice(app.db, app.attestation, app.config.JWT_SECRET, auth, req.body, app.now(), req.log, req.ip);
      return reply.code(201).send({ device });
    },
  );

  app.get(
    '/mine',
    {
      preHandler: guard('student'),
      schema: {
        tags,
        security,
        summary: 'My linked phone, and a phone change waiting for approval',
        response: { 200: z.object({ active: deviceDtoSchema.nullable(), pending: deviceDtoSchema.nullable() }) },
      },
    },
    (req) => getMyDevices(app.db, getInstituteAuth(req).userId),
  );

  app.get(
    '/',
    {
      preHandler: guard('admin', 'hod'),
      schema: {
        tags,
        security,
        summary: 'Students’ phones: change requests (pending), linked (active) or past ones',
        querystring: paginationQuerySchema.extend({
          status: z.enum(DEVICE_STATUSES).default('pending'),
          q: z.string().trim().min(1).max(100).optional().describe('Name, username or roll number'),
          unitId: z.uuid().optional(),
        }),
        response: { 200: paginated(managedDeviceSchema) },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return listDevices(app.db, auth, await resolveScope(app.db, auth), req.query);
    },
  );

  app.get(
    '/pending-count',
    {
      preHandler: guard('admin', 'hod'),
      schema: { tags, security, summary: 'How many phone changes are waiting for approval', response: { 200: z.object({ count: z.number().int() }) } },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return { count: await countPendingDevices(app.db, auth, await resolveScope(app.db, auth)) };
    },
  );

  const actionSchema = (summary: string) => ({
    tags,
    security,
    summary,
    params: idParamsSchema,
    response: { 200: deviceDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
  });
  const actionWithReasonSchema = (summary: string) => ({ ...actionSchema(summary), body: reasonBody });

  app.post(
    '/:id/approve',
    { preHandler: guard('admin', 'hod'), schema: actionSchema('Approve a phone change; the old phone stops working') },
    async (req) => {
      const auth = getInstituteAuth(req);
      return approveDevice(app.db, auth, await resolveScope(app.db, auth), req.params.id, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/reject',
    { preHandler: guard('admin', 'hod'), schema: actionWithReasonSchema('Turn down a phone change; the old phone keeps working') },
    async (req) => {
      const auth = getInstituteAuth(req);
      return rejectDevice(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body.reason, app.now(), req.ip);
    },
  );

  app.post(
    '/:id/revoke',
    {
      preHandler: guard('admin', 'hod'),
      schema: actionWithReasonSchema('Unlink a student’s phone (lost, stolen, sold); their next phone links without approval'),
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return revokeDevice(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body.reason, app.now(), req.ip);
    },
  );
};
