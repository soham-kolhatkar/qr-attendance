import { SecurityLevel, VerifiedBootState } from '@peculiar/asn1-android';
import { describe, expect, it } from 'vitest';
import {
  type AndroidAttestationPolicy,
  AttestationError,
  GOOGLE_ATTESTATION_ROOTS,
  googleRevocationList,
  verifyAndroidAttestation,
} from '../src/modules/devices/attestation.js';
import { type AttestOptions, attestNewKey, otherAuthority, TEST_PACKAGE, TEST_SIGNING_DIGEST, testAuthority } from './attestation-fixture.js';

const CHALLENGE = 'D1.0123456789abcdef0123456789abcdef.1900000000.AAAAAAAAAAAAAAAAAAAAAA';

async function policy(overrides: Partial<AndroidAttestationPolicy> = {}): Promise<AndroidAttestationPolicy> {
  return {
    roots: [(await testAuthority).rootPem],
    packageName: TEST_PACKAGE,
    signingCertDigests: [TEST_SIGNING_DIGEST],
    revokedSerials: async () => new Set(),
    ...overrides,
  };
}

async function verify(opts: Partial<AttestOptions> = {}, overrides: Partial<AndroidAttestationPolicy> = {}) {
  const key = await attestNewKey({ challenge: CHALLENGE, ...opts });
  return verifyAndroidAttestation(key.chain, Buffer.from(CHALLENGE), await policy(overrides), new Date());
}

async function expectRejected(promise: Promise<unknown>, reason: RegExp) {
  await expect(promise).rejects.toThrow(AttestationError);
  await expect(promise).rejects.toThrow(reason);
}

describe('Android key attestation', () => {
  it('accepts a hardware key made by our app for this challenge, and reports the phone state', async () => {
    const result = await verify();
    expect(result.publicKey.length).toBe(91); // P-256 SubjectPublicKeyInfo
    expect(result.attestation).toEqual({
      securityLevel: 'tee',
      bootState: 'verified',
      bootloaderLocked: true,
      osPatchLevel: 202609,
      attestationVersion: 200,
    });
    const strongbox = await verify({ securityLevel: SecurityLevel.strongBox });
    expect(strongbox.attestation.securityLevel).toBe('strongbox');
  });

  it('reads newer KeyMint attestations, including fields added by future Android releases', async () => {
    for (const attestationVersion of [300, 400, 500]) {
      const result = await verify({ attestationVersion, futureFields: true });
      expect(result.attestation).toMatchObject({ attestationVersion, bootState: 'verified', osPatchLevel: 202609 });
    }
  });

  it('reports a rooted phone (unlocked bootloader) without refusing it', async () => {
    const result = await verify({ bootState: VerifiedBootState.unverified, locked: false });
    expect(result.attestation).toMatchObject({ bootState: 'unverified', bootloaderLocked: false });
  });

  it('refuses a key made for a different challenge (a replayed attestation)', async () => {
    const key = await attestNewKey({ challenge: CHALLENGE });
    await expectRejected(
      verifyAndroidAttestation(key.chain, Buffer.from(`${CHALLENGE}x`), await policy(), new Date()),
      /challenge/,
    );
  });

  it('refuses chains that do not lead to a trusted root', async () => {
    await expectRejected(verify({ authority: otherAuthority() }), /trusted Google root/);
    await expectRejected(verify({}, { roots: GOOGLE_ATTESTATION_ROOTS }), /trusted Google root/);
  });

  it('refuses a chain whose links are not signed by each other', async () => {
    const a = await attestNewKey({ challenge: CHALLENGE });
    const b = await attestNewKey({ challenge: CHALLENGE, authority: otherAuthority() });
    const spliced = [a.chain[0]!, b.chain[1]!, a.chain[2]!];
    await expectRejected(verifyAndroidAttestation(spliced, Buffer.from(CHALLENGE), await policy(), new Date()), /not signed by its issuer/);
  });

  it('refuses software keys (emulators, keys outside secure hardware)', async () => {
    await expectRejected(verify({ securityLevel: SecurityLevel.software }), /secure hardware/);
  });

  it('refuses imported keys and keys that are not for signing', async () => {
    await expectRejected(verify({ origin: 2 }), /imported/);
    await expectRejected(verify({ purposes: [0, 1] }), /signing key/);
  });

  it('refuses keys made by another app or a re-signed copy of ours', async () => {
    await expectRejected(verify({ packageName: 'com.example.cheat' }), /Unexpected app/);
    await expectRejected(verify({ signingDigest: 'cd'.repeat(32) }), /signed with our certificate/);
    // Without configured fingerprints, any signer is accepted (development).
    await expect(verify({ signingDigest: 'cd'.repeat(32) }, { signingCertDigests: [] })).resolves.toBeDefined();
  });

  it('refuses revoked and expired attestation certificates', async () => {
    const key = await attestNewKey({ challenge: CHALLENGE });
    await expectRejected(
      verifyAndroidAttestation(key.chain, Buffer.from(CHALLENGE), await policy({ revokedSerials: async () => new Set([key.serial]) }), new Date()),
      /revoked/,
    );
    await expectRejected(verify({ expiredIntermediate: true }), /expired/);
  });

  it('refuses unreadable input', async () => {
    await expectRejected(verifyAndroidAttestation(['bm90IGEgY2VydA==', 'eHg='], Buffer.from(CHALLENGE), await policy(), new Date()), /could not be read/);
    const key = await attestNewKey({ challenge: CHALLENGE });
    await expectRejected(verifyAndroidAttestation(key.chain.slice(0, 1), Buffer.from(CHALLENGE), await policy(), new Date()), /too short/);
  });

  it('accepts a chain that leaves out the root certificate', async () => {
    const key = await attestNewKey({ challenge: CHALLENGE });
    await expect(verifyAndroidAttestation(key.chain.slice(0, 2), Buffer.from(CHALLENGE), await policy(), new Date())).resolves.toBeDefined();
  });
});

describe("Google's revocation list", () => {
  const log = { warnings: [] as string[], warn(msg: string) { this.warnings.push(msg); } };

  it('normalises serial numbers, caches the list and keeps the last list when Google is unreachable', async () => {
    let calls = 0;
    let fail = false;
    const fakeFetch = (async () => {
      calls++;
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify({ entries: { '00C35747A0': { status: 'REVOKED' }, '1228286566665971148': {} } }));
    }) as unknown as typeof fetch;

    const list = googleRevocationList(log, fakeFetch, 0);
    expect([...(await list())]).toEqual(['c35747a0', '1228286566665971148']);
    fail = true;
    expect((await list()).has('c35747a0')).toBe(true);
    expect(log.warnings[0]).toMatch(/offline/);

    const cached = googleRevocationList(log, fakeFetch, 60_000);
    fail = false;
    calls = 0;
    await cached();
    await cached();
    expect(calls).toBe(1);
  });
});
