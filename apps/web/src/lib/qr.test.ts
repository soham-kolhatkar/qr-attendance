import { describe, expect, it } from 'vitest';
import { createQrGenerator, QR_TEST_VECTOR, stepAt } from './qr';

describe('browser QR generation', () => {
  it('matches the API byte for byte', async () => {
    const generate = await createQrGenerator(QR_TEST_VECTOR.sessionId, QR_TEST_VECTOR.secret);
    expect(await generate(QR_TEST_VECTOR.step)).toBe(QR_TEST_VECTOR.payload);
  });

  it('changes every step', async () => {
    const generate = await createQrGenerator(QR_TEST_VECTOR.sessionId, QR_TEST_VECTOR.secret);
    expect(await generate(QR_TEST_VECTOR.step + 1)).not.toBe(QR_TEST_VECTOR.payload);
    expect(stepAt(10_000, 5)).toBe(2);
  });
});
