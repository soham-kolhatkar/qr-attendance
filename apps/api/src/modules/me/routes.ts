import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { institutes, users } from '../../db/schema.js';
import { errorResponseSchema } from '../../lib/validation.js';
import { getAuth, guard } from '../../plugins/auth.js';
import { toUserDto, userDtoSchema } from '../users/dto.js';

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    {
      preHandler: guard(),
      schema: {
        tags: ['auth'],
        summary: 'The logged-in user and their institute',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            user: userDtoSchema,
            institute: z.object({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
          }),
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const [row] = await app.db
        .select({ user: users, institute: { id: institutes.id, code: institutes.code, name: institutes.name } })
        .from(users)
        .leftJoin(institutes, eq(institutes.id, users.instituteId))
        .where(eq(users.id, getAuth(req).userId))
        .limit(1);
      return { user: toUserDto(row!.user), institute: row!.institute };
    },
  );
};
