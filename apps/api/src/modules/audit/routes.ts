import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginated, paginationQuerySchema } from '../../lib/validation.js';
import { getAuth, guard } from '../../plugins/auth.js';
import { AUDIT_CATEGORIES, type AuditCategory, listAudit } from './service.js';

const security = [{ bearerAuth: [] }];
const categories = Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]];

/** The activity log: who changed what, and when. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      preHandler: guard('admin', 'platform_admin'),
      schema: {
        tags: ['audit'],
        security,
        summary: 'Activity log, newest first: admins see their institute, the platform owner every institute',
        querystring: paginationQuerySchema.extend({
          category: z
            .enum(categories)
            .optional()
            .describe(Object.entries(AUDIT_CATEGORIES).map(([k, v]) => `${k}: ${v.label}`).join('; ')),
          actorId: z.uuid().optional().describe('Only what this person did'),
          entityType: z.string().max(40).optional(),
          entityId: z.string().max(64).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          instituteId: z.uuid().optional().describe('Platform owner only'),
        }),
        response: {
          200: paginated(
            z.object({
              id: z.number().int(),
              createdAt: z.iso.datetime(),
              action: z.string(),
              summary: z.string().describe('What happened, in words'),
              actor: z.object({ id: z.uuid(), fullName: z.string(), username: z.string(), role: z.string() }).nullable(),
              institute: z.object({ id: z.uuid(), name: z.string() }).nullable().describe('Platform owner only'),
              entity: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }).nullable(),
              ip: z.string().nullable(),
              data: z.record(z.string(), z.unknown()).nullable(),
            }),
          ),
        },
      },
    },
    (req) => listAudit(app.db, getAuth(req), req.query),
  );
};
