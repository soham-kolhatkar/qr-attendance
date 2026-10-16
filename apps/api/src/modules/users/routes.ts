import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INSTITUTE_ROLES } from '../../db/schema.js';
import {
  errorResponseSchema,
  idParamsSchema,
  paginated,
  paginationQuerySchema,
  passwordSchema,
  usernameSchema,
} from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { userDtoSchema } from './dto.js';
import { createUser, getUser, listUsers, resetPassword, updateUser } from './service.js';

const roleSchema = z.enum(INSTITUTE_ROLES);
const security = [{ bearerAuth: [] }];

/** Institute-admin endpoints for managing the institute's own users. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard('admin'));

  app.post(
    '/',
    {
      schema: {
        tags: ['users'],
        summary: 'Create a user (admin, HOD, faculty or student)',
        security,
        body: z.object({
          role: roleSchema,
          username: usernameSchema,
          fullName: z.string().trim().min(1).max(200),
          email: z.email().optional(),
          phone: z.string().trim().min(5).max(20).optional(),
          password: passwordSchema.optional().describe('Omit to generate a temporary password'),
          mustChangePassword: z.boolean().optional().describe('Defaults to true'),
        }),
        response: {
          201: z.object({ user: userDtoSchema, temporaryPassword: z.string().optional().describe('Shown only once') }),
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const auth = getInstituteAuth(req);
      const result = await createUser(app.db, auth.instituteId, { userId: auth.userId, ip: req.ip }, req.body);
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['users'],
        summary: 'List and search users in your institute',
        security,
        querystring: paginationQuerySchema.extend({
          role: roleSchema.optional(),
          status: z.enum(['active', 'disabled']).optional(),
          q: z.string().trim().min(1).optional().describe('Search username, name or email'),
        }),
        response: { 200: paginated(userDtoSchema) },
      },
    },
    (req) => listUsers(app.db, getInstituteAuth(req).instituteId, req.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Get one user',
        security,
        params: idParamsSchema,
        response: { 200: userDtoSchema, 404: errorResponseSchema },
      },
    },
    (req) => getUser(app.db, getInstituteAuth(req).instituteId, req.params.id),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Update details, change role, or enable/disable a user',
        security,
        params: idParamsSchema,
        body: z
          .object({
            fullName: z.string().trim().min(1).max(200).optional(),
            email: z.email().nullable().optional(),
            phone: z.string().trim().min(5).max(20).nullable().optional(),
            role: roleSchema.optional(),
            status: z.enum(['active', 'disabled']).optional(),
          })
          .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field'),
        response: { 200: userDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    (req) => updateUser(app.db, getInstituteAuth(req), req.params.id, req.body, req.ip),
  );

  app.post(
    '/:id/reset-password',
    {
      schema: {
        tags: ['users'],
        summary: 'Issue a temporary password and sign the user out everywhere',
        security,
        params: idParamsSchema,
        response: { 200: z.object({ temporaryPassword: z.string() }), 404: errorResponseSchema },
      },
    },
    (req) => resetPassword(app.db, getInstituteAuth(req), req.params.id, req.ip),
  );
};
