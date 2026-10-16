import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INSTITUTE_ROLES } from '../../db/schema.js';
import {
  designationSchema,
  errorResponseSchema,
  fullNameSchema,
  idParamsSchema,
  nonEmptyPatch,
  paginated,
  paginationQuerySchema,
  passwordSchema,
  phoneSchema,
  usernameSchema,
} from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { managedUserDtoSchema } from './dto.js';
import { createUser, getUser, listUsers, resetPassword, updateUser } from './service.js';

const staffRoleSchema = z.enum(['admin', 'hod', 'faculty']);
const security = [{ bearerAuth: [] }];
const tags = ['users'];

/**
 * Institute-admin endpoints for every account in the institute. Staff are created here;
 * students are created through /v1/students (they need a class) but are listed,
 * disabled and have passwords reset here like everyone else.
 */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard('admin'));

  app.post(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'Create a staff account (admin, HOD or faculty)',
        body: z.object({
          role: staffRoleSchema,
          username: usernameSchema,
          fullName: fullNameSchema,
          email: z.email().optional(),
          phone: phoneSchema.optional(),
          password: passwordSchema.optional().describe('Omit to generate a temporary password'),
          mustChangePassword: z.boolean().optional().describe('Defaults to true'),
          unitId: z.uuid().optional().describe('Department / home unit. Required for HODs: the unit they manage'),
          designation: designationSchema.optional().describe('e.g. Assistant Professor'),
        }),
        response: {
          201: z.object({ user: managedUserDtoSchema, temporaryPassword: z.string().optional().describe('Shown only once') }),
          400: errorResponseSchema,
          404: errorResponseSchema,
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
        tags,
        security,
        summary: 'List and search all accounts in your institute',
        querystring: paginationQuerySchema.extend({
          role: z.enum(INSTITUTE_ROLES).optional(),
          status: z.enum(['active', 'disabled']).optional(),
          q: z.string().trim().min(1).optional().describe('Search username, name or email'),
        }),
        response: { 200: paginated(managedUserDtoSchema) },
      },
    },
    (req) => listUsers(app.db, getInstituteAuth(req).instituteId, req.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags,
        security,
        summary: 'Get one account',
        params: idParamsSchema,
        response: { 200: managedUserDtoSchema, 404: errorResponseSchema },
      },
    },
    (req) => getUser(app.db, getInstituteAuth(req).instituteId, req.params.id),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags,
        security,
        summary: 'Update details, change a staff role or unit, or enable/disable an account',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({
            fullName: fullNameSchema.optional(),
            email: z.email().nullable().optional(),
            phone: phoneSchema.nullable().optional(),
            role: staffRoleSchema.optional(),
            status: z.enum(['active', 'disabled']).optional(),
            unitId: z.uuid().nullable().optional().describe('Staff only'),
            designation: designationSchema.nullable().optional().describe('Staff only'),
          }),
        ),
        response: { 200: managedUserDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    (req) => updateUser(app.db, getInstituteAuth(req), req.params.id, req.body, req.ip),
  );

  app.post(
    '/:id/reset-password',
    {
      schema: {
        tags,
        security,
        summary: 'Issue a temporary password and sign the user out everywhere',
        params: idParamsSchema,
        response: { 200: z.object({ temporaryPassword: z.string() }), 404: errorResponseSchema },
      },
    },
    (req) => resetPassword(app.db, getInstituteAuth(req), req.params.id, req.ip),
  );
};
