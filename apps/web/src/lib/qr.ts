/**
 * Browser-side QR code generation for the projector screen. Must produce exactly the
 * same text as the API's apps/api/src/modules/attendance/qr.ts:
 *
 *   QA1.<session id, base32>.<step>.<HMAC-SHA256(secret, body), first 10 bytes, base32>
 *
 * Both sides are tested against the same fixed example (QR_TEST_VECTOR) so they can
 * never drift apart.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAC_BYTES = 10;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function stepAt(epochMs: number, rotationSeconds: number): number {
  return Math.floor(epochMs / (rotationSeconds * 1000));
}

/** True where WebCrypto is available (HTTPS or localhost). Elsewhere fall back to the API. */
export const canGenerateLocally = () => typeof crypto !== 'undefined' && !!crypto.subtle;

/** Creates a generator for one session; the HMAC key is imported once. */
export async function createQrGenerator(sessionId: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', base64UrlToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sessionPart = base32Encode(uuidToBytes(sessionId));
  return async (step: number): Promise<string> => {
    const body = `QA1.${sessionPart}.${step}`;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    return `${body}.${base32Encode(mac.subarray(0, MAC_BYTES))}`;
  };
}

/** Shared with the API test suite: same inputs must give this exact payload. */
export const QR_TEST_VECTOR = {
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  step: 358432150,
  payload: 'QA1.B6H22W6ZZNDJ7ILFOCDHOKEVBY.358432150.LMNTYN7VZXCMUF5I',
};
