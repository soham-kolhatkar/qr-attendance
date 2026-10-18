import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENTS } from '../../db/schema.js';
import { errorResponseSchema, idParamsSchema, nonEmptyPatch, paginated, paginationQuerySchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  retryDeliveries,
  revealSecret,
  rotateSecret,
  sendTestEvent,
  updateEndpoint,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['webhooks'];

const endpointSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  failingSince: z.iso.datetime().nullable().describe('Start of the current run of failures'),
  createdAt: z.iso.datetime(),
  lastDay: z.object({ succeeded: z.number().int(), failed: z.number().int(), pending: z.number().int() }),
});

const deliverySchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  eventType: z.string(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastAttemptAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const urlSchema = z.string().trim().min(8).max(500);
const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1);
const secretSchema = z.object({ secret: z.string().describe('Signs deliveries; keep it in the receiving system only') });
const deliveryParams = z.object({ id: z.uuid(), deliveryId: z.uuid() });

/** Admins point webhooks at their own systems (Integrations page). Not available to API keys. */
export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard('admin'));
  const options = () => ({ allowPrivate: app.config.WEBHOOK_ALLOW_PRIVATE_URLS });

  app.get(
    '/',
    { schema: { tags, security, summary: 'Webhooks, with deliveries in the past day', response: { 200: z.array(endpointSchema) } } },
    (req) => listEndpoints(app.db, getInstituteAuth(req).instituteId, app.now()),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'Add a webhook; the response holds its signing secret',
        body: z.object({ url: urlSchema, description: z.string().trim().max(200).optional(), events: eventsSchema }),
        response: { 201: z.object({ endpoint: endpointSchema, secret: z.string() }), 400: errorResponseSchema },
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createEndpoint(app.db, getInstituteAuth(req), req.body, options(), app.now(), req.ip)),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags,
        security,
        summary: 'Change a webhook, or switch it off and on (switching on clears its failures)',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({
            url: urlSchema.optional(),
            description: z.string().trim().max(200).nullable().optional(),
            events: eventsSchema.optional(),
            enabled: z.boolean().optional(),
          }),
        ),
        response: { 200: endpointSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    (req) => updateEndpoint(app.db, getInstituteAuth(req), req.params.id, req.body, options(), app.now(), req.ip),
  );

  app.delete(
    '/:id',
    { schema: { tags, security, summary: 'Delete a webhook and its deliveries', params: idParamsSchema, response: { 204: z.null(), 404: errorResponseSchema } } },
    async (req, reply) => {
      await deleteEndpoint(app.db, getInstituteAuth(req), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/:id/secret',
    { schema: { tags, security, summary: 'Show the signing secret', params: idParamsSchema, response: { 200: secretSchema, 404: errorResponseSchema } } },
    async (req) => ({ secret: await revealSecret(app.db, getInstituteAuth(req), req.params.id) }),
  );

  app.post(
    '/:id/rotate-secret',
    {
      schema: {
        tags,
        security,
        summary: 'Replace the signing secret (takes effect at once)',
        params: idParamsSchema,
        response: { 200: secretSchema, 404: errorResponseSchema },
      },
    },
    async (req) => ({ secret: await rotateSecret(app.db, getInstituteAuth(req), req.params.id, req.ip) }),
  );

  app.post(
    '/:id/test',
    {
      schema: {
        tags,
        security,
        summary: 'Send a "ping" event now and see what the receiver answers',
        params: idParamsSchema,
        response: {
          200: z.object({ ok: z.boolean(), responseStatus: z.number().int().nullable(), error: z.string().nullable(), delivery: deliverySchema }),
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    (req) => sendTestEvent(app.db, getInstituteAuth(req), req.params.id, options(), app.now()),
  );

  app.get(
    '/:id/deliveries',
    {
      schema: {
        tags,
        security,
        summary: 'Deliveries to a webhook, newest first (kept for 30 days)',
        params: idParamsSchema,
        querystring: paginationQuerySchema.extend({ status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional() }),
        response: { 200: paginated(deliverySchema), 404: errorResponseSchema },
      },
    },
    (req) => listDeliveries(app.db, getInstituteAuth(req), req.params.id, req.query),
  );

  app.post(
    '/:id/deliveries/retry',
    {
      schema: {
        tags,
        security,
        summary: 'Send every failed delivery from the past 7 days again',
        params: idParamsSchema,
        response: { 200: z.object({ queued: z.number().int() }), 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => ({ queued: await retryDeliveries(app.db, getInstituteAuth(req), req.params.id, undefined, app.now()) }),
  );

  app.post(
    '/:id/deliveries/:deliveryId/retry',
    {
      schema: {
        tags,
        security,
        summary: 'Send one failed delivery again',
        params: deliveryParams,
        response: { 200: z.object({ queued: z.number().int() }), 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => ({
      queued: await retryDeliveries(app.db, getInstituteAuth(req), req.params.id, req.params.deliveryId, app.now()),
    }),
  );
};
