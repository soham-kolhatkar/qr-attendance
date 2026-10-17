import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
import { serveWebApp } from './web.js';
import { LiveHub } from './modules/attendance/live.js';
import { scanRoutes, sessionRoutes, settingsRoutes } from './modules/attendance/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { subjectRoutes, termRoutes } from './modules/catalog/routes.js';
import { groupRoutes } from './modules/groups/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { platformRoutes } from './modules/institutes/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { offeringRoutes } from './modules/offerings/routes.js';
import { structureRoutes } from './modules/structure/routes.js';
import { studentRoutes } from './modules/students/routes.js';
import { directoryRoutes, userRoutes } from './modules/users/routes.js';
import {
  type AndroidAttestationPolicy,
  GOOGLE_ATTESTATION_ROOTS,
  googleRevocationList,
} from './modules/devices/attestation.js';
import { deviceRoutes } from './modules/devices/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Live attendance events (scans, manual marks, session changes). */
    live: LiveHub;
    /** Current time. Injectable so tests can move the clock. */
    now(): Date;
    /** What a phone must prove to be linked to a student. */
    attestation: AndroidAttestationPolicy;
  }
  interface FastifyContextConfig {
    /**
     * The route takes a multipart "file" upload. Only affects the OpenAPI docs (so
     * /docs shows a file picker); the handler itself reads and checks the file.
     */
    fileUpload?: boolean;
  }
}

export async function buildApp({
  config,
  db,
  clock = Date.now,
  attestation,
}: {
  config: Config;
  db: Db;
  clock?: () => number;
  /** Overrides for tests (e.g. a test root certificate). */
  attestation?: Partial<AndroidAttestationPolicy>;
}) {
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
  app.decorate('now', () => new Date(clock()));
  const listenUrl = config.DATABASE_LISTEN_URL ?? config.DATABASE_URL;
  if (new URL(listenUrl).hostname.includes('-pooler')) {
    app.log.warn('Live updates need a direct database connection, not a pooled one: set DATABASE_LISTEN_URL');
  }
  const live = new LiveHub(listenUrl, app.log);
  app.decorate('live', live);
  app.addHook('onClose', () => live.stop());

  app.decorate('attestation', {
    roots: GOOGLE_ATTESTATION_ROOTS,
    packageName: config.ANDROID_PACKAGE_NAME,
    signingCertDigests: config.ANDROID_SIGNING_CERT_SHA256,
    revokedSerials: config.ATTESTATION_REVOCATION_CHECK ? googleRevocationList(app.log) : async () => new Set<string>(),
    ...attestation,
  });
  if (config.NODE_ENV === 'production' && config.ANDROID_SIGNING_CERT_SHA256.length === 0) {
    app.log.warn('ANDROID_SIGNING_CERT_SHA256 is not set: a modified, re-signed copy of the student app could link phones');
  }

  await app.register(cors, { origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false });
  // Limits are opted into per route. The preHandler hook runs after body parsing so
  // routes can key limits on body fields (e.g. the login username).
  await app.register(rateLimit, { global: false, hook: 'preHandler' });
  // Spreadsheet uploads for bulk import.
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });

  await app.register(swagger, {
    openapi: {
      info: { title: 'QR Attendance API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: (data) => {
      const result = jsonSchemaTransform(data);
      if (!data.route.config?.fileUpload) return result;
      const fileBody = {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', format: 'binary', description: '.xlsx or .csv file' } },
      };
      return { ...result, schema: { ...result.schema, body: fileBody } };
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler(errorHandler);
  const webFallback = config.SERVE_WEB ? await serveWebApp(app, config.WEB_DIST_DIR) : null;
  app.setNotFoundHandler((req, reply) => {
    if (webFallback?.(req, reply)) return;
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

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

  app.get(
    '/v1/time',
    {
      schema: {
        tags: ['system'],
        summary: 'Server clock, so screens and apps can correct their own clocks',
        response: { 200: z.object({ serverTime: z.iso.datetime(), epochMs: z.number().int() }) },
      },
    },
    () => {
      const now = app.now();
      return { serverTime: now.toISOString(), epochMs: now.getTime() };
    },
  );

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(platformRoutes, { prefix: '/v1/platform' });
  await app.register(userRoutes, { prefix: '/v1/users' });
  await app.register(directoryRoutes, { prefix: '/v1/directory' });
  await app.register(structureRoutes, { prefix: '/v1/structure' });
  await app.register(groupRoutes, { prefix: '/v1/groups' });
  await app.register(studentRoutes, { prefix: '/v1/students' });
  await app.register(termRoutes, { prefix: '/v1/terms' });
  await app.register(subjectRoutes, { prefix: '/v1/subjects' });
  await app.register(offeringRoutes, { prefix: '/v1/offerings' });
  await app.register(importRoutes, { prefix: '/v1/imports' });
  await app.register(sessionRoutes, { prefix: '/v1/sessions' });
  await app.register(scanRoutes, { prefix: '/v1/attendance' });
  await app.register(settingsRoutes, { prefix: '/v1/settings' });
  await app.register(deviceRoutes, { prefix: '/v1/devices' });

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
