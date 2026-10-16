import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// Argon2id (the library default) with OWASP-recommended parameters: 19 MiB memory, 2 passes.
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Lighter Argon2id for passwords *we* generate. They are random (10 chars from a
 * 55-symbol alphabet ≈ 58 bits), so slow hashing adds nothing against guessing, and
 * users must replace them at first login. This keeps a 10,000-student import fast.
 * verifyPassword works unchanged because the parameters are stored in the hash.
 */
export function hashTemporaryPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 4096, timeCost: 1, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU time as a real check when the user does not exist, so response
 * timing does not reveal which usernames are valid.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}

// No 0/O/1/l/I so temporary passwords can be read out or typed without confusion.
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateTemporaryPassword(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}
