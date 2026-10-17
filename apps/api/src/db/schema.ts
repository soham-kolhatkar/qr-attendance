import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
  attendance?: {
    /** How often the QR code changes. */
    qrRotationSeconds?: number;
    /** How long a code is still accepted after the screen moved on to the next one (covers slow networks). */
    qrGraceSeconds?: number;
    /** How long QR scanning stays open after a session starts. */
    defaultScanMinutes?: number;
    /** Scans must come from the student's linked phone (signed by its hardware key). */
    requireRegisteredPhone?: boolean;
  };
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

// ---------------------------------------------------------------------------
// Academic structure (Feature 2)
//
// Nothing about "year", "division" or "batch" is hardcoded. Each institute defines:
//   structure_levels – ordered level names, e.g. Department › Program › Year › Division
//   units            – a tree following those levels; students belong to one unit
//   groups           – flexible student sets: lab batches, electives, tutorials…
// ---------------------------------------------------------------------------

/** Makes NULL compare equal inside unique indexes (e.g. two root units with one name). */
const NIL_UUID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

export const structureLevels = pgTable(
  'structure_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    /** 0 = top level. */
    depth: integer('depth').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('structure_levels_depth_uq').on(t.instituteId, t.depth),
    uniqueIndex('structure_levels_name_uq').on(t.instituteId, sql`lower(${t.name})`),
  ],
);

export const units = pgTable(
  'units',
  {
    id: uuid('id').primaryKey(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    levelId: uuid('level_id')
      .notNull()
      .references(() => structureLevels.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => units.id, { onDelete: 'restrict' }),
    /**
     * Ids from the root down to this unit (inclusive). "Everything under unit X" is
     * `path @> ARRAY[X]`, served by a GIN index — used for HOD scope and audiences.
     */
    path: uuid('path').array().notNull(),
    name: text('name').notNull(),
    /** Optional short code, e.g. "SY-A". */
    code: text('code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('units_sibling_name_uq').on(
      t.instituteId,
      sql`coalesce(${t.parentId}, ${NIL_UUID})`,
      sql`lower(${t.name})`,
    ),
    index('units_path_gin').using('gin', t.path),
    index('units_parent_idx').on(t.parentId),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    /**
     * Where the group lives, e.g. batch "A1" under "Div A", or an elective under "SY".
     * Members must belong to this unit or a unit below it. NULL = institute-wide.
     */
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Free label chosen by the institute: "batch", "elective", "tutorial"… */
    kind: text('kind').notNull().default('batch'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('groups_name_uq').on(t.instituteId, sql`coalesce(${t.unitId}, ${NIL_UUID})`, sql`lower(${t.name})`),
    index('groups_unit_idx').on(t.unitId),
  ],
);

/** Student-specific data; one row per user with role "student". */
export const students = pgTable(
  'students',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    rollNo: text('roll_no'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('students_unit_idx').on(t.unitId), index('students_institute_idx').on(t.instituteId)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.studentId] }), index('group_members_student_idx').on(t.studentId)],
);

/** Staff-specific data (admin, HOD, faculty). For a HOD, unit_id is the subtree they manage. */
export const staffProfiles = pgTable('staff_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  instituteId: uuid('institute_id')
    .notNull()
    .references(() => institutes.id, { onDelete: 'restrict' }),
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
  designation: text('designation'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** An academic term / semester, e.g. "2026-27 Odd Semester". */
export const terms = pgTable(
  'terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('terms_name_uq').on(t.instituteId, sql`lower(${t.name})`),
    check('terms_dates_ordered', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    /** Course code, e.g. "CS301". */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Owning unit (usually a department), used for HOD scope. */
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('subjects_code_uq').on(t.instituteId, sql`lower(${t.code})`)],
);

/**
 * "Subject X is taught to audience Y by faculty Z in term T". Attendance sessions
 * (Feature 3) belong to an offering, and attendance % is reported per offering.
 */
export const offerings = pgTable(
  'offerings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('offerings_term_idx').on(t.instituteId, t.termId)],
);

export const offeringFaculty = pgTable(
  'offering_faculty',
  {
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.offeringId, t.userId] }), index('offering_faculty_user_idx').on(t.userId)],
);

/** Who an offering is taught to: any mix of units (whole classes) and groups (batches, electives). */
export const offeringAudience = pgTable(
  'offering_audience',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check('offering_audience_one_target', sql`(${t.unitId} IS NULL) <> (${t.groupId} IS NULL)`),
    unique('offering_audience_unit_uq').on(t.offeringId, t.unitId),
    unique('offering_audience_group_uq').on(t.offeringId, t.groupId),
  ],
);

// ---------------------------------------------------------------------------
// Attendance (Feature 3)
// ---------------------------------------------------------------------------

export const SESSION_KINDS = ['lecture', 'lab', 'tutorial', 'other'] as const;
export const sessionStatusEnum = pgEnum('session_status', ['open', 'closed', 'cancelled']);
export const ATTENDANCE_STATUSES = ['present', 'absent', 'excused'] as const;
export const attendanceStatusEnum = pgEnum('attendance_status', ATTENDANCE_STATUSES);
export const markMethodEnum = pgEnum('mark_method', ['qr', 'manual']);

/**
 * One lecture / lab occurrence of an offering. While "open", the faculty screen shows
 * a rotating QR code that students scan; it closes by itself at closes_at.
 */
export const attendanceSessions = pgTable(
  'attendance_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: SESSION_KINDS }).notNull().default('lecture'),
    topic: text('topic'),
    /** Optional narrowing of the offering audience, e.g. one lab batch: { unitIds, groupIds }. */
    audience: jsonb('audience').$type<{ unitIds: string[]; groupIds: string[] }>(),
    status: sessionStatusEnum('status').notNull().default('open'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    /** When QR scanning stops automatically. */
    closesAt: timestamptz('closes_at').notNull(),
    closedAt: timestamptz('closed_at'),
    cancelReason: text('cancel_reason'),
    /** HMAC key for this session's rotating QR codes (base64url, 32 bytes). Never sent to students. */
    qrSecret: text('qr_secret').notNull(),
    /** Snapshot of the institute settings when the session started. */
    qrRotationSeconds: integer('qr_rotation_seconds').notNull(),
    qrGraceSeconds: integer('qr_grace_seconds').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('attendance_sessions_institute_started_idx').on(t.instituteId, t.startedAt.desc()),
    index('attendance_sessions_offering_started_idx').on(t.offeringId, t.startedAt.desc()),
    index('attendance_sessions_open_closes_idx').on(t.closesAt).where(sql`${t.status} = 'open'`),
    // A teacher runs one live session at a time (also stops double-clicked "Start").
    uniqueIndex('attendance_sessions_one_open_per_creator').on(t.createdBy).where(sql`${t.status} = 'open'`),
  ],
);

/**
 * One row per expected student per session, created when the session starts (a
 * snapshot of the roster), so later class changes never rewrite history.
 */
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.userId, { onDelete: 'restrict' }),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    status: attendanceStatusEnum('status').notNull().default('absent'),
    method: markMethodEnum('method'),
    markedAt: timestamptz('marked_at'),
    /** The student (QR scan) or the teacher/admin (manual). */
    markedBy: uuid('marked_by').references(() => users.id, { onDelete: 'set null' }),
    /** Required for manual changes. */
    reason: text('reason'),
    /** Which QR step was scanned, for audits. */
    qrStep: bigint('qr_step', { mode: 'number' }),
    /** The linked phone that signed the scan. */
    deviceId: uuid('device_id').references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
    ip: text('ip'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.studentId] }),
    index('attendance_records_student_idx').on(t.studentId),
    index('attendance_records_institute_student_idx').on(t.instituteId, t.studentId),
  ],
);

// ---------------------------------------------------------------------------
// Linked phones (Feature 5)
//
// One phone per student, one student per phone. A phone is identified by a signing key
// created inside its secure hardware, which never leaves the phone. The server checks
// the hardware's attestation once, then every scan is signed with that key.
// ---------------------------------------------------------------------------

export const DEVICE_STATUSES = ['pending', 'active', 'revoked', 'rejected'] as const;
export const devicePlatformEnum = pgEnum('device_platform', ['android', 'ios']);
export const deviceStatusEnum = pgEnum('device_status', DEVICE_STATUSES);

/** What the phone's hardware vouched for when it was linked. */
export type DeviceAttestation = {
  /** Where the key lives: the phone's trusted environment or a separate security chip. */
  securityLevel: 'tee' | 'strongbox';
  /** "verified" = the phone runs its maker's software; anything else suggests a modified (rooted) phone. */
  bootState: 'verified' | 'self_signed' | 'unverified' | 'failed' | 'unknown';
  bootloaderLocked: boolean | null;
  /** e.g. 202609 for the September 2026 security patch. */
  osPatchLevel: number | null;
  attestationVersion: number;
};

/**
 * pending  – a student asked to switch to this phone; an admin or HOD must approve.
 * active   – the student's phone; scans must be signed by its key.
 * revoked  – was active, then replaced or unlinked.
 * rejected – a request that was turned down or superseded.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instituteId: uuid('institute_id')
      .notNull()
      .references(() => institutes.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: devicePlatformEnum('platform').notNull(),
    status: deviceStatusEnum('status').notNull(),
    /** The phone's public key (SubjectPublicKeyInfo, DER, base64). */
    publicKey: text('public_key').notNull(),
    /** SHA-256 of the public key; a key can only ever be linked once. */
    keyHash: text('key_hash').notNull().unique(),
    /** SHA-256 of the institute and the app's per-phone id (ANDROID_ID), to spot one phone used by two students. */
    phoneHash: text('phone_hash').notNull(),
    attestation: jsonb('attestation').$type<DeviceAttestation>().notNull(),
    /** As reported by the app, for people to recognise the phone. */
    model: text('model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    activatedAt: timestamptz('activated_at'),
    /** Who approved the phone; NULL when it was linked automatically. */
    activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'set null' }),
    endedAt: timestamptz('ended_at'),
    endedBy: uuid('ended_by').references(() => users.id, { onDelete: 'set null' }),
    endReason: text('end_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('devices_one_active_per_user').on(t.userId).where(sql`${t.status} = 'active'`),
    uniqueIndex('devices_one_pending_per_user').on(t.userId).where(sql`${t.status} = 'pending'`),
    uniqueIndex('devices_one_user_per_phone').on(t.instituteId, t.phoneHash).where(sql`${t.status} = 'active'`),
    index('devices_institute_status_idx').on(t.instituteId, t.status, t.createdAt.desc()),
    index('devices_user_idx').on(t.userId),
  ],
);
