import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema, instituteCodeSchema, passwordSchema, usernameSchema } from '../../lib/validation.js';
import { getAuth, guard } from '../../plugins/auth.js';
import { userDtoSchema } from '../users/dto.js';
import { changePassword, type ClientMeta, login, logout, refresh } from './service.js';

export const clientMeta = (req: FastifyRequest): ClientMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe('Access token lifetime in seconds'),
});

const loginBodySchema = z.object({
  instituteCode: instituteCodeSchema.optional().describe('Omit only for platform admins'),
  username: usernameSchema,
  password: z.string().min(1).max(128),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          // Per IP + account: a whole classroom shares one campus IP, so a per-IP limit
          // alone would block legitimate students logging in together.
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            const body = req.body as z.infer<typeof loginBodySchema>;
            return `login:${req.ip}:${body.instituteCode ?? ''}:${body.username}`;
          },
        },
      },
      schema: {
        tags: ['auth'],
        summary: 'Log in with institute code, username and password',
        body: loginBodySchema,
        response: { 200: tokenPairSchema.extend({ user: userDtoSchema }), 401: errorResponseSchema },
      },
    },
    (req) => login(app.db, app.config, req.body, clientMeta(req)),
  );

  app.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new token pair (the old one stops working)',
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 200: tokenPairSchema, 401: errorResponseSchema },
      },
    },
    (req) => refresh(app.db, app.config, req.body.refreshToken, clientMeta(req)),
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'End this login session',
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await logout(app.db, req.body.refreshToken);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/change-password',
    {
      preHandler: guard(),
      schema: {
        tags: ['auth'],
        summary: 'Change own password; signs out all other sessions',
        security: [{ bearerAuth: [] }],
        body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }),
        response: { 200: tokenPairSchema, 401: errorResponseSchema },
      },
    },
    (req) => changePassword(app.db, app.config, getAuth(req).userId, req.body, clientMeta(req)),
  );
};
