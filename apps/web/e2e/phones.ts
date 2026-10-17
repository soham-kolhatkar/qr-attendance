import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE_URL } from '../playwright.config';

/**
 * Test phones. A real phone proves its key with a hardware attestation chained to
 * Google, which a browser test can't produce — so, against the local test database,
 * the phone is written straight into the database with a key this test holds, and
 * scans are signed with that key exactly as the app signs them.
 */

export type TestPhone = { deviceId: string; sign(qr: string): string };

/** Links a phone (or a pending switch to a new one) for a DEMO student. Local runs only. */
export async function insertPhone(
  username: string,
  { status = 'active', model = 'Pixel 8' }: { status?: 'active' | 'pending'; model?: string } = {},
): Promise<TestPhone> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO devices (institute_id, user_id, platform, status, public_key, key_hash, phone_hash, attestation,
                            model, os_version, app_version, activated_at)
       SELECT u.institute_id, u.id, 'android', $2::device_status, $3, $4, $5, $6, $7, '16', '1.0.0', CASE WHEN $2 = 'active' THEN now() END
       FROM users u JOIN institutes i ON i.id = u.institute_id
       WHERE i.code = 'DEMO' AND u.username = $1
       RETURNING id`,
      [
        username,
        status,
        spki.toString('base64'),
        createHash('sha256').update(spki).digest('hex'),
        createHash('sha256').update(`${username}:${model}:${Math.random()}`).digest('hex'),
        JSON.stringify({ securityLevel: 'tee', bootState: 'verified', bootloaderLocked: true, osPatchLevel: 202609, attestationVersion: 300 }),
        model,
      ],
    );
    const deviceId = rows[0]!.id;
    return {
      deviceId,
      sign: (qr) => sign('sha256', Buffer.from(`QAS1|${deviceId}|${qr}`), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
    };
  } finally {
    await pool.end();
  }
}
