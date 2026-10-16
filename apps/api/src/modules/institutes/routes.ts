import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  idParamsSchema,
  instituteCodeSchema,
  paginated,
  paginationQuerySchema,
  passwordSchema,
  usernameSchema,
} from '../../lib/validation.js';
import { getAuth, guard } from '../../plugins/auth.js';
import { userDtoSchema } from '../users/dto.js';
import { createInstitute, listInstitutes, updateInstitute } from './service.js';

const instituteDtoSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAt: z.iso.datetime(),
});

/** Vendor-only endpoints for onboarding and managing institutes (tenants). */
export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard('platform_admin'));

  app.post(
    '/institutes',
    {
      schema: {
        tags: ['platform'],
        summary: 'Onboard a new institute with its first admin',
        security: [{ bearerAuth: [] }],
        body: z.object({
          code: instituteCodeSchema,
          name: z.string().trim().min(2).max(200),
          admin: z.object({
            username: usernameSchema,
            fullName: z.string().trim().min(1).max(200),
            email: z.email().optional(),
            password: passwordSchema.optional().describe('Omit to generate a temporary password'),
          }),
        }),
        response: {
          201: z.object({
            institute: instituteDtoSchema,
            admin: userDtoSchema,
            temporaryPassword: z.string().optional().describe('Shown only once'),
          }),
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await createInstitute(app.db, { userId: getAuth(req).userId, ip: req.ip }, req.body);
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/institutes',
    {
      schema: {
        tags: ['platform'],
        summary: 'List institutes',
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema.extend({ q: z.string().trim().min(1).optional() }),
        response: { 200: paginated(instituteDtoSchema) },
      },
    },
    (req) => listInstitutes(app.db, req.query),
  );

  app.patch(
    '/institutes/:id',
    {
      schema: {
        tags: ['platform'],
        summary: 'Rename, suspend or re-activate an institute',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: z
          .object({
            name: z.string().trim().min(2).max(200).optional(),
            status: z.enum(['active', 'suspended']).optional(),
          })
          .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field'),
        response: { 200: instituteDtoSchema, 404: errorResponseSchema },
      },
    },
    (req) => updateInstitute(app.db, { userId: getAuth(req).userId, ip: req.ip }, req.params.id, req.body),
  );
};
