import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * platform_admin – the vendor (us); not tied to any institute.
 * admin          – institute administrator.
 * hod            – head of department; scope (a unit subtree) is added with the academic structure feature.
 * faculty, student.
 */
export const ROLES = ['platform_admin', 'admin', 'hod', 'faculty', 'student'] as const;
export type Role = (typeof ROLES)[number];
export const INSTITUTE_ROLES = ['admin', 'hod', 'faculty', 'student'] as const satisfies readonly Role[];

export const roleEnum = pgEnum('role', ROLES);
export const instituteStatusEnum = pgEnum('institute_status', ['active', 'suspended']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);

/** Per-institute tunables. Every field is optional; defaults live in code. */
export type InstituteSettings = {
  timezone?: string;
};

/** A tenant. Every institute-owned row carries institute_id. */
export const institutes = pgTable('institutes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Short code students type at login, e.g. "VJTI". Stored upper-case. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  status: instituteStatusEnum('status').notNull().default('active'),
  settings: jsonb('settings').$type<InstituteSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL only for platform admins. */
    instituteId: uuid('institute_id').references(() => institutes.id, { onDelete: 'restrict' }),
    role: roleEnum('role').notNull(),
    /** Login id: enrollment no. / employee id / email. Stored lower-case. */
    username: text('username').notNull(),
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('users_institute_username_uq').on(t.instituteId, t.username).nullsNotDistinct(),
    index('users_institute_role_idx').on(t.instituteId, t.role),
    check('users_platform_admin_has_no_institute', sql`(${t.role} = 'platform_admin') = (${t.instituteId} IS NULL)`),
  ],
);

/**
 * Opaque refresh tokens (only the SHA-256 hash is stored). Tokens rotate on every
 * refresh; all tokens from one login share a family_id so that reuse of an old token
 * (a sign of theft) can revoke the whole family.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    replacedById: uuid('replaced_by_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.familyId)],
);

/** Append-only record of security-relevant and data-changing actions. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    instituteId: uuid('institute_id').references(() => institutes.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_institute_created_idx').on(t.instituteId, t.createdAt.desc())],
);
