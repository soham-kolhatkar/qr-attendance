import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * One-time challenges for linking a phone. The phone's hardware writes the challenge
 * into the key's attestation, which proves the key was created just now, for this
 * student. Challenges are self-contained (signed, with the user and an expiry) so no
 * storage is needed; replaying an old attestation gains nothing, because the private
 * key never leaves the phone that made it.
 *
 * Format: D1.<user id, 32 hex>.<expiry, unix seconds>.<HMAC, 16 bytes base64url> (~80
 * bytes; Android accepts up to 128).
 */

export const CHALLENGE_TTL_SECONDS = 10 * 60;

const mac = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`device-challenge:${body}`).digest().subarray(0, 16).toString('base64url');

export function issueChallenge(secret: string, userId: string, now: Date): { challenge: string; expiresAt: Date } {
  const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + CHALLENGE_TTL_SECONDS * 1000);
  const body = `D1.${userId.replaceAll('-', '')}.${expiresAt.getTime() / 1000}`;
  return { challenge: `${body}.${mac(secret, body)}`, expiresAt };
}

export function isChallengeValid(secret: string, userId: string, challenge: string, now: Date): boolean {
  const parts = challenge.split('.');
  if (parts.length !== 4 || parts[0] !== 'D1' || parts[1] !== userId.replaceAll('-', '')) return false;
  const expiresAt = Number(parts[2]) * 1000;
  if (!Number.isSafeInteger(expiresAt) || now.getTime() > expiresAt) return false;
  const expected = Buffer.from(mac(secret, parts.slice(0, 3).join('.')));
  const given = Buffer.from(parts[3]!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
