import { timingSafeEqual, X509Certificate } from 'node:crypto';
import {
  AttestationApplicationId,
  NonStandardKeyDescription,
  type NonStandardAuthorizationList,
  SecurityLevel,
  VerifiedBootState,
} from '@peculiar/asn1-android';
import { AsnConvert, type OctetString } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import type { DeviceAttestation } from '../../db/schema.js';

/**
 * Android key attestation: when the app creates its signing key inside the phone's
 * secure hardware, the hardware issues a certificate chain for that key, ending at a
 * Google root. The first certificate carries a description of the key — including our
 * one-time challenge, the app that asked for it and the state of the phone — signed by
 * a key that only genuine Android hardware holds.
 *
 * https://developer.android.com/privacy-and-security/security-key-attestation
 */

export const KEY_ATTESTATION_OID = '1.3.6.1.4.1.11129.2.1.17';

/**
 * Google's hardware attestation roots, as published at https://android.googleapis.com/attestation/root
 * (RSA root re-issued in 2022 with its original key, and the ECDSA root used since 2026).
 * Trust is by public key, so chains ending at the original 2016 certificate also pass.
 */
export const GOOGLE_ATTESTATION_ROOTS = [
  `-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----`,
];

export const GOOGLE_REVOCATION_LIST_URL = 'https://android.googleapis.com/attestation/status';

export type AndroidAttestationPolicy = {
  /** Trusted root certificates (PEM). */
  roots: readonly string[];
  /** The app's package name, e.g. com.qrattendance.student. */
  packageName: string;
  /** SHA-256 digests (lower-case hex) of certificates allowed to have signed the app. Empty = any. */
  signingCertDigests: readonly string[];
  /** Serial numbers (lower-case hex, no leading zeros) of revoked attestation certificates. */
  revokedSerials: () => Promise<ReadonlySet<string>>;
};

export type VerifiedAndroidKey = {
  /** The phone's public key (SubjectPublicKeyInfo, DER). */
  publicKey: Buffer;
  attestation: DeviceAttestation;
};

/** The attestation did not prove a hardware key created by our app for this challenge. */
export class AttestationError extends Error {
  override name = 'AttestationError';
}

// Values from the Android KeyMint specification.
const KEY_PURPOSE_SIGN = 2;
const ALGORITHM_EC = 3;
const EC_CURVE_P256 = 1;
const ORIGIN_GENERATED = 0;

/** Parsed OCTET STRING fields arrive as ArrayBuffers, though typed as OctetString. */
const bytes = (value: OctetString | ArrayBuffer) => Buffer.from(value instanceof ArrayBuffer ? value : value.buffer);

export const normalizeSerial = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, '');

const spki = (cert: X509Certificate) => cert.publicKey.export({ type: 'spki', format: 'der' });

function parseChain(chain: readonly string[]): X509Certificate[] {
  try {
    return chain.map((b64) => new X509Certificate(Buffer.from(b64, 'base64')));
  } catch {
    throw new AttestationError('The certificate chain could not be read');
  }
}

function attestationExtension(cert: X509Certificate): Buffer | undefined {
  const parsed = AsnConvert.parse(cert.raw, Certificate);
  const ext = parsed.tbsCertificate.extensions?.find((e) => e.extnID === KEY_ATTESTATION_OID);
  return ext ? Buffer.from(ext.extnValue.buffer) : undefined;
}

/**
 * Authorization fields we read: purpose, algorithm, keySize, digest, ecCurve, origin,
 * rootOfTrust, osVersion, osPatchLevel, attestationApplicationId. Each Android release
 * may add fields, which the parsing library would reject as unknown, so everything
 * else is dropped before parsing.
 */
const AUTHORIZATION_TAGS_READ = new Set([1, 2, 3, 5, 10, 702, 704, 705, 706, 709]);
const CONTEXT_SPECIFIC = 3;

function withKnownAuthorizations(extension: Buffer): ArrayBuffer {
  const parsed = asn1js.fromBER(new Uint8Array(extension));
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new AttestationError('The key attestation could not be read');
  }
  // KeyDescription: ..., softwareEnforced [6], hardwareEnforced [7].
  for (const list of parsed.result.valueBlock.value.slice(6, 8)) {
    if (!(list instanceof asn1js.Sequence)) throw new AttestationError('The key attestation could not be read');
    list.valueBlock.value = list.valueBlock.value.filter(
      (field) => field.idBlock.tagClass === CONTEXT_SPECIFIC && AUTHORIZATION_TAGS_READ.has(field.idBlock.tagNumber),
    );
  }
  return parsed.result.toBER();
}

/** A field from the hardware-enforced list, falling back to the software-enforced one. */
function findProperty<K extends Parameters<NonStandardAuthorizationList['findProperty']>[0]>(
  description: NonStandardKeyDescription,
  key: K,
) {
  return description.teeEnforced.findProperty(key) ?? description.softwareEnforced.findProperty(key);
}

const BOOT_STATES: Record<number, DeviceAttestation['bootState']> = {
  [VerifiedBootState.verified]: 'verified',
  [VerifiedBootState.selfSigned]: 'self_signed',
  [VerifiedBootState.unverified]: 'unverified',
  [VerifiedBootState.failed]: 'failed',
};

/**
 * Checks an Android key attestation chain (base64 DER, leaf first) and returns the
 * attested public key. Throws AttestationError, with a reason for the server log, if
 * the chain does not prove all of:
 * - it ends at a trusted Google root and every link is correctly signed, unexpired and not revoked;
 * - the key was generated (not imported) in the phone's secure hardware, for signing with P-256;
 * - it was created for `challenge`, by our app (package name and signing certificate).
 */
export async function verifyAndroidAttestation(
  chain: readonly string[],
  challenge: Buffer,
  policy: AndroidAttestationPolicy,
  now: Date,
): Promise<VerifiedAndroidKey> {
  if (chain.length < 2) throw new AttestationError('The certificate chain is too short');
  const certs = parseChain(chain);

  // 1. Every certificate is signed by the next one, and the chain ends at a trusted root.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i]!.verify(certs[i + 1]!.publicKey)) throw new AttestationError(`Certificate ${i} is not signed by its issuer`);
  }
  const rootKeys = policy.roots.map((pem) => spki(new X509Certificate(pem)));
  const last = certs.at(-1)!;
  const anchoredAtLast = rootKeys.some((key) => key.equals(spki(last)));
  if (!anchoredAtLast && !policy.roots.some((pem) => last.verify(new X509Certificate(pem).publicKey))) {
    throw new AttestationError('The chain does not lead to a trusted Google root');
  }

  // 2. Intermediates are in date and nothing is revoked. (The first certificate is made by
  //    the phone itself with arbitrary dates, and the root is trusted by its key.)
  const intermediates = certs.slice(1, anchoredAtLast ? -1 : undefined);
  for (const cert of intermediates) {
    if (now < cert.validFromDate || now > cert.validToDate) throw new AttestationError('An attestation certificate has expired');
  }
  const revoked = await policy.revokedSerials();
  if (certs.some((cert) => revoked.has(normalizeSerial(cert.serialNumber)))) {
    throw new AttestationError('An attestation certificate has been revoked');
  }

  // 3. The key description is in the first certificate only.
  const extension = attestationExtension(certs[0]!);
  if (!extension) throw new AttestationError('The first certificate has no key attestation');
  if (certs.slice(1).some((cert) => attestationExtension(cert))) {
    throw new AttestationError('Key attestation found outside the first certificate');
  }
  let description: NonStandardKeyDescription;
  try {
    description = AsnConvert.parse(withKnownAuthorizations(extension), NonStandardKeyDescription);
  } catch {
    throw new AttestationError('The key attestation could not be read');
  }

  // 4. Created for this challenge, inside secure hardware.
  const attestedChallenge = Buffer.from(description.attestationChallenge.buffer);
  if (attestedChallenge.length !== challenge.length || !timingSafeEqual(attestedChallenge, challenge)) {
    throw new AttestationError('The key was not created for this challenge');
  }
  const level = description.attestationSecurityLevel;
  if (level !== SecurityLevel.trustedEnvironment && level !== SecurityLevel.strongBox) {
    throw new AttestationError('The key is not held in secure hardware');
  }
  if (description.keymasterSecurityLevel !== level) throw new AttestationError('Inconsistent security levels');

  // 5. A P-256 signing key, generated on the phone (not imported), enforced by the hardware.
  const hw = description.teeEnforced;
  if (!hw.findProperty('purpose')?.includes(KEY_PURPOSE_SIGN)) throw new AttestationError('The key is not a signing key');
  if (hw.findProperty('algorithm') !== ALGORITHM_EC) throw new AttestationError('The key is not an EC key');
  const curve = hw.findProperty('ecCurve');
  if (curve !== undefined && curve !== EC_CURVE_P256) throw new AttestationError('The key is not on curve P-256');
  if (hw.findProperty('origin') !== ORIGIN_GENERATED) throw new AttestationError('The key was imported, not generated');
  if (certs[0]!.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new AttestationError('The attested key is not a P-256 key');
  }

  // 6. Requested by our app, signed by our signing certificate.
  const appIdRaw = findProperty(description, 'attestationApplicationId');
  if (!appIdRaw) throw new AttestationError('The attestation does not name the app');
  let appId: AttestationApplicationId;
  try {
    appId = AsnConvert.parse(appIdRaw.buffer, AttestationApplicationId);
  } catch {
    throw new AttestationError('The app identity could not be read');
  }
  const packages = appId.packageInfos.map((p) => bytes(p.packageName).toString('utf8'));
  if (!packages.includes(policy.packageName)) throw new AttestationError(`Unexpected app: ${packages.join(', ')}`);
  const digests = appId.signatureDigests.map((d) => bytes(d).toString('hex'));
  if (policy.signingCertDigests.length > 0 && !digests.some((d) => policy.signingCertDigests.includes(d))) {
    throw new AttestationError('The app is not signed with our certificate');
  }

  const rootOfTrust = hw.findProperty('rootOfTrust');
  return {
    publicKey: spki(certs[0]!),
    attestation: {
      securityLevel: level === SecurityLevel.strongBox ? 'strongbox' : 'tee',
      bootState: rootOfTrust ? (BOOT_STATES[rootOfTrust.verifiedBootState] ?? 'unknown') : 'unknown',
      bootloaderLocked: rootOfTrust ? rootOfTrust.deviceLocked : null,
      osPatchLevel: findProperty(description, 'osPatchLevel') ?? null,
      attestationVersion: Number(description.attestationVersion),
    },
  };
}

/**
 * Google's list of revoked attestation certificates (leaked or faulty phone keys),
 * cached for an hour. If Google can't be reached the last known list is used — linking
 * a phone is rare and the list changes rarely, so a network blip shouldn't block it.
 */
export function googleRevocationList(
  log: { warn(msg: string): void },
  fetchImpl: typeof fetch = fetch,
  ttlMs = 60 * 60 * 1000,
): () => Promise<ReadonlySet<string>> {
  let cached: { at: number; serials: ReadonlySet<string> } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.serials;
    try {
      const res = await fetchImpl(GOOGLE_REVOCATION_LIST_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { entries?: Record<string, unknown> };
      cached = { at: Date.now(), serials: new Set(Object.keys(body.entries ?? {}).map(normalizeSerial)) };
    } catch (err) {
      log.warn(`Could not refresh Google's attestation revocation list: ${(err as Error).message}`);
      if (!cached) return new Set();
    }
    return cached!.serials;
  };
}
