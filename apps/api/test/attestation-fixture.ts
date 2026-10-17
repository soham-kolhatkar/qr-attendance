import 'reflect-metadata'; // required by @peculiar/x509
import { generateKeyPairSync, type KeyObject, sign, webcrypto } from 'node:crypto';
import {
  AttestationApplicationId,
  AttestationPackageInfo,
  AuthorizationList,
  IntegerSet,
  KeyDescription,
  RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
  Version,
} from '@peculiar/asn1-android';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/x509';
import * as asn1js from 'asn1js';
import { KEY_ATTESTATION_OID, normalizeSerial } from '../src/modules/devices/attestation.js';
import { scanSigningMessage } from '../src/modules/devices/service.js';

/**
 * A stand-in for Google's attestation hierarchy: a test root and intermediate that
 * issue Android-style key attestation certificates for keys made in the test.
 */

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const YEAR = 365 * 24 * 3600 * 1000;

export const TEST_PACKAGE = 'com.qrattendance.student';
export const TEST_SIGNING_DIGEST = 'ab'.repeat(32);

let serial = 100;
const nextSerial = () => (serial++).toString(16).padStart(4, '0');

type Authority = {
  rootPem: string;
  root: x509.X509Certificate;
  rootKeys: webcrypto.CryptoKeyPair;
  intermediate: x509.X509Certificate;
  /** The intermediate's keys, which sign key certificates. */
  keys: webcrypto.CryptoKeyPair;
};

async function caCert(
  name: string,
  keys: webcrypto.CryptoKeyPair,
  issuer?: { cert: x509.X509Certificate; keys: webcrypto.CryptoKeyPair },
  validity = { from: new Date(Date.now() - YEAR), to: new Date(Date.now() + 10 * YEAR) },
) {
  return x509.X509CertificateGenerator.create({
    serialNumber: nextSerial(),
    subject: name,
    issuer: issuer?.cert.subject ?? name,
    notBefore: validity.from,
    notAfter: validity.to,
    publicKey: keys.publicKey,
    signingKey: (issuer?.keys ?? keys).privateKey,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
}

async function createAuthority(): Promise<Authority> {
  const rootKeys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const root = await caCert('CN=Test Attestation Root', rootKeys);
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const intermediate = await caCert('CN=Test Attestation Intermediate', keys, { cert: root, keys: rootKeys });
  return { rootPem: root.toString('pem'), root, rootKeys, intermediate, keys };
}

/** One authority per test process; the test app trusts its root. */
export const testAuthority = createAuthority();

export type AttestOptions = {
  challenge: string;
  packageName?: string;
  signingDigest?: string;
  securityLevel?: SecurityLevel;
  bootState?: VerifiedBootState;
  locked?: boolean;
  origin?: number;
  purposes?: number[];
  /** Sign with a different, untrusted authority. */
  authority?: Promise<Authority>;
  /** Expire the intermediate certificate. */
  expiredIntermediate?: boolean;
  attestationVersion?: number;
  /** Add authorization fields from a future Android release (unknown tags). */
  futureFields?: boolean;
};

export type FakePhoneKey = {
  privateKey: KeyObject;
  /** Certificate chain as the phone sends it: base64 DER, key certificate first. */
  chain: string[];
  /** Serial number of the key's certificate, as on Google's revocation list. */
  serial: string;
  sign(deviceId: string, qr: string): string;
};

/** Generates a P-256 key "inside a phone" and its attestation chain. */
export async function attestNewKey(opts: AttestOptions): Promise<FakePhoneKey> {
  const authority = await (opts.authority ?? testAuthority);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cryptoPublicKey = await webcrypto.subtle.importKey(
    'spki',
    publicKey.export({ type: 'spki', format: 'der' }),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );

  const appId = new AttestationApplicationId({
    packageInfos: [new AttestationPackageInfo({ packageName: new OctetString(Buffer.from(opts.packageName ?? TEST_PACKAGE)), version: 1 })],
    signatureDigests: [new OctetString(Buffer.from(opts.signingDigest ?? TEST_SIGNING_DIGEST, 'hex'))],
  });
  const level = opts.securityLevel ?? SecurityLevel.trustedEnvironment;
  const description = new KeyDescription({
    attestationVersion: opts.attestationVersion ?? Version.keyMint2,
    attestationSecurityLevel: level,
    keymasterVersion: opts.attestationVersion ?? 200,
    keymasterSecurityLevel: level,
    attestationChallenge: new OctetString(Buffer.from(opts.challenge, 'utf8')),
    uniqueId: new OctetString(new Uint8Array()),
    softwareEnforced: new AuthorizationList({
      creationDateTime: Date.now(),
      attestationApplicationId: new OctetString(AsnConvert.serialize(appId)),
    }),
    teeEnforced: new AuthorizationList({
      purpose: new IntegerSet(opts.purposes ?? [2]),
      algorithm: 3,
      keySize: 256,
      digest: new IntegerSet([4]),
      ecCurve: 1,
      origin: opts.origin ?? 0,
      rootOfTrust: new RootOfTrust({
        verifiedBootKey: new OctetString(Buffer.alloc(32, 7)),
        deviceLocked: opts.locked ?? true,
        verifiedBootState: opts.bootState ?? VerifiedBootState.verified,
        verifiedBootHash: new OctetString(Buffer.alloc(32, 9)),
      }),
      osVersion: 160000,
      osPatchLevel: 202609,
    }),
  });

  const intermediate = opts.expiredIntermediate
    ? await caCert(
        authority.intermediate.subject,
        authority.keys,
        { cert: authority.root, keys: authority.rootKeys },
        { from: new Date(Date.now() - 2 * YEAR), to: new Date(Date.now() - YEAR) },
      )
    : authority.intermediate;

  const keySerial = nextSerial();
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: keySerial,
    subject: 'CN=Android Keystore Key',
    issuer: intermediate.subject,
    // Phones put arbitrary dates on the key certificate; the server must not care.
    notBefore: new Date(0),
    notAfter: new Date('2048-01-01'),
    publicKey: cryptoPublicKey,
    signingKey: authority.keys.privateKey,
    signingAlgorithm: ALG,
    extensions: [new x509.Extension(KEY_ATTESTATION_OID, false, encode(description, opts.futureFields))],
  });

  return {
    privateKey,
    chain: [leaf, intermediate, authority.root].map((c) => Buffer.from(c.rawData).toString('base64')),
    serial: normalizeSerial(keySerial),
    sign: (deviceId, qr) => sign('sha256', scanSigningMessage(deviceId, qr), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

function encode(description: KeyDescription, futureFields = false): ArrayBuffer {
  const der = AsnConvert.serialize(description);
  if (!futureFields) return der;
  const seq = asn1js.fromBER(der).result as asn1js.Sequence;
  for (const list of seq.valueBlock.value.slice(6, 8) as asn1js.Sequence[]) {
    const unknown = (tagNumber: number, value: asn1js.BaseBlock) =>
      new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });
    list.valueBlock.value.splice(1, 0, unknown(851, new asn1js.OctetString({ valueHex: new Uint8Array([1, 2, 3]).buffer })));
    list.valueBlock.value.push(unknown(850, new asn1js.Integer({ value: 7 })));
  }
  return seq.toBER();
}

export const otherAuthority = () => createAuthority();
