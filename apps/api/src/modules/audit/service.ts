import { and, count, desc, eq, gte, inArray, like, lt, not, or, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  apiKeys,
  attendanceCorrections,
  attendanceSessions,
  auditLogs,
  devices,
  groups,
  institutes,
  offerings,
  structureLevels,
  subjects,
  terms,
  units,
  users,
  webhookEndpoints,
} from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';
import type { AuthContext } from '../../plugins/auth.js';
import { DEFAULT_TIMEZONE } from '../reports/query.js';
import { loadUnitIndex } from '../structure/service.js';

/** Groups of actions the activity page filters by. "changes" (the default view) is everything except sign-ins. */
export const AUDIT_CATEGORIES = {
  changes: { label: 'All changes' },
  attendance: { label: 'Attendance', prefixes: ['session.', 'attendance.', 'correction.'] },
  people: { label: 'Students & staff', prefixes: ['user.', 'student.', 'import.'] },
  phones: { label: 'Phones', prefixes: ['device.'] },
  academic: { label: 'Classes & subjects', prefixes: ['structure.', 'group.', 'term.', 'subject.', 'offering.'] },
  settings: { label: 'Settings', prefixes: ['settings.', 'institute.'] },
  integrations: { label: 'API keys & webhooks', prefixes: ['api_key.', 'webhook.'] },
  security: { label: 'Sign-ins & passwords', prefixes: ['auth.', 'user.password_reset'] },
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

const SIGN_INS = ['auth.login', 'auth.login_failed'];

export type AuditQuery = {
  category?: AuditCategory;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  /** Platform owner only: one institute (default: everything). */
  instituteId?: string;
  page: number;
  pageSize: number;
};

export type AuditEntryDto = {
  id: number;
  createdAt: string;
  action: string;
  /** What happened, in words. */
  summary: string;
  actor: { id: string; fullName: string; username: string; role: string } | null;
  institute: { id: string; name: string } | null;
  entity: { type: string; id: string; label: string | null } | null;
  ip: string | null;
  data: Record<string, unknown> | null;
};

function categoryCondition(category: AuditCategory | undefined): SQL | undefined {
  if (!category || category === 'changes') return not(inArray(auditLogs.action, SIGN_INS));
  const { prefixes } = AUDIT_CATEGORIES[category];
  return or(...prefixes.map((p) => (p.endsWith('.') ? like(auditLogs.action, `${p}%`) : eq(auditLogs.action, p))));
}

/** Admins see their institute's log; the platform owner sees every institute's (or one). */
export async function listAudit(db: Db, auth: AuthContext, query: AuditQuery): Promise<{ items: AuditEntryDto[]; total: number; page: number; pageSize: number }> {
  if (auth.role !== 'admin' && auth.role !== 'platform_admin') throw forbidden();
  const instituteId = auth.role === 'admin' ? auth.instituteId! : query.instituteId;
  const conditions: (SQL | undefined)[] = [instituteId ? eq(auditLogs.instituteId, instituteId) : undefined, categoryCondition(query.category)];
  if (query.actorId) conditions.push(eq(auditLogs.actorUserId, query.actorId));
  if (query.entityType) conditions.push(eq(auditLogs.entityType, query.entityType));
  if (query.entityId) conditions.push(eq(auditLogs.entityId, query.entityId));
  if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lt(auditLogs.createdAt, new Date(query.to)));
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        log: auditLogs,
        actor: { id: users.id, fullName: users.fullName, username: users.username, role: users.role },
        institute: { id: institutes.id, name: institutes.name, settings: institutes.settings },
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .leftJoin(institutes, eq(institutes.id, auditLogs.instituteId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);

  const names = await lookUpNames(
    db,
    rows.map((r) => r.log),
  );
  return {
    items: rows.map(({ log, actor, institute }) => {
      const timezone = institute?.settings.timezone ?? DEFAULT_TIMEZONE;
      const entity = log.entityType && log.entityId ? { type: log.entityType, id: log.entityId, label: names.label(log.entityType, log.entityId, timezone) } : null;
      return {
        id: log.id,
        createdAt: log.createdAt.toISOString(),
        action: log.action,
        summary: describe(log, entity?.label ?? null, names, timezone) + viaApiKey(log),
        actor: actor?.id ? actor : null,
        institute: institute?.id && auth.role === 'platform_admin' ? { id: institute.id, name: institute.name } : null,
        entity,
        ip: log.ip,
        data: log.data,
      };
    }),
    total: total?.n ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// Names for the ids in log entries
// ---------------------------------------------------------------------------

type Log = typeof auditLogs.$inferSelect;
type SessionName = { code: string; startedAt: Date };

/** Looks up every id a page of entries mentions, a query per kind of thing. */
async function lookUpNames(db: Db, logs: Log[]) {
  const ids = (type: string) => [...new Set(logs.filter((l) => l.entityType === type && l.entityId).map((l) => l.entityId!))];
  const dataIds = (key: string) => logs.map((l) => l.data?.[key]).filter((v): v is string => typeof v === 'string');
  const changeIds = logs.flatMap((l) =>
    Array.isArray(l.data?.changes) ? (l.data.changes as { studentId?: string }[]).slice(0, 3).map((c) => c.studentId) : [],
  );
  const uuid = (list: (string | undefined)[]) => [...new Set(list.filter((v): v is string => !!v && /^[0-9a-f-]{36}$/.test(v)))];

  const correctionRows = await whenAny(uuid(ids('correction')), (list) =>
    db
      .select({ id: attendanceCorrections.id, sessionId: attendanceCorrections.sessionId, studentId: attendanceCorrections.studentId })
      .from(attendanceCorrections)
      .where(inArray(attendanceCorrections.id, list)),
  );
  const deviceRows = await whenAny(uuid(ids('device')), (list) =>
    db.select({ id: devices.id, userId: devices.userId, model: devices.model }).from(devices).where(inArray(devices.id, list)),
  );
  const sessionIds = uuid([...ids('attendance_session'), ...dataIds('sessionId'), ...correctionRows.map((c) => c.sessionId)]);
  const userIds = uuid([
    ...ids('user'),
    ...dataIds('studentId'),
    ...changeIds,
    ...correctionRows.map((c) => c.studentId),
    ...deviceRows.map((d) => d.userId),
  ]);

  const [userRows, sessionRows, offeringRows, subjectRows, termRows, groupRows, levelRows, instituteRows, keyRows, hookRows] = await Promise.all([
    whenAny(userIds, (list) => db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, list))),
    whenAny(sessionIds, (list) =>
      db
        .select({ id: attendanceSessions.id, code: subjects.code, startedAt: attendanceSessions.startedAt })
        .from(attendanceSessions)
        .innerJoin(offerings, eq(offerings.id, attendanceSessions.offeringId))
        .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
        .where(inArray(attendanceSessions.id, list)),
    ),
    whenAny(uuid(ids('offering')), (list) =>
      db
        .select({ id: offerings.id, code: subjects.code, term: terms.name })
        .from(offerings)
        .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
        .innerJoin(terms, eq(terms.id, offerings.termId))
        .where(inArray(offerings.id, list)),
    ),
    whenAny(uuid(ids('subject')), (list) =>
      db.select({ id: subjects.id, code: subjects.code, name: subjects.name }).from(subjects).where(inArray(subjects.id, list)),
    ),
    whenAny(uuid(ids('term')), (list) => db.select({ id: terms.id, name: terms.name }).from(terms).where(inArray(terms.id, list))),
    whenAny(uuid(ids('group')), (list) => db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, list))),
    whenAny(uuid(ids('structure_level')), (list) =>
      db.select({ id: structureLevels.id, name: structureLevels.name }).from(structureLevels).where(inArray(structureLevels.id, list)),
    ),
    whenAny(uuid(ids('institute')), (list) => db.select({ id: institutes.id, name: institutes.name }).from(institutes).where(inArray(institutes.id, list))),
    whenAny(uuid(ids('api_key')), (list) => db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(inArray(apiKeys.id, list))),
    whenAny(uuid(ids('webhook')), (list) => db.select({ id: webhookEndpoints.id, url: webhookEndpoints.url }).from(webhookEndpoints).where(inArray(webhookEndpoints.id, list))),
  ]);

  const unitIds = uuid(ids('unit'));
  const unitPaths = new Map<string, string>();
  if (unitIds.length) {
    const unitRows = await db.select({ id: units.id, instituteId: units.instituteId }).from(units).where(inArray(units.id, unitIds));
    for (const instituteId of new Set(unitRows.map((u) => u.instituteId))) {
      const index = await loadUnitIndex(db, instituteId);
      for (const u of unitRows.filter((r) => r.instituteId === instituteId)) unitPaths.set(u.id, index.pathNames(u.id).join(' › '));
    }
  }

  const people = new Map(userRows.map((u) => [u.id, u.name]));
  const sessions = new Map<string, SessionName>(sessionRows.map((s) => [s.id, { code: s.code, startedAt: s.startedAt }]));
  const corrections = new Map(correctionRows.map((c) => [c.id, c]));
  const phones = new Map(deviceRows.map((d) => [d.id, d]));
  const simple = new Map<string, string>([
    ...offeringRows.map((o) => [o.id, `${o.code} (${o.term})`] as const),
    ...subjectRows.map((s) => [s.id, `${s.code} ${s.name}`] as const),
    ...termRows.map((t) => [t.id, t.name] as const),
    ...groupRows.map((g) => [g.id, g.name] as const),
    ...levelRows.map((l) => [l.id, l.name] as const),
    ...instituteRows.map((i) => [i.id, i.name] as const),
    ...keyRows.map((k) => [k.id, `the API key “${k.name}”`] as const),
    ...hookRows.map((h) => [h.id, `the webhook to ${h.url}`] as const),
    ...unitPaths,
  ]);

  const sessionLabel = (id: unknown, timezone: string) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!s) return null;
    const when = new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(s.startedAt);
    return `${s.code} on ${when}`;
  };
  const person = (id: unknown) => (typeof id === 'string' ? (people.get(id) ?? null) : null);

  return {
    person,
    session: sessionLabel,
    label(type: string, id: string, timezone: string): string | null {
      switch (type) {
        case 'user':
          return person(id);
        case 'attendance_session':
          return sessionLabel(id, timezone);
        case 'device': {
          const d = phones.get(id);
          return d ? `${person(d.userId) ?? 'a student'}’s ${d.model ?? 'phone'}` : null;
        }
        case 'correction': {
          const c = corrections.get(id);
          return c ? `${person(c.studentId) ?? 'a student'} · ${sessionLabel(c.sessionId, timezone) ?? 'a class'}` : null;
        }
        default:
          return simple.get(id) ?? null;
      }
    },
  };
}

async function whenAny<T>(ids: string[], run: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  return ids.length ? run(ids) : [];
}

type Names = Awaited<ReturnType<typeof lookUpNames>>;

// ---------------------------------------------------------------------------
// What each entry means, in words
// ---------------------------------------------------------------------------

const SETTING_WORDS: Record<string, (v: unknown) => string> = {
  qrRotationSeconds: (v) => `QR code changes every ${v} s`,
  qrGraceSeconds: (v) => `codes work ${v} s after changing`,
  defaultScanMinutes: (v) => `scanning stays open ${v} min`,
  requireRegisteredPhone: (v) => (v ? 'scans need the linked phone' : 'scans allowed without a linked phone'),
  minimumPercent: (v) => `minimum attendance ${v}%`,
  correctionWindowDays: (v) => (v ? `correction requests within ${v} days` : 'correction requests off'),
  lowAttendanceAlerts: (v) => `low-attendance reminders ${v ? 'on' : 'off'}`,
  weeklyStaffSummary: (v) => `weekly staff summary ${v ? 'on' : 'off'}`,
};

const FIELD_WORDS: Record<string, string> = {
  fullName: 'name',
  username: 'username',
  email: 'email',
  phone: 'phone',
  status: 'status',
  role: 'role',
  unitId: 'class',
  rollNo: 'roll no.',
  groupIds: 'groups',
  designation: 'designation',
  facultyIds: 'teachers',
  audience: 'students',
  name: 'name',
  code: 'code',
  startsOn: 'dates',
  endsOn: 'dates',
  kind: 'kind',
  parentId: 'parent',
  mustChangePassword: 'password change',
  url: 'address',
  events: 'events',
  description: 'description',
};

function changedFields(data: Record<string, unknown> | null): string {
  const changes = data?.changes;
  if (!changes || typeof changes !== 'object') return '';
  const words = [...new Set(Object.keys(changes).map((k) => FIELD_WORDS[k] ?? k))];
  return words.length ? ` (${words.join(', ')})` : '';
}

/** Changes made with an API key say so (the actor shown is the admin the key acts for). */
function viaApiKey(log: Log): string {
  const key = log.data?.viaApiKey as { name?: string } | undefined;
  return key?.name ? ` · through the API key “${key.name}”` : '';
}

const quoted = (v: unknown) => (typeof v === 'string' ? `“${v}”` : '');
const n = (v: unknown, one: string, many = `${one}s`) => `${typeof v === 'number' ? v : 0} ${v === 1 ? one : many}`;

export function describe(log: Log, entity: string | null, names: Names, timezone: string): string {
  const d = log.data ?? {};
  const it = entity ?? 'something since deleted';
  const changes = d.changes as Record<string, unknown> | undefined;
  switch (log.action) {
    case 'auth.login':
      return 'Signed in';
    case 'auth.login_failed':
      return 'Entered a wrong password';
    case 'auth.password_changed':
      return 'Changed their password';
    case 'auth.refresh_reuse_detected':
      return 'An old sign-in was reused (possibly stolen), so all of this account’s sign-ins were ended';
    case 'user.created':
      return `Created the ${d.role === 'hod' ? 'HOD' : String(d.role ?? 'user')} account ${entity ?? String(d.username ?? '')}`;
    case 'user.updated':
      if (changes?.status === 'disabled') return `Disabled ${it}’s account`;
      if (changes?.status === 'active') return `Re-enabled ${it}’s account`;
      return `Updated ${it}${changedFields(d)}`;
    case 'user.password_reset':
      return `Reset ${it}’s password`;
    case 'student.updated':
      return `Updated student ${it}${changedFields(d)}`;
    case 'import.students':
    case 'import.staff':
      return `Imported ${log.action === 'import.students' ? 'students' : 'staff'}: ${n(d.create, 'new account')}, ${n(d.update, 'update')}`;
    case 'structure.level_added':
      return `Added the level ${quoted(d.name)}`;
    case 'structure.level_renamed':
      return `Renamed a level to ${quoted(d.name)}`;
    case 'structure.level_deleted':
      return `Deleted the level ${quoted(d.name)}`;
    case 'structure.unit_created':
      return `Created ${d.level ? `${String(d.level)} ` : ''}${entity ?? quoted(d.name)}`;
    case 'structure.unit_updated':
      return `Updated ${it}${changedFields(d)}`;
    case 'structure.unit_deleted':
      return `Deleted ${quoted(d.name)}`;
    case 'group.created':
      return `Created the group ${entity ?? quoted(d.name)}`;
    case 'group.updated':
      return `Updated the group ${it}${changedFields(d)}`;
    case 'group.deleted':
      return `Deleted the group ${quoted(d.name)}`;
    case 'group.members_changed':
      return `Changed who is in ${it}: ${n(d.added, 'added', 'added')}, ${n(d.removed, 'removed', 'removed')}`;
    case 'term.created':
      return `Created the term ${entity ?? quoted(d.name)}`;
    case 'term.updated':
      return `Updated the term ${it}${changedFields(d)}`;
    case 'term.deleted':
      return `Deleted the term ${quoted(d.name)}`;
    case 'subject.created':
      return `Created the subject ${entity ?? `${String(d.code)} ${String(d.name)}`}`;
    case 'subject.updated':
      return `Updated the subject ${it}${changedFields(d)}`;
    case 'subject.deleted':
      return `Deleted the subject ${String(d.code ?? '')}`;
    case 'offering.created':
      return `Set up ${it}`;
    case 'offering.updated':
      return `Updated ${it}${changedFields(d)}`;
    case 'offering.deleted':
      return 'Removed a class offering';
    case 'institute.created':
      return `Created the institute ${String(d.name ?? it)}`;
    case 'institute.updated':
      if (changes?.status === 'suspended') return `Suspended ${it}`;
      if (changes?.status === 'active') return `Re-activated ${it}`;
      return `Updated ${it}${changedFields(d)}`;
    case 'settings.attendance_updated': {
      const list = Object.entries(changes ?? {}).map(([k, v]) => SETTING_WORDS[k]?.(v) ?? `${k}: ${String(v)}`);
      return `Changed attendance settings: ${list.join(', ')}`;
    }
    case 'session.started':
      return `Started ${it} for ${n(d.students, 'student')}`;
    case 'session.closed':
      return `Closed ${it}`;
    case 'session.extended':
      return `Kept ${it} open ${String(d.minutes ?? '')} more minutes`;
    case 'session.cancelled':
      return `Cancelled ${it}: ${String(d.reason ?? '')}`;
    case 'attendance.marked_manually': {
      const list = Array.isArray(d.changes) ? (d.changes as { studentId: string }[]) : [];
      const who =
        list.length > 0 && list.length <= 3
          ? list
              .map((c) => names.person(c.studentId) ?? 'a student')
              .sort((a, b) => a.localeCompare(b))
              .join(', ')
          : n(list.length, 'student');
      return `Marked ${who} ${String(d.status)} by hand in ${it}: ${String(d.reason ?? '')}`;
    }
    case 'device.linked':
      return d.reinstalledOnSamePhone ? `Re-linked ${it} after reinstalling the app` : `Linked ${it}`;
    case 'device.change_requested':
      return `Asked to switch to ${it}`;
    case 'device.change_approved':
      return `Approved the switch to ${it}`;
    case 'device.change_rejected':
      return `Turned down ${it}: ${String(d.reason ?? '')}`;
    case 'device.unlinked':
      return `Unlinked ${it}: ${String(d.reason ?? '')}`;
    case 'correction.requested':
      return `Asked for ${names.session(d.sessionId, timezone) ?? 'a class'} to be changed from ${String(d.from)} to ${String(d.to)}: ${String(d.reason ?? '')}`;
    case 'correction.approved':
      return `Approved ${names.person(d.studentId) ?? 'a student'}’s correction for ${names.session(d.sessionId, timezone) ?? 'a class'}: ${String(d.from)} → ${String(d.to)}${d.note ? ` (${String(d.note)})` : ''}`;
    case 'correction.rejected':
      return `Turned down ${names.person(d.studentId) ?? 'a student'}’s correction for ${names.session(d.sessionId, timezone) ?? 'a class'}: ${String(d.note ?? '')}`;
    case 'api_key.created':
      return `Created the API key “${String(d.name)}” (${Array.isArray(d.scopes) ? (d.scopes as string[]).join(', ') : ''})`;
    case 'api_key.revoked':
      return `Revoked the API key “${String(d.name)}”`;
    case 'webhook.created':
      return `Added a webhook to ${String(d.url)} (${Array.isArray(d.events) ? (d.events as string[]).join(', ') : ''})`;
    case 'webhook.updated': {
      const hook = d.url ? `the webhook to ${String(d.url)}` : it;
      if (changes?.enabled === false) return `Switched off ${hook}`;
      if (changes?.enabled === true) return `Switched on ${hook}`;
      return `Changed ${hook}${changedFields(d)}`;
    }
    case 'webhook.deleted':
      return `Deleted the webhook to ${String(d.url)}`;
    case 'webhook.secret_rotated':
      return `Replaced the signing secret of ${d.url ? `the webhook to ${String(d.url)}` : it}`;
    case 'webhook.disabled':
      return `Switched off the webhook to ${String(d.url)} after a day of failed deliveries`;
    case 'correction.withdrawn':
      return `Withdrew their correction request for ${names.session(d.sessionId, timezone) ?? 'a class'}`;
    default:
      return entity ? `${log.action} · ${entity}` : log.action;
  }
}
