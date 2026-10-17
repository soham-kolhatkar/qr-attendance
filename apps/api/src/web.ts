import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Paths that belong to the API, never to the web app. */
const API_PREFIXES = ['/v1/', '/docs', '/health'];

/**
 * Serves the built web app: hashed assets with long caching, and index.html for every
 * other GET so client-side routes (e.g. /sessions/123/projector) work on reload.
 * Returns the not-found handler to use, which falls back to index.html for page URLs.
 */
export async function serveWebApp(
  app: FastifyInstance,
  distDir: string,
): Promise<(req: FastifyRequest, reply: FastifyReply) => boolean> {
  const indexHtml = await readFile(join(distDir, 'index.html'), 'utf8').catch(() => {
    throw new Error(`SERVE_WEB is on but ${distDir}/index.html is missing; build the web app first`);
  });

  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    index: false,
    wildcard: true,
    // swagger-ui registers its own copy; avoid clashing reply decorators.
    decorateReply: false,
    setHeaders(reply, path) {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  const sendIndex = (reply: FastifyReply) =>
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'same-origin')
      .header('x-frame-options', 'DENY')
      .send(indexHtml);

  // "/" is the dist folder itself, which the static plugin refuses to list.
  app.get('/', { schema: { hide: true } }, (_req, reply) => sendIndex(reply));

  return (req, reply) => {
    const path = req.url.split('?')[0]!;
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return false;
    void sendIndex(reply);
    return true;
  };
}
