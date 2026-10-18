import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import { type ApiScope, apiKeys, institutes, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { base32Encode } from '../../lib/base32.js';
import { AppError, notFound, unauthorized } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';

/**
 * API keys look like "qra_7k2m9x4q1wab_<40 characters>". The first part (the prefix) is
 * public: it identifies the key in lists and logs. Only a SHA-256 of the rest is stored;
 * a key that is lost can't be recovered, only replaced.
 */
const KEY_PATTERN = /^(qra_[a-z2-7]{12})_([a-z2-7]{40})$/;

const random = (bytes: number, length: number) => base32Encode(randomBytes(bytes)).toLowerCase().slice(0, length);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function generateApiKey() {
  const prefix = `qra_${random(8, 12)}`;
  const secret = random(25, 40);
  return { key: `${prefix}_${secret}`, prefix, secretHash: sha256(secret) };
}

export const looksLikeApiKey = (token: string) => token.startsWith('qra_');

export type ApiKeyDto = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  status: 'active' | 'expired' | 'revoked';
  createdBy: { id: string; fullName: string };
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
};

const creator = alias(users, 'creator');

async function selectKeys(db: Db, instituteId: string, now: Date, id?: string): Promise<ApiKeyDto[]> {
  const rows = await db
    .select({ key: apiKeys, creator: { id: creator.id, fullName: creator.fullName } })
    .from(apiKeys)
    .innerJoin(creator, eq(creator.id, apiKeys.createdBy))
    .where(and(eq(apiKeys.instituteId, instituteId), id ? eq(apiKeys.id, id) : undefined))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(({ key: k, creator: c }) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    status: k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= now ? 'expired' : 'active',
    createdBy: c,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: k.lastUsedIp,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  }));
}

export const listApiKeys = (db: Db, instituteId: string, now: Date) => selectKeys(db, instituteId, now);

/** Returns the key itself once; afterwards only its prefix is ever shown. */
export async function createApiKey(
  db: Db,
  auth: InstituteAuthContext,
  input: { name: string; scopes: ApiScope[]; expiresAt?: string },
  now: Date,
  ip?: string,
): Promise<{ key: string; apiKey: ApiKeyDto }> {
  const { key, prefix, secretHash } = generateApiKey();
  const scopes = [...new Set(input.scopes)];
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        instituteId: auth.instituteId,
        name: input.name,
        prefix,
        secretHash,
        scopes,
        createdBy: auth.userId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning({ id: apiKeys.id });
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row!.id,
      data: { name: input.name, prefix, scopes, expiresAt: input.expiresAt ?? null },
      ip,
    });
    return row!.id;
  });
  const [apiKey] = await selectKeys(db, auth.instituteId, now, id);
  return { key, apiKey: apiKey! };
}

/** Stops the key working at once. Revoked keys stay listed, for the record. */
export async function revokeApiKey(db: Db, auth: InstituteAuthContext, id: string, now: Date, ip?: string): Promise<ApiKeyDto> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: now, revokedBy: auth.userId })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.instituteId, auth.instituteId)))
      .returning({ name: apiKeys.name, prefix: apiKeys.prefix });
    if (!row) throw notFound('API key');
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: id,
      data: { name: row.name, prefix: row.prefix },
      ip,
    });
  });
  const [apiKey] = await selectKeys(db, auth.instituteId, now, id);
  return apiKey!;
}

const invalidKey = (message = 'API key is invalid, revoked or expired') => unauthorized(message, 'API_KEY_INVALID');

/** How often a key's "last used" time is written (it's for people, not to the second). */
const LAST_USED_EVERY_MS = 60_000;

/**
 * Checks an API key. A key acts as the admin who created it, so it only works while that
 * person is an active admin of an active institute.
 */
export async function authenticateApiKey(db: Db, token: string, ip: string, now: Date) {
  const match = KEY_PATTERN.exec(token);
  if (!match) throw invalidKey();
  const [, prefix, secret] = match;
  const [row] = await db
    .select({
      key: apiKeys,
      creatorRole: users.role,
      creatorStatus: users.status,
      creatorInstitute: users.instituteId,
      instituteStatus: institutes.status,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .innerJoin(institutes, eq(institutes.id, apiKeys.instituteId))
    .where(eq(apiKeys.prefix, prefix!))
    .limit(1);
  const expected = Buffer.from(row?.key.secretHash ?? '0'.repeat(64), 'hex');
  const given = Buffer.from(sha256(secret!), 'hex');
  if (!row || !timingSafeEqual(expected, given)) throw invalidKey();
  const { key } = row;
  if (key.revokedAt || (key.expiresAt && key.expiresAt <= now)) throw invalidKey();
  if (row.instituteStatus !== 'active') throw unauthorized('Institute is suspended', 'INSTITUTE_SUSPENDED');
  if (row.creatorStatus !== 'active' || row.creatorRole !== 'admin' || row.creatorInstitute !== key.instituteId) {
    throw invalidKey('The admin who created this API key is no longer an active admin; ask an admin to create a new key');
  }
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await db.update(apiKeys).set({ lastUsedAt: now, lastUsedIp: ip }).where(eq(apiKeys.id, key.id));
  }
  const auth: InstituteAuthContext = { userId: key.createdBy, role: 'admin', instituteId: key.instituteId };
  return { auth, key: { id: key.id, name: key.name, scopes: key.scopes } };
}

/**
 * Requests per key per minute (a fixed one-minute window, counted by each server). Returns
 * the seconds to wait when over the limit, else 0.
 */
const windows = new Map<string, { start: number; count: number }>();
export function overRateLimit(keyId: string, limit: number, now: number): number {
  const minute = Math.floor(now / 60_000) * 60_000;
  const w = windows.get(keyId);
  if (!w || w.start !== minute) {
    windows.set(keyId, { start: minute, count: 1 });
    if (windows.size > 10_000) for (const [id, old] of windows) if (old.start !== minute) windows.delete(id);
    return 0;
  }
  w.count += 1;
  return w.count > limit ? Math.ceil((minute + 60_000 - now) / 1000) : 0;
}

export const rateLimited = (limit: number) =>
  new AppError(429, 'RATE_LIMITED', `Too many requests with this API key: at most ${limit} a minute`);
