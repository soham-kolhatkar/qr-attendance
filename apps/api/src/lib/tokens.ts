import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Role } from '../db/schema.js';

const ISSUER = 'qra-api';
const AUDIENCE = 'qra';

export type AccessTokenClaims = {
  sub: string;
  role: Role;
  /** Institute id; null for platform admins. */
  inst: string | null;
};

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ role: claims.role, inst: claims.inst })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

/** Returns the claims, or null if the token is invalid or expired. */
export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null;
    return { sub: payload.sub, role: payload.role as Role, inst: (payload.inst as string | null) ?? null };
  } catch {
    return null;
  }
}

/** A new opaque refresh token. Only its hash is ever stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
