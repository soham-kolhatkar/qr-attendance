import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from '../src/lib/base32.js';
import {
  generateQrSecret,
  isQrMacValid,
  parseQrPayload,
  qrFreshness,
  qrPayload,
  stepAt,
} from '../src/modules/attendance/qr.js';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = randomBytes(n);
      expect(Buffer.from(base32Decode(base32Encode(bytes))!)).toEqual(bytes);
    }
  });

  it('rejects characters outside the alphabet', () => {
    expect(base32Decode('abc')).toBeNull();
    expect(base32Decode('A1')).toBeNull();
  });
});

describe('QR payload', () => {
  const sessionId = randomUUID();
  const secret = generateQrSecret();

  it('fits QR alphanumeric mode and stays short', () => {
    const payload = qrPayload(sessionId, secret, stepAt(Date.now(), 5));
    expect(payload).toMatch(/^[0-9A-Z.]+$/);
    expect(payload.length).toBeLessThanOrEqual(61); // QR version 3-M capacity in alphanumeric mode
  });

  it('parses back to the session and step, and verifies with the right secret only', () => {
    const payload = qrPayload(sessionId, secret, 123456789);
    const parsed = parseQrPayload(payload)!;
    expect(parsed).toMatchObject({ sessionId, step: 123456789 });
    expect(isQrMacValid(parsed, secret)).toBe(true);
    expect(isQrMacValid(parsed, generateQrSecret())).toBe(false);
  });

  it('detects tampering with the step or the session', () => {
    const payload = qrPayload(sessionId, secret, 1000);
    const nextStep = payload.replace('.1000.', '.1001.');
    expect(isQrMacValid(parseQrPayload(nextStep)!, secret)).toBe(false);

    const other = qrPayload(randomUUID(), secret, 1000).split('.')[1]!;
    const swapped = payload.split('.');
    swapped[1] = other;
    expect(isQrMacValid(parseQrPayload(swapped.join('.'))!, secret)).toBe(false);
  });

  it('rejects malformed payloads', () => {
    for (const bad of ['', 'hello', 'QA1.X.1.Y', 'QA2.AAAA.1.AAAA', `QA1.${'A'.repeat(26)}.-5.${'A'.repeat(16)}`]) {
      expect(parseQrPayload(bad)).toBeNull();
    }
  });
});

describe('QR freshness (5 s rotation, 10 s grace)', () => {
  const rotation = 5;
  const grace = 10;
  const t0 = 1_800_000_000_000; // a step boundary
  const step = stepAt(t0, rotation);

  it('accepts the code while shown and for the grace period after', () => {
    expect(qrFreshness(step, t0, rotation, grace)).toBe('fresh');
    expect(qrFreshness(step, t0 + 4_999, rotation, grace)).toBe('fresh');
    expect(qrFreshness(step, t0 + 15_000, rotation, grace)).toBe('fresh');
  });

  it('expires a code (e.g. a forwarded screenshot) after that', () => {
    expect(qrFreshness(step, t0 + 15_001, rotation, grace)).toBe('expired');
    expect(qrFreshness(step, t0 + 60_000, rotation, grace)).toBe('expired');
  });

  it('tolerates one step of clock skew but not codes from further ahead', () => {
    expect(qrFreshness(step + 1, t0, rotation, grace)).toBe('fresh');
    expect(qrFreshness(step + 2, t0, rotation, grace)).toBe('future');
  });
});
