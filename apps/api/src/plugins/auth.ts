import { eq } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { institutes, type Role, users } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export type AuthContext = {
  userId: string;
  role: Role;
  instituteId: string | null;
};

/** For routes that only institute users (never platform admins) can call. */
export type InstituteAuthContext = AuthContext & { instituteId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Verifies the bearer token, then re-reads the user from the database so that a
 * disabled user, suspended institute or changed role takes effect immediately rather
 * than when the access token expires.
 */
async function authenticate(request: FastifyRequest): Promise<AuthContext> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  const claims = await verifyAccessToken(header.slice('Bearer '.length), request.server.config.JWT_SECRET);
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

/** preHandler: require a logged-in user, optionally with one of the given roles. */
export function guard(...roles: Role[]): preHandlerAsyncHookHandler {
  return async (request) => {
    const auth = await authenticate(request);
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
