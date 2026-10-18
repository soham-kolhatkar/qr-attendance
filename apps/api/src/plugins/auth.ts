import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { type ApiScope, institutes, type Role, users } from '../db/schema.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { requestContext } from '../lib/request-context.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { authenticateApiKey, looksLikeApiKey, overRateLimit, rateLimited } from '../modules/integration/keys.js';

export type AuthContext = {
  userId: string;
  role: Role;
  instituteId: string | null;
  /** Set when the request uses an API key; it then acts as the admin who created the key. */
  apiKey?: { id: string; name: string; scopes: ApiScope[] };
};

/** For routes that only institute users (never platform admins) can call. */
export type InstituteAuthContext = AuthContext & { instituteId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyContextConfig {
    /**
     * API keys with this scope may call the route ("any": every key). Routes without it
     * refuse API keys, so only what's listed in the integration docs is reachable with one.
     */
    apiKey?: ApiScope | 'any';
  }
}

/**
 * Verifies the bearer token, then re-reads the user from the database so that a
 * disabled user, suspended institute or changed role takes effect immediately rather
 * than when the access token expires.
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const token = header.slice('Bearer '.length);
  if (looksLikeApiKey(token)) return authenticateWithApiKey(request, reply, token);

  const claims = await verifyAccessToken(token, request.server.config.JWT_SECRET);
  if (!claims) throw unauthorized('Session expired or invalid', 'TOKEN_INVALID');

  const [row] = await request.server.db
    .select({
      id: users.id,
      role: users.role,
      instituteId: users.instituteId,
      status: users.status,
      instituteStatus: institutes.status,
    })
    .from(users)
    .leftJoin(institutes, eq(institutes.id, users.instituteId))
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!row || row.status !== 'active') throw unauthorized('Account is disabled or no longer exists', 'ACCOUNT_INACTIVE');
  if (row.instituteId && row.instituteStatus !== 'active') {
    throw unauthorized('Institute is suspended', 'INSTITUTE_SUSPENDED');
  }

  return { userId: row.id, role: row.role, instituteId: row.instituteId };
}

/** An integration's API key, for the routes that accept one (see FastifyContextConfig.apiKey). */
async function authenticateWithApiKey(request: FastifyRequest, reply: FastifyReply, token: string): Promise<AuthContext> {
  const scope = request.routeOptions.config.apiKey;
  if (!scope) throw new AppError(403, 'API_KEY_NOT_ALLOWED', 'API keys can’t use this endpoint. The ones they can are listed at /docs/integration.');
  const { server } = request;
  const { auth, key } = await authenticateApiKey(server.db, token, request.ip, server.now());
  if (scope !== 'any' && !key.scopes.includes(scope)) {
    throw new AppError(403, 'API_KEY_SCOPE', `This API key doesn’t have the "${scope}" scope`);
  }
  const wait = overRateLimit(key.id, server.config.API_KEY_RATE_LIMIT, server.now().getTime());
  if (wait > 0) {
    reply.header('retry-after', String(wait));
    throw rateLimited(server.config.API_KEY_RATE_LIMIT);
  }
  const context = requestContext();
  if (context) context.apiKey = { id: key.id, name: key.name };
  return { ...auth, apiKey: key };
}

/** preHandler: require a logged-in user (or an allowed API key), optionally with one of the given roles. */
export function guard(...roles: Role[]): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (roles.length > 0 && !roles.includes(auth.role)) throw forbidden();
    request.auth = auth;
  };
}

export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function getInstituteAuth(request: FastifyRequest): InstituteAuthContext {
  const auth = getAuth(request);
  if (!auth.instituteId) throw forbidden('This action is only available to institute users');
  return auth as InstituteAuthContext;
}
