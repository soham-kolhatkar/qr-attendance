import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db, DbOrTx } from '../../db/client.js';
import { institutes, refreshTokens, type Role, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { unauthorized } from '../../lib/errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashToken, signAccessToken } from '../../lib/tokens.js';
import { toUserDto, type UserDto } from '../users/dto.js';

export type ClientMeta = { ip: string; userAgent?: string };

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
};

export type LoginResult = TokenPair & { user: UserDto };

/**
 * A rotated refresh token presented again within this window is treated as a client
 * race (two tabs refreshing at once) rather than theft, so the session is not killed.
 */
const REFRESH_REUSE_GRACE_MS = 10_000;

const invalidCredentials = () => unauthorized('Invalid institute code, username or password', 'INVALID_CREDENTIALS');

async function issueTokens(
  db: DbOrTx,
  config: Config,
  user: { id: string; role: Role; instituteId: string | null },
  familyId: string,
  meta: ClientMeta,
): Promise<TokenPair & { refreshTokenId: string }> {
  const refreshToken = generateRefreshToken();
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    .returning({ id: refreshTokens.id });

  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, inst: user.instituteId },
    config.JWT_SECRET,
    config.ACCESS_TOKEN_TTL_SECONDS,
  );
  return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, refreshTokenId: row!.id };
}

function stripId({ refreshTokenId: _, ...pair }: TokenPair & { refreshTokenId: string }): TokenPair {
  return pair;
}

export async function login(
  db: Db,
  config: Config,
  input: { instituteCode?: string; username: string; password: string },
  meta: ClientMeta,
): Promise<LoginResult> {
  let institute: typeof institutes.$inferSelect | undefined;
  if (input.instituteCode) {
    [institute] = await db.select().from(institutes).where(eq(institutes.code, input.instituteCode)).limit(1);
    if (!institute) {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
  }

  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        institute ? eq(users.instituteId, institute.id) : isNull(users.instituteId),
        eq(users.username, input.username),
      ),
    )
    .limit(1);

  if (!user) {
    await verifyAgainstDummy(input.password);
    throw invalidCredentials();
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await writeAudit(db, {
      instituteId: user.instituteId,
      actorUserId: user.id,
      action: 'auth.login_failed',
      ip: meta.ip,
    });
    throw invalidCredentials();
  }

  // Only reveal account state once the password has been proven.
  if (user.status !== 'active') throw unauthorized('Your account is disabled', 'ACCOUNT_INACTIVE');
  if (institute && institute.status !== 'active') throw unauthorized('Institute is suspended', 'INSTITUTE_SUSPENDED');

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    const tokens = await issueTokens(tx, config, user, randomUUID(), meta);
    await writeAudit(tx, { instituteId: user.instituteId, actorUserId: user.id, action: 'auth.login', ip: meta.ip });
    return { ...stripId(tokens), user: toUserDto(updated!) };
  });
}

export async function refresh(db: Db, config: Config, refreshToken: string, meta: ClientMeta): Promise<TokenPair> {
  // Reuse handling must commit before we report the error, so the transaction returns
  // an outcome instead of throwing.
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        token: refreshTokens,
        user: { id: users.id, role: users.role, instituteId: users.instituteId, status: users.status },
        instituteStatus: institutes.status,
      })
      .from(refreshTokens)
      .innerJoin(users, eq(users.id, refreshTokens.userId))
      .leftJoin(institutes, eq(institutes.id, users.instituteId))
      .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)))
      .for('update', { of: refreshTokens })
      .limit(1);

    if (!row) return { ok: false as const };
    const { token, user } = row;
    const now = new Date();

    if (token.revokedAt) {
      if (token.replacedById && now.getTime() - token.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        return { ok: false as const };
      }
      // An already-rotated token came back: assume it was stolen and end the whole login.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, token.familyId), isNull(refreshTokens.revokedAt)));
      await writeAudit(tx, {
        instituteId: user.instituteId,
        actorUserId: user.id,
        action: 'auth.refresh_reuse_detected',
        data: { familyId: token.familyId },
        ip: meta.ip,
      });
      return { ok: false as const };
    }

    if (token.expiresAt <= now) return { ok: false as const };
    if (user.status !== 'active') return { ok: false as const };
    if (user.instituteId && row.instituteStatus !== 'active') return { ok: false as const };

    const next = await issueTokens(tx, config, user, token.familyId, meta);
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now, replacedById: next.refreshTokenId })
      .where(eq(refreshTokens.id, token.id));
    return { ok: true as const, tokens: stripId(next) };
  });

  if (!outcome.ok) throw unauthorized('Session expired, please log in again', 'REFRESH_INVALID');
  return outcome.tokens;
}

/** Ends the login that `refreshToken` belongs to. Unknown tokens are ignored. */
export async function logout(db: Db, refreshToken: string): Promise<void> {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)))
    .limit(1);
  if (!row) return;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllSessions(db: DbOrTx, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/** Changes the password, signs out every other session and returns fresh tokens for this one. */
export async function changePassword(
  db: Db,
  config: Config,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  meta: ClientMeta,
): Promise<TokenPair> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized();
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  }

  const passwordHash = await hashPassword(input.newPassword);
  return db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId));
    await revokeAllSessions(tx, userId);
    await writeAudit(tx, {
      instituteId: user.instituteId,
      actorUserId: userId,
      action: 'auth.password_changed',
      ip: meta.ip,
    });
    return stripId(await issueTokens(tx, config, user, randomUUID(), meta));
  });
}
