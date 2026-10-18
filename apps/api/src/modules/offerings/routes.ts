import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveScope } from '../../lib/scope.js';
import {
  errorResponseSchema,
  idParamsSchema,
  nonEmptyPatch,
  paginated,
  paginationQuerySchema,
} from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import {
  createOffering,
  deleteOffering,
  getOffering,
  getOfferingRoster,
  listOfferings,
  updateOffering,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['offerings'];

const audienceSchema = z
  .object({
    unitIds: z.array(z.uuid()).max(50).default([]).describe('Whole classes, e.g. "SY › Div A"'),
    groupIds: z.array(z.uuid()).max(50).default([]).describe('Batches / electives'),
  })
  .refine((a) => a.unitIds.length + a.groupIds.length > 0, 'Choose at least one class or group');

const offeringDtoSchema = z.object({
  id: z.uuid(),
  term: z.object({ id: z.uuid(), name: z.string() }),
  subject: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  faculty: z.array(z.object({ id: z.uuid(), username: z.string(), fullName: z.string() })),
  audience: z.object({
    units: z.array(z.object({ id: z.uuid(), name: z.string(), path: z.array(z.string()) })),
    groups: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.string(), unitPath: z.array(z.string()) })),
  }),
});

/**
 * Who teaches what to whom in a term. Admins manage all; HODs manage offerings whose
 * audience is inside their department; faculty see the offerings they teach.
 */
export const offeringRoutes: FastifyPluginAsyncZod = async (app) => {
  const managers = guard('admin', 'hod');
  const staff = guard('admin', 'hod', 'faculty');

  app.post(
    '/',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Create an offering: subject + term + teachers + audience',
        body: z.object({
          termId: z.uuid(),
          subjectId: z.uuid(),
          facultyIds: z.array(z.uuid()).max(20).default([]),
          audience: audienceSchema,
        }),
        response: { 201: offeringDtoSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      return reply.code(201).send(await createOffering(app.db, auth, await resolveScope(app.db, auth), req.body, req.ip));
    },
  );

  app.get(
    '/',
    {
      config: { apiKey: 'academic:read' },
      preHandler: staff,
      schema: {
        tags,
        security,
        summary: 'List offerings you can see',
        querystring: paginationQuerySchema.extend({
          termId: z.uuid().optional(),
          subjectId: z.uuid().optional(),
          facultyId: z.uuid().optional(),
          mine: z.stringbool().optional().describe('Only offerings you teach'),
        }),
        response: { 200: paginated(offeringDtoSchema) },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return listOfferings(app.db, auth, await resolveScope(app.db, auth), req.query);
    },
  );

  app.get(
    '/:id',
    {
      config: { apiKey: 'academic:read' },
      preHandler: staff,
      schema: {
        tags,
        security,
        summary: 'Get an offering with its current student count',
        params: idParamsSchema,
        response: { 200: offeringDtoSchema.extend({ studentCount: z.number().int() }), 404: errorResponseSchema },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return getOffering(app.db, auth, await resolveScope(app.db, auth), req.params.id);
    },
  );

  app.get(
    '/:id/students',
    {
      config: { apiKey: 'academic:read' },
      preHandler: staff,
      schema: {
        tags,
        security,
        summary: 'The roster: every active student in the audience',
        params: idParamsSchema,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              username: z.string(),
              fullName: z.string(),
              rollNo: z.string().nullable(),
              unitId: z.uuid(),
              unitPath: z.array(z.string()),
            }),
          ),
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return getOfferingRoster(app.db, auth, await resolveScope(app.db, auth), req.params.id);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Replace the teachers and/or the audience',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({ facultyIds: z.array(z.uuid()).max(20).optional(), audience: audienceSchema.optional() }),
        ),
        response: { 200: offeringDtoSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return updateOffering(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body, req.ip);
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Delete an offering',
        params: idParamsSchema,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      await deleteOffering(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );
};
