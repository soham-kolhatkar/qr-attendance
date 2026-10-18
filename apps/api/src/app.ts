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
import { registerRequestContext } from './lib/request-context.js';
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
import { reportRoutes } from './modules/reports/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { correctionRoutes } from './modules/corrections/routes.js';
import type { Delivery } from './modules/notifications/delivery.js';
import { brevoSender, logSender } from './modules/notifications/email.js';
import { fcmSender } from './modules/notifications/push.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { apiKeyRoutes, integrationDocsRoute, integrationRoutes } from './modules/integration/routes.js';
import { webhookRoutes } from './modules/webhooks/routes.js';
import { errorText, Monitor } from './modules/system/monitor.js';
import { systemRoutes } from './modules/system/routes.js';

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
    /** How notifications reach people by email and push (null channels aren't set up). */
    delivery: Delivery;
    /** Recent errors and background-loop health, in memory (see modules/system/monitor.ts). */
    monitor: Monitor;
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
  delivery,
}: {
  config: Config;
  db: Db;
  clock?: () => number;
  /** Overrides for tests (e.g. a test root certificate). */
  attestation?: Partial<AndroidAttestationPolicy>;
  /** Overrides for tests (fake email and push). */
  delivery?: Partial<Delivery>;
}) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    // One line per request (below) instead of Fastify's two: logging was a tenth of the CPU under load.
    disableRequestLogging: true,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
  }).withTypeProvider<ZodTypeProvider>();

  registerRequestContext(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('now', () => new Date(clock()));
  app.decorate('monitor', new Monitor());
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
  app.decorate('delivery', {
    email:
      config.EMAIL_PROVIDER === 'brevo'
        ? brevoSender(config.BREVO_API_KEY!, config.EMAIL_FROM!)
        : config.EMAIL_PROVIDER === 'log'
          ? logSender(app.log)
          : null,
    push: config.FCM_SERVICE_ACCOUNT ? fcmSender(config.FCM_SERVICE_ACCOUNT) : null,
    emailDailyLimit: config.EMAIL_DAILY_LIMIT,
    publicUrl: config.PUBLIC_URL,
    ...delivery,
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
      const scope = data.route.config?.apiKey;
      if (scope) {
        // Marks what API keys can call; the integration docs list exactly these.
        const schema = result.schema as Record<string, unknown>;
        schema['x-api-key-scope'] = scope;
        const note = scope === 'any' ? 'API keys: any key.' : `API keys: needs the \`${scope}\` scope.`;
        schema.description = schema.description ? `${String(schema.description)}\n\n${note}` : note;
      }
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

  app.addHook('onResponse', async (req, reply) => {
    const entry = { method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.error(entry, 'request failed');
    else if (reply.elapsedTime > 2000) req.log.warn(entry, 'slow request');
    else req.log.info(entry, 'request');
  });

  // Every response: browsers mustn't guess content types; in production, HTTPS only
  // (the hosting platform terminates TLS, so this header has to come from here).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    if (config.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

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
        summary: 'For uptime monitors: 200 when the server, its database and its background work are all running',
        response: {
          200: z.object({ status: z.literal('ok') }),
          503: z.object({ status: z.literal('error'), problems: z.array(z.string()) }),
        },
      },
    },
    async (_req, reply) => {
      const problems = app.monitor.stalled().map((name) => `background work stalled: ${name}`);
      try {
        await db.execute(sql`select 1`);
      } catch (err) {
        problems.unshift(`database unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (problems.length) return reply.code(503).send({ status: 'error' as const, problems });
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
  await app.register(reportRoutes, { prefix: '/v1/reports' });
  await app.register(correctionRoutes, { prefix: '/v1/corrections' });
  await app.register(notificationRoutes, { prefix: '/v1/notifications' });
  await app.register(auditRoutes, { prefix: '/v1/audit' });
  await app.register(apiKeyRoutes, { prefix: '/v1/api-keys' });
  await app.register(webhookRoutes, { prefix: '/v1/webhooks' });
  await app.register(integrationRoutes, { prefix: '/v1/integration' });
  await app.register(integrationDocsRoute);
  await app.register(systemRoutes, { prefix: '/v1/platform/system' });

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
  req.server.monitor.recordError(`${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`, errorText(err));
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
