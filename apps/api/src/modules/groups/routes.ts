import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveScope } from '../../lib/scope.js';
import { errorResponseSchema, idParamsSchema, nameSchema, nonEmptyPatch } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { changeMembers, createGroup, deleteGroup, listGroups, listMembers, updateGroup } from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['groups'];

const kindSchema = z.string().trim().toLowerCase().min(1).max(40).describe('e.g. batch, elective, tutorial');
const groupDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
  unitId: z.uuid().nullable(),
  unitPath: z.array(z.string()),
  memberCount: z.number().int(),
});

/** Lab batches, electives and other student sets. Admins manage all; HODs within their unit. */
export const groupRoutes: FastifyPluginAsyncZod = async (app) => {
  const managers = guard('admin', 'hod');

  app.get(
    '/',
    {
      config: { apiKey: 'academic:read' },
      preHandler: guard('admin', 'hod', 'faculty'),
      schema: {
        tags,
        security,
        summary: 'List groups, optionally only those under a unit',
        querystring: z.object({
          unitId: z.uuid().optional(),
          kind: kindSchema.optional(),
          q: z.string().trim().min(1).optional(),
        }),
        response: { 200: z.array(groupDtoSchema) },
      },
    },
    (req) => listGroups(app.db, getInstituteAuth(req).instituteId, req.query),
  );

  app.post(
    '/',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Create a group under a unit (or institute-wide, admins only)',
        body: z.object({ name: nameSchema, kind: kindSchema.optional(), unitId: z.uuid().nullable().optional() }),
        response: { 201: groupDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      const group = await createGroup(app.db, auth, await resolveScope(app.db, auth), req.body, req.ip);
      return reply.code(201).send(group);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Rename a group or change its kind',
        params: idParamsSchema,
        body: nonEmptyPatch(z.object({ name: nameSchema.optional(), kind: kindSchema.optional() })),
        response: { 200: groupDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return updateGroup(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body, req.ip);
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Delete a group (its memberships go with it)',
        params: idParamsSchema,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      await deleteGroup(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/:id/members',
    {
      preHandler: guard('admin', 'hod', 'faculty'),
      schema: {
        tags,
        security,
        summary: 'Students in a group, by roll number',
        params: idParamsSchema,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              username: z.string(),
              fullName: z.string(),
              rollNo: z.string().nullable(),
              unitId: z.uuid(),
            }),
          ),
          404: errorResponseSchema,
        },
      },
    },
    (req) => listMembers(app.db, getInstituteAuth(req).instituteId, req.params.id),
  );

  app.post(
    '/:id/members',
    {
      preHandler: managers,
      schema: {
        tags,
        security,
        summary: 'Add and/or remove students',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({
            add: z.array(z.uuid()).max(5000).optional(),
            remove: z.array(z.uuid()).max(5000).optional(),
          }),
        ),
        response: {
          200: z.object({ memberCount: z.number().int() }),
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return changeMembers(app.db, auth, await resolveScope(app.db, auth), req.params.id, req.body, req.ip);
    },
  );
};
