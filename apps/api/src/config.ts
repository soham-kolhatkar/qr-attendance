import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** apps/web/dist, resolved from both src/ (tsx) and dist/ (compiled) builds of the API. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Unset and empty both mean "not configured" (hosting dashboards often keep empty variables). */
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

const serviceAccountSchema = z.object({ project_id: z.string(), client_email: z.string(), private_key: z.string() });
export type FirebaseServiceAccount = { projectId: string; clientEmail: string; privateKey: string };

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
  /** The web app's address, for links in emails. On Render it defaults to the service's own address. */
  PUBLIC_URL: optional.pipe(z.url().optional()),
  /** How emails are sent: not at all, written to the server log (development), or through Brevo. */
  EMAIL_PROVIDER: z.enum(['none', 'log', 'brevo']).default('none'),
  BREVO_API_KEY: optional,
  /** Sender, e.g. "QR Attendance <alerts@example.com>". With Brevo it must be a sender verified in the Brevo account. */
  EMAIL_FROM: optional.pipe(
    z
      .string()
      .regex(/^(?:[^<>]+<[^<>\s]+@[^<>\s]+>|[^<>\s]+@[^<>\s]+)$/, 'Use "Name <address@example.com>" or just the address')
      .optional(),
  ),
  /** Emails sent per day at most, to stay within the email service's plan (Brevo's free plan: 300). */
  EMAIL_DAILY_LIMIT: z.coerce.number().int().min(0).default(300),
  /**
   * Firebase service account for push notifications to the Android app: the JSON key file's
   * contents, or the same base64-encoded. Unset turns push notifications off.
   */
  FCM_SERVICE_ACCOUNT: optional.transform((v, ctx): FirebaseServiceAccount | undefined => {
    if (!v) return undefined;
    try {
      const json = v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8');
      const parsed = serviceAccountSchema.safeParse(JSON.parse(json));
      if (parsed.success) {
        const { project_id, client_email, private_key } = parsed.data;
        return { projectId: project_id, clientEmail: client_email, privateKey: private_key };
      }
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: "Must be the Firebase service account's JSON key (or that JSON base64-encoded)" });
    return z.NEVER;
  }),
  /** Requests a minute each API key may make (per server). */
  API_KEY_RATE_LIMIT: z.coerce.number().int().min(1).default(600),
  /**
   * Let webhooks call private addresses (localhost, 10.x, 192.168.x…). Off in production so
   * that a webhook can't be pointed at the hosting provider's internal services.
   */
  WEBHOOK_ALLOW_PRIVATE_URLS: z.stringbool().default(false),
}).superRefine((c, ctx) => {
  if (c.EMAIL_PROVIDER === 'brevo' && !c.BREVO_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['BREVO_API_KEY'], message: 'Required when EMAIL_PROVIDER is brevo' });
  }
  if (c.EMAIL_PROVIDER !== 'none' && !c.EMAIL_FROM) {
    ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'Required when emails are sent' });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse({ ...env, PUBLIC_URL: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
