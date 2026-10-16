import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveScope } from '../../lib/scope.js';
import { errorResponseSchema, idParamsSchema, nameSchema, nonEmptyPatch } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import {
  createSubject,
  createTerm,
  deleteSubject,
  deleteTerm,
  listSubjects,
  listTerms,
  updateSubject,
  updateTerm,
} from './service.js';

const security = [{ bearerAuth: [] }];
const staff = guard('admin', 'hod', 'faculty');

const termDtoSchema = z.object({ id: z.uuid(), name: z.string(), startsOn: z.iso.date(), endsOn: z.iso.date() });

/** Academic terms / semesters. Admin-managed; readable by all staff. */
export const termRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['terms'];
  const adminOnly = guard('admin');

  app.get(
    '/',
    { preHandler: staff, schema: { tags, security, summary: 'List terms, newest first', response: { 200: z.array(termDtoSchema) } } },
    (req) => listTerms(app.db, getInstituteAuth(req).instituteId),
  );

  app.post(
    '/',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Create a term',
        body: z.object({ name: nameSchema, startsOn: z.iso.date(), endsOn: z.iso.date() }),
        response: { 201: termDtoSchema, 400: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => reply.code(201).send(await createTerm(app.db, getInstituteAuth(req), req.body, req.ip)),
  );

  app.patch(
    '/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Rename a term or change its dates',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({ name: nameSchema.optional(), startsOn: z.iso.date().optional(), endsOn: z.iso.date().optional() }),
        ),
        response: { 200: termDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    (req) => updateTerm(app.db, getInstituteAuth(req), req.params.id, req.body, req.ip),
  );

  app.delete(
    '/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Delete a term without offerings',
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      await deleteTerm(app.db, getInstituteAuth(req), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );
};

const subjectDtoSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  unitId: z.uuid().nullable(),
  unitPath: z.array(z.string()),
});
const subjectCodeSchema = z.string().trim().min(1).max(30);

/** Subjects / courses. Admins manage all; HODs manage their department's. */
export const subjectRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['subjects'];
  const managers = guard('admin', 'hod');

  app.get(
    '/',
    {
      preHandler: staff,
      schema: {
        tags,
        security,
        summary: 'List subjects; filter by owning unit (includes units below it)',
        querystring: z.object({ q: z.string().trim().min(1).optional(), unitId: z.uuid().optional() }),
        response: { 200: z.array(subjectDtoSchema) },
      },
    },
    (req) => listSubjects(app.db, getInstituteAuth(req).instituteId, req.query),
  );

  app.post(
    '/',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Create a subject',
        body: z.object({
          code: subjectCodeSchema.describe('e.g. CS301'),
          name: z.string().trim().min(1).max(200),
          unitId: z.uuid().nullable().optional().describe('Owning department'),
        }),
        response: { 201: subjectDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      return reply.code(201).send(await createSubject(app.db, auth, await resolveScope(app.db, auth), req.body, req.ip));
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Update a subject',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({
            code: subjectCodeSchema.optional(),
            name: z.string().trim().min(1).max(200).optional(),
            unitId: z.uuid().nullable().optional(),
          }),
        ),
        response: { 200: subjectDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return updateSubject(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body, req.ip);
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Delete a subject without offerings',
        params: idParamsSchema,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      await deleteSubject(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );
};
