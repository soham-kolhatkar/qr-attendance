import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_SCOPES, institutes } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { errorResponseSchema, idParamsSchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { sessionRefSchema, studentRefSchema } from '../webhooks/events.js';
import { integrationDocsPage, integrationSpec } from './docs.js';
import { attendanceFeed, sessionFeed } from './feeds.js';
import { createApiKey, listApiKeys, revokeApiKey } from './keys.js';
import { upsertStaff, upsertStudents } from './upsert.js';

const security = [{ bearerAuth: [] }];

const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string().describe('The start of the key, to recognise it'),
  scopes: z.array(z.enum(API_SCOPES)),
  status: z.enum(['active', 'expired', 'revoked']),
  createdBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

/** Admins manage their institute's API keys (Integrations page). Not available to API keys themselves. */
export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['api keys'];
  app.addHook('preHandler', guard('admin'));

  app.get('/', { schema: { tags, security, summary: 'API keys, newest first (revoked ones too)', response: { 200: z.array(apiKeySchema) } } }, (req) =>
    listApiKeys(app.db, getInstituteAuth(req).instituteId, app.now()),
  );

  app.post(
    '/',
    {
      schema: {
        tags,
        security,
        summary: 'Create an API key; the response holds the key itself, shown this once',
        body: z.object({
          name: z.string().trim().min(2).max(80).describe('What uses it, e.g. "ERP sync"'),
          scopes: z.array(z.enum(API_SCOPES)).min(1),
          expiresAt: z.iso.datetime({ offset: true }).optional(),
        }),
        response: { 201: z.object({ key: z.string(), apiKey: apiKeySchema }), 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      if (req.body.expiresAt && new Date(req.body.expiresAt) <= app.now()) throw badRequest('EXPIRY_IN_PAST', 'Choose an expiry date in the future');
      return reply.code(201).send(await createApiKey(app.db, getInstituteAuth(req), req.body, app.now(), req.ip));
    },
  );

  app.post(
    '/:id/revoke',
    {
      schema: { tags, security, summary: 'Stop a key working, at once', params: idParamsSchema, response: { 200: apiKeySchema, 404: errorResponseSchema } },
    },
    (req) => revokeApiKey(app.db, getInstituteAuth(req), req.params.id, app.now(), req.ip),
  );
};

const feedQuerySchema = z.object({
  after: z.string().max(500).optional().describe('The cursor from the previous response'),
  since: z.iso.datetime({ offset: true }).optional().describe('Start from this time instead (ignored when `after` is given)'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const feedPage = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    cursor: z.string().nullable().describe('Pass as `after` next time; store it between runs'),
    hasMore: z.boolean().describe('More are waiting: call again straight away'),
  });

const countsSchema = z.object({ present: z.number().int(), absent: z.number().int(), excused: z.number().int(), total: z.number().int() });

const upsertReportSchema = z.object({
  dryRun: z.boolean(),
  summary: z.object({
    rows: z.number().int(),
    create: z.number().int(),
    update: z.number().int(),
    unchanged: z.number().int(),
    errors: z.number().int(),
  }),
  newUnits: z.array(z.string()).describe('Classes that are (or would be) created'),
  newGroups: z.array(z.string()),
  errors: z.array(z.object({ row: z.number().int(), column: z.string().optional(), message: z.string() })),
  warnings: z.array(z.string()),
  credentials: z
    .array(z.object({ username: z.string(), fullName: z.string(), temporaryPassword: z.string() }))
    .optional()
    .describe('After saving: temporary passwords for new accounts, returned this once'),
});

const upsertOptions = {
  dryRun: z.boolean().default(false).describe('Check everything without saving'),
  createMissing: z.boolean().default(true).describe('Create classes and batches that don’t exist yet'),
};
const path = z.array(z.string().trim().min(1).max(100)).min(1).max(10);
const person = {
  username: z.string().trim().min(3).max(64),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
};
const UPSERT_BODY_LIMIT = 15 * 1024 * 1024;

/** For institutes' own systems, with an API key. See /docs/integration. */
export const integrationRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['integration'];

  app.get('/openapi.json', { schema: { hide: true } }, () =>
    integrationSpec(app.swagger() as unknown as Record<string, unknown>, {
      rateLimit: app.config.API_KEY_RATE_LIMIT,
      publicUrl: app.config.PUBLIC_URL,
    }),
  );

  app.get(
    '/key',
    {
      preHandler: guard('admin'),
      config: { apiKey: 'any' },
      schema: {
        tags,
        security,
        summary: 'The calling API key: its institute and scopes (a quick way to test a key)',
        response: {
          200: z.object({
            institute: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
            key: z.object({ id: z.uuid(), name: z.string(), scopes: z.array(z.enum(API_SCOPES)) }).nullable(),
          }),
        },
      },
    },
    async (req) => {
      const auth = getInstituteAuth(req);
      const [institute] = await app.db
        .select({ id: institutes.id, code: institutes.code, name: institutes.name })
        .from(institutes)
        .where(eq(institutes.id, auth.instituteId));
      return { institute: institute!, key: auth.apiKey ?? null };
    },
  );

  app.get(
    '/attendance',
    {
      preHandler: guard('admin'),
      config: { apiKey: 'attendance:read' },
      schema: {
        tags,
        security,
        summary: 'Change feed of attendance marks, oldest change first',
        description: 'A mark appears again each time it changes. Keep the latest per session and student.',
        querystring: feedQuerySchema,
        response: {
          200: feedPage(
            z.object({
              session: sessionRefSchema,
              student: studentRefSchema,
              status: z.enum(['present', 'absent', 'excused']),
              method: z.enum(['qr', 'manual']).nullable(),
              markedAt: z.iso.datetime().nullable(),
              reason: z.string().nullable().describe('Given for marks by hand'),
              updatedAt: z.iso.datetime(),
            }),
          ),
          400: errorResponseSchema,
        },
      },
    },
    (req) => attendanceFeed(app.db, getInstituteAuth(req).instituteId, req.query, app.now()),
  );

  app.get(
    '/sessions',
    {
      preHandler: guard('admin'),
      config: { apiKey: 'attendance:read' },
      schema: {
        tags,
        security,
        summary: 'Change feed of sessions (classes held), oldest change first',
        description: 'A session appears again when it closes, is re-opened or is cancelled.',
        querystring: feedQuerySchema,
        response: {
          200: feedPage(
            sessionRefSchema.extend({
              closedAt: z.iso.datetime().nullable(),
              cancelReason: z.string().nullable(),
              counts: countsSchema,
              startedBy: z.object({ id: z.uuid(), fullName: z.string() }),
              updatedAt: z.iso.datetime(),
            }),
          ),
          400: errorResponseSchema,
        },
      },
    },
    (req) => sessionFeed(app.db, getInstituteAuth(req).instituteId, req.query, app.now()),
  );

  app.post(
    '/students',
    {
      preHandler: guard('admin'),
      config: { apiKey: 'students:write' },
      bodyLimit: UPSERT_BODY_LIMIT,
      schema: {
        tags,
        security,
        summary: 'Create and update students in bulk (matched by username; all or nothing)',
        body: z.object({
          ...upsertOptions,
          rows: z
            .array(
              z.object({
                ...person,
                rollNo: z.string().trim().max(20).optional(),
                class: path.optional().describe('From the top level down, e.g. ["Computer Engineering", "SY", "Div A"]. Required for new students.'),
                groups: z.array(z.string().trim().min(1).max(100)).optional().describe('Batches, electives…; replaces the student’s groups'),
              }),
            )
            .min(1)
            .max(20_000),
        }),
        response: { 200: upsertReportSchema, 400: errorResponseSchema, 409: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    (req) => upsertStudents(app.db, getInstituteAuth(req), req.body.rows, req.body, req.ip),
  );

  app.post(
    '/staff',
    {
      preHandler: guard('admin'),
      config: { apiKey: 'staff:write' },
      bodyLimit: UPSERT_BODY_LIMIT,
      schema: {
        tags,
        security,
        summary: 'Create and update faculty and HODs in bulk (matched by username; all or nothing)',
        description: 'Roles of existing accounts are never changed. Admin accounts can’t be created or changed with an API key.',
        body: z.object({
          ...upsertOptions,
          rows: z
            .array(
              z.object({
                ...person,
                role: z.enum(['faculty', 'hod', 'admin']).optional().describe('For new accounts; default faculty'),
                designation: z.string().trim().max(100).optional(),
                unit: path.optional().describe('Department or home unit, from the top level down. Required for HODs.'),
              }),
            )
            .min(1)
            .max(20_000),
        }),
        response: { 200: upsertReportSchema, 400: errorResponseSchema, 409: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    (req) => upsertStaff(app.db, getInstituteAuth(req), req.body.rows, req.body, req.ip),
  );
};

/** The integration API's own docs page. */
export const integrationDocsRoute: FastifyPluginAsyncZod = async (app) => {
  app.get('/docs/integration', { schema: { hide: true } }, (_req, reply) => reply.type('text/html; charset=utf-8').send(integrationDocsPage));
};
