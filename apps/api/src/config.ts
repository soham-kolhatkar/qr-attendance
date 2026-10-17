import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** apps/web/dist, resolved from both src/ (tsx) and dist/ (compiled) builds of the API. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  /**
   * Connection used for live updates (Postgres LISTEN). LISTEN needs a direct session,
   * so if DATABASE_URL goes through a transaction pooler (e.g. Neon's "-pooler" host),
   * set this to the direct address. Defaults to DATABASE_URL.
   */
  DATABASE_LISTEN_URL: z.url().optional(),
  /** Max Postgres connections per API instance. Raise for heavy scan bursts if the database allows it. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Set to true when running behind a load balancer / reverse proxy so client IPs are correct. */
  TRUST_PROXY: z.stringbool().default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Also serve the built web app (apps/web/dist) from this server, so browser, phone
   * app and API share one address — no CORS and one service to host.
   */
  SERVE_WEB: z.stringbool().default(false),
  WEB_DIST_DIR: z.string().default(DEFAULT_WEB_DIST),
  /** The student app's Android package name. Phones must prove they run this app to be linked. */
  ANDROID_PACKAGE_NAME: z.string().default('com.qrattendance.student'),
  /**
   * SHA-256 fingerprints of the certificates the Android app is signed with (hex, colons
   * optional, comma-separated). A copy of the app re-signed by anyone else is refused.
   * Empty accepts any signer — for development only.
   */
  ANDROID_SIGNING_CERT_SHA256: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().replaceAll(':', '').toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[0-9a-f]{64}$/, 'Each fingerprint must be 64 hex characters'))),
  /** Check Google's list of revoked attestation keys when a phone is linked. */
  ATTESTATION_REVOCATION_CHECK: z.stringbool().default(true),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
