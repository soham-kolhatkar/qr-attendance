import { randomUUID } from 'node:crypto';
import { and, arrayContains, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client.js';
import {
  ATTENDANCE_STATUSES,
  attendanceRecords,
  type attendanceSessions,
  institutes,
  offerings,
  SESSION_KINDS,
  students,
  subjects,
  users,
  type WebhookEvent,
  webhookDeliveries,
  webhookEndpoints,
} from '../../db/schema.js';

/**
 * What webhook receivers get. The schemas double as the documentation of each event
 * (see the integration API docs), so payloads and docs can't drift apart.
 */

const status = z.enum(ATTENDANCE_STATUSES);

export const sessionRefSchema = z.object({
  id: z.uuid(),
  offeringId: z.uuid(),
  subject: z.object({ code: z.string(), name: z.string() }),
  kind: z.enum(SESSION_KINDS),
  topic: z.string().nullable(),
  startedAt: z.iso.datetime(),
  closesAt: z.iso.datetime().describe('When QR scanning stops (or stopped)'),
  status: z.enum(['open', 'closed', 'cancelled']),
});

export const studentRefSchema = z.object({
  id: z.uuid(),
  username: z.string().describe('Usually the enrollment number'),
  fullName: z.string(),
  rollNo: z.string().nullable(),
});

export const EVENT_DATA = {
  'attendance.recorded': z
    .object({
      session: sessionRefSchema,
      student: studentRefSchema,
      status,
      previousStatus: status,
      method: z.enum(['qr', 'manual']),
      via: z.enum(['scan', 'teacher', 'correction']).describe('scan: the student scanned; teacher: marked by hand; correction: a correction request was approved'),
      markedAt: z.iso.datetime(),
      reason: z.string().nullable().describe('Given for marks by hand'),
    })
    .describe("A student's mark changed: they scanned, or a teacher (or an approved correction request) changed it."),
  'session.started': z
    .object({ session: sessionRefSchema, students: z.number().int().describe('Students on the list, all absent until they scan') })
    .describe('A teacher started taking attendance.'),
  'session.closed': z
    .object({
      session: sessionRefSchema,
      counts: z.object({ present: z.number().int(), absent: z.number().int(), excused: z.number().int(), total: z.number().int() }),
      records: z.array(z.object({ student: studentRefSchema, status, method: z.enum(['qr', 'manual']).nullable() })),
    })
    .describe(
      'Scanning stopped (closed by the teacher or by time), with every student’s mark. Sent again if the session is re-opened and closes again; marks changed later arrive as attendance.recorded.',
    ),
  'session.cancelled': z
    .object({ session: sessionRefSchema, reason: z.string() })
    .describe('The session was cancelled; it no longer counts towards attendance.'),
} satisfies Record<WebhookEvent, z.ZodType>;

export type EventData<T extends WebhookEvent> = z.infer<(typeof EVENT_DATA)[T]>;
export type SessionRef = z.infer<typeof sessionRefSchema>;
export type StudentRef = z.infer<typeof studentRefSchema>;

/** The envelope every delivery has, with `data` depending on `type`. */
export const envelopeSchema = (type: string, data: z.ZodType) =>
  z.object({
    id: z.uuid().describe('The event. Deliveries of one event to several endpoints, and retries, share it: use it to ignore repeats.'),
    type: z.literal(type),
    createdAt: z.iso.datetime(),
    institute: z.object({ code: z.string() }),
    data,
  });

type SessionRow = typeof attendanceSessions.$inferSelect;

export function sessionRef(
  s: Pick<SessionRow, 'id' | 'offeringId' | 'kind' | 'topic' | 'startedAt' | 'closesAt'>,
  subject: { code: string; name: string },
  status: SessionRef['status'],
): SessionRef {
  return {
    id: s.id,
    offeringId: s.offeringId,
    subject,
    kind: s.kind,
    topic: s.topic,
    startedAt: s.startedAt.toISOString(),
    closesAt: s.closesAt.toISOString(),
    status,
  };
}

/** Subject code and name for each offering. */
export async function subjectsOf(db: DbOrTx, offeringIds: string[]) {
  if (offeringIds.length === 0) return new Map<string, { code: string; name: string }>();
  const rows = await db
    .select({ offeringId: offerings.id, code: subjects.code, name: subjects.name })
    .from(offerings)
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .where(inArray(offerings.id, [...new Set(offeringIds)]));
  return new Map(rows.map((r) => [r.offeringId, { code: r.code, name: r.name }]));
}

export async function studentRefs(db: DbOrTx, ids: string[]): Promise<Map<string, StudentRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, username: users.username, fullName: users.fullName, rollNo: students.rollNo })
    .from(users)
    .innerJoin(students, eq(students.userId, users.id))
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The session.closed event's data: the session with every student's mark. */
export async function closedSessionData(db: DbOrTx, s: SessionRow): Promise<EventData<'session.closed'>> {
  const subject = (await subjectsOf(db, [s.offeringId])).get(s.offeringId)!;
  const rows = await db
    .select({
      student: { id: users.id, username: users.username, fullName: users.fullName, rollNo: students.rollNo },
      status: attendanceRecords.status,
      method: attendanceRecords.method,
    })
    .from(attendanceRecords)
    .innerJoin(users, eq(users.id, attendanceRecords.studentId))
    .innerJoin(students, eq(students.userId, attendanceRecords.studentId))
    .where(eq(attendanceRecords.sessionId, s.id));
  const counts = { present: 0, absent: 0, excused: 0, total: rows.length };
  for (const r of rows) counts[r.status] += 1;
  return { session: sessionRef(s, subject, 'closed'), counts, records: rows };
}

/**
 * Which events an institute's enabled webhooks want, remembered for a few seconds: every
 * scan asks, and almost always the answer is "none". Changes made on this server apply
 * at once (see forgetListeners); other servers notice within LISTENER_TTL_MS.
 */
const LISTENER_TTL_MS = 10_000;
const listeners = new Map<string, { at: number; types: Set<string> }>();

export async function listeningTo(db: DbOrTx, instituteId: string): Promise<Set<string>> {
  const cached = listeners.get(instituteId);
  if (cached && Date.now() - cached.at < LISTENER_TTL_MS) return cached.types;
  const rows = await db
    .select({ events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.instituteId, instituteId), eq(webhookEndpoints.enabled, true)));
  const types = new Set(rows.flatMap((r) => r.events));
  listeners.set(instituteId, { at: Date.now(), types });
  return types;
}

export const forgetListeners = (instituteId: string) => listeners.delete(instituteId);

/**
 * Queues events for every enabled endpoint of the institute that subscribed to `type`,
 * in the caller's transaction (so an event exists exactly when its change does). The
 * data is only built when someone is listening.
 */
export async function emitEvents<T extends WebhookEvent>(
  db: DbOrTx,
  instituteId: string,
  type: T,
  build: () => EventData<T>[] | Promise<EventData<T>[]>,
  now: Date,
): Promise<void> {
  if (!(await listeningTo(db, instituteId)).has(type)) return;
  const endpoints = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.instituteId, instituteId), eq(webhookEndpoints.enabled, true), arrayContains(webhookEndpoints.events, [type])));
  if (endpoints.length === 0) return;
  const list = await build();
  if (list.length === 0) return;
  const [institute] = await db.select({ code: institutes.code }).from(institutes).where(eq(institutes.id, instituteId));
  const rows = list.flatMap((data) => {
    const eventId = randomUUID();
    const payload = { id: eventId, type, createdAt: now.toISOString(), institute: { code: institute!.code }, data };
    return endpoints.map((e) => ({ endpointId: e.id, instituteId, eventId, eventType: type, payload, nextAttemptAt: now }));
  });
  for (let i = 0; i < rows.length; i += 1000) await db.insert(webhookDeliveries).values(rows.slice(i, i + 1000));
}
