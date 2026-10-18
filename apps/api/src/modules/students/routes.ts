import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveScope } from '../../lib/scope.js';
import {
  errorResponseSchema,
  fullNameSchema,
  idParamsSchema,
  nonEmptyPatch,
  paginated,
  paginationQuerySchema,
  passwordSchema,
  phoneSchema,
  rollNoSchema,
  usernameSchema,
} from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { createStudent, getStudent, listStudents, updateStudent } from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['students'];

export const studentDtoSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  rollNo: z.string().nullable(),
  unitId: z.uuid(),
  unitPath: z.array(z.string()),
  groups: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.string() })),
});

/**
 * Student profiles: class (unit), roll number and groups. Admins manage; HODs can view
 * students in their department. Account actions (disable, reset password) are in /v1/users.
 */
export const studentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/',
    {
      config: { apiKey: 'students:write' },
      preHandler: guard('admin'),
      schema: {
        tags,
        security,
        summary: 'Create a student in a class (unit), optionally with groups',
        body: z.object({
          username: usernameSchema.describe('Usually the enrollment number'),
          fullName: fullNameSchema,
          email: z.email().optional(),
          phone: phoneSchema.optional(),
          password: passwordSchema.optional().describe('Omit to generate a temporary password'),
          unitId: z.uuid(),
          rollNo: rollNoSchema.optional(),
          groupIds: z.array(z.uuid()).max(50).optional(),
        }),
        response: {
          201: z.object({ student: studentDtoSchema, temporaryPassword: z.string().optional() }),
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => reply.code(201).send(await createStudent(app.db, getInstituteAuth(req), req.body, req.ip)),
  );

  app.get(
    '/',
    {
      config: { apiKey: 'students:read' },
      preHandler: guard('admin', 'hod'),
      schema: {
        tags,
        security,
        summary: 'List students; filter by unit (includes units below it) or group',
        querystring: paginationQuerySchema.extend({
          unitId: z.uuid().optional(),
          groupId: z.uuid().optional(),
          status: z.enum(['active', 'disabled']).optional(),
          q: z.string().trim().min(1).optional().describe('Search username, name or roll number'),
        }),
        response: { 200: paginated(studentDtoSchema) },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return listStudents(app.db, auth.instituteId, await resolveScope(app.db, auth), req.query);
    },
  );

  app.get(
    '/:id',
    {
      config: { apiKey: 'students:read' },
      preHandler: guard('admin', 'hod'),
      schema: {
        tags,
        security,
        summary: 'Get one student',
        params: idParamsSchema,
        response: { 200: studentDtoSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      return getStudent(app.db, auth.instituteId, await resolveScope(app.db, auth), req.params.id);
    },
  );

  app.patch(
    '/:id',
    {
      config: { apiKey: 'students:write' },
      preHandler: guard('admin'),
      schema: {
        tags,
        security,
        summary: 'Move to another class, change roll number, or replace groups',
        params: idParamsSchema,
        body: nonEmptyPatch(
          z.object({
            unitId: z.uuid().optional(),
            rollNo: rollNoSchema.nullable().optional(),
            groupIds: z.array(z.uuid()).max(50).optional().describe('Replaces all of the student’s groups'),
          }),
        ),
        response: { 200: studentDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    (req) => updateStudent(app.db, getInstituteAuth(req), req.params.id, req.body, req.ip),
  );
};
