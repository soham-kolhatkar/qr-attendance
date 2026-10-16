import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { platformRoutes } from './modules/institutes/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { userRoutes } from './modules/users/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
}

export async function buildApp({ config, db }: { config: Config; db: Db }) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', db);
  app.decorate('config', config);

  await app.register(cors, { origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false });
  // Limits are opted into per route. The preHandler hook runs after body parsing so
  // routes can key limits on body fields (e.g. the login username).
  await app.register(rateLimit, { global: false, hook: 'preHandler' });

  await app.register(swagger, {
    openapi: {
      info: { title: 'QR Attendance API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness and database connectivity',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => {
      await db.execute(sql`select 1`);
      return { status: 'ok' as const };
    },
  );

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(platformRoutes, { prefix: '/v1/platform' });
  await app.register(userRoutes, { prefix: '/v1/users' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

/** Every error leaves the API in one shape: { error: { code, message, details? } }. */
function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request is invalid',
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      },
    });
  }
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again shortly' } });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
  }
  req.log.error(err);
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
