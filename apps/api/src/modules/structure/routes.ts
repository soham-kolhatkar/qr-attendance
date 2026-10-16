import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema, idParamsSchema, nameSchema, nonEmptyPatch } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import {
  addLevel,
  createUnit,
  deleteLevel,
  deleteUnit,
  getStructure,
  renameLevel,
  updateUnit,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['structure'];

const levelDtoSchema = z.object({ id: z.uuid(), depth: z.number().int(), name: z.string() });
const unitDtoSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  levelId: z.uuid(),
  depth: z.number().int(),
  name: z.string(),
  code: z.string().nullable(),
  studentCount: z.number().int(),
  totalStudentCount: z.number().int(),
});
const codeSchema = z.string().trim().min(1).max(30);

/** The institute's configurable hierarchy: levels (e.g. Department › Year › Division) and units. */
export const structureRoutes: FastifyPluginAsyncZod = async (app) => {
  const adminOnly = guard('admin');

  app.get(
    '/',
    {
      preHandler: guard('admin', 'hod', 'faculty'),
      schema: {
        tags,
        security,
        summary: 'Levels and the full unit tree, with student counts',
        response: { 200: z.object({ levels: z.array(levelDtoSchema), units: z.array(unitDtoSchema) }) },
      },
    },
    (req) => getStructure(app.db, getInstituteAuth(req).instituteId),
  );

  app.post(
    '/levels',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Add a level below the current lowest one',
        body: z.object({ name: nameSchema }),
        response: { 201: levelDtoSchema, 400: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => reply.code(201).send(await addLevel(app.db, getInstituteAuth(req), req.body.name, req.ip)),
  );

  app.patch(
    '/levels/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Rename a level',
        params: idParamsSchema,
        body: z.object({ name: nameSchema }),
        response: { 200: levelDtoSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    (req) => renameLevel(app.db, getInstituteAuth(req), req.params.id, req.body.name, req.ip),
  );

  app.delete(
    '/levels/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Remove the lowest level (only while no unit uses it)',
        params: idParamsSchema,
        response: { 204: z.null(), 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      await deleteLevel(app.db, getInstituteAuth(req), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/units',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Create a unit; omit parentId for a top-level unit',
        body: z.object({ parentId: z.uuid().nullable().optional(), name: nameSchema, code: codeSchema.optional() }),
        response: { 201: unitDtoSchema, 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => reply.code(201).send(await createUnit(app.db, getInstituteAuth(req), req.body, req.ip)),
  );

  app.patch(
    '/units/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Rename a unit or change its code',
        params: idParamsSchema,
        body: nonEmptyPatch(z.object({ name: nameSchema.optional(), code: codeSchema.nullable().optional() })),
        response: { 200: unitDtoSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    (req) => updateUnit(app.db, getInstituteAuth(req), req.params.id, req.body, req.ip),
  );

  app.delete(
    '/units/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        security,
        summary: 'Delete an empty unit',
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req, reply) => {
      await deleteUnit(app.db, getInstituteAuth(req), req.params.id, req.ip);
      return reply.code(204).send(null);
    },
  );
};
