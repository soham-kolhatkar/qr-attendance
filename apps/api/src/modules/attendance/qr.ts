/**
 * Rotating QR codes.
 *
 * Each session has a random 256-bit secret. Time is cut into steps of
 * `rotationSeconds`; the code for step N is
 *
 *     QA1.<session id, base32>.<N>.<HMAC-SHA256(secret, "QA1.<session>.<N>"), first 80 bits, base32>
 *
 * The faculty screen derives codes locally from the secret, so a network blip in the
 * classroom never freezes the QR. Nobody without the secret can produce a valid code
 * for a future step, and a code for an old step expires within seconds — which is what
 * makes a forwarded screenshot useless.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Decode, base32Encode } from '../../lib/base32.js';

const PREFIX = 'QA1';
const MAC_BYTES = 10;

export function generateQrSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function stepAt(epochMs: number, rotationSeconds: number): number {
  return Math.floor(epochMs / (rotationSeconds * 1000));
}

/** When step `step` stops being displayed (start of the next step). */
export function stepEndsAt(step: number, rotationSeconds: number): number {
  return (step + 1) * rotationSeconds * 1000;
}

function uuidToBytes(uuid: string): Uint8Array {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest().subarray(0, MAC_BYTES);
}

export function qrPayload(sessionId: string, secret: string, step: number): string {
  const body = `${PREFIX}.${base32Encode(uuidToBytes(sessionId))}.${step}`;
  return `${body}.${base32Encode(mac(secret, body))}`;
}

export type ParsedQr = { sessionId: string; step: number; body: string; mac: Uint8Array };

/** Structural parse only; the MAC still has to be checked with the session's secret. */
export function parseQrPayload(payload: string): ParsedQr | null {
  const parts = payload.trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, sessionPart, stepPart, macPart] = parts as [string, string, string, string];
  const sessionBytes = base32Decode(sessionPart);
  const macBytes = base32Decode(macPart);
  if (!sessionBytes || sessionBytes.length !== 16 || !macBytes || macBytes.length !== MAC_BYTES) return null;
  if (!/^\d{1,15}$/.test(stepPart)) return null;
  return {
    sessionId: bytesToUuid(sessionBytes),
    step: Number(stepPart),
    body: `${PREFIX}.${sessionPart}.${stepPart}`,
    mac: macBytes,
  };
}

export function isQrMacValid(parsed: ParsedQr, secret: string): boolean {
  return timingSafeEqual(mac(secret, parsed.body), parsed.mac);
}

export type QrFreshness = 'fresh' | 'expired' | 'future';

/**
 * A code is accepted from the moment it is shown until `graceSeconds` after the screen
 * moved on to the next one. One step "from the future" is tolerated for a faculty clock
 * slightly ahead of ours.
 */
export function qrFreshness(step: number, nowMs: number, rotationSeconds: number, graceSeconds: number): QrFreshness {
  const current = stepAt(nowMs, rotationSeconds);
  if (step > current + 1) return 'future';
  if (nowMs > stepEndsAt(step, rotationSeconds) + graceSeconds * 1000) return 'expired';
  return 'fresh';
}
