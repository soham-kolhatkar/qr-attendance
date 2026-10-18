/**
 * Load test: the start of a period, when every class starts at once and students scan
 * within a minute or two. Never point it at a real deployment: it creates a LOAD
 * institute with thousands of made-up students.
 *
 *   # 1. a separate database, e.g. createdb in the local Docker Postgres
 *   export DATABASE_URL=postgres://qra:qra@localhost:55432/qr_attendance_load JWT_SECRET=<32+ chars>
 *   npx tsx scripts/load-test.ts setup                      # migrations + institute (once)
 *   # 2. start the server against that database (any way: npm run dev, Docker with a CPU limit…)
 *   # 3. run a period: 30 classes, 66 students each scanning within 90 seconds
 *   npx tsx scripts/load-test.ts run --base http://localhost:3000 --classes 30 --per-class 66 --window 90
 *
 * What a period does, per class: the teacher starts a session and the projector opens
 * the live stream; students scan (mostly early in the window) with their phone's
 * signature and their app then reloads their attendance; three admins refresh the
 * dashboard every 10 seconds; finally the teachers close the sessions and the database
 * is checked against the scans that were answered "present".
 */
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  attendanceRecords,
  attendanceSessions,
  devices,
  institutes,
  offeringAudience,
  offeringFaculty,
  offerings,
  structureLevels,
  students,
  subjects,
  terms,
  units,
  users,
} from '../src/db/schema.js';
import { qrPayload, stepAt } from '../src/modules/attendance/qr.js';
import { scanSigningMessage } from '../src/modules/devices/service.js';
import { signAccessToken } from '../src/lib/tokens.js';

const CODE = 'LOAD';
const CLASSES = 30;
const STUDENTS_PER_CLASS = 334; // ~10,000 in all

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    classes: { type: 'string', default: String(CLASSES) },
    'per-class': { type: 'string', default: '66' },
    window: { type: 'string', default: '90' },
    out: { type: 'string' },
  },
});

const url = process.env.DATABASE_URL;
const secret = process.env.JWT_SECRET;
if (!url || !secret) throw new Error('Set DATABASE_URL (a throw-away database) and JWT_SECRET (the same as the server)');
if (!/load/i.test(new URL(url).pathname)) throw new Error('For safety the database name must contain "load"');

const { db, pool } = createDb(url);

// ---------------------------------------------------------------------------
// Setup: one institute, 30 classes of ~334 students, a teacher and a subject each
// ---------------------------------------------------------------------------

async function setup(db: Db) {
  await runMigrations(url!);
  const [existing] = await db.select().from(institutes).where(eq(institutes.code, CODE));
  if (existing) return console.log('LOAD institute already set up.');
  const t0 = Date.now();
  await db.transaction(async (tx) => {
    const [inst] = await tx.insert(institutes).values({ code: CODE, name: 'Load Test College' }).returning();
    const instituteId = inst!.id;
    const [level] = await tx.insert(structureLevels).values({ instituteId, depth: 0, name: 'Class' }).returning();
    const today = new Date();
    const day = (d: number) => new Date(today.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const [term] = await tx.insert(terms).values({ instituteId, name: 'Load term', startsOn: day(-30), endsOn: day(60) }).returning();
    const hash = 'unusable'; // nobody signs in with a password here: tokens are made directly

    await tx
      .insert(users)
      .values([1, 2, 3].map((i) => ({ instituteId, role: 'admin' as const, username: `admin${i}`, fullName: `Admin ${i}`, passwordHash: hash })));
    for (let c = 1; c <= CLASSES; c++) {
      const unitId = randomUUID();
      const name = `Class ${String(c).padStart(2, '0')}`;
      await tx.insert(units).values({ id: unitId, instituteId, levelId: level!.id, path: [unitId], name });
      const [teacher] = await tx
        .insert(users)
        .values({ instituteId, role: 'faculty', username: `teacher${c}`, fullName: `Teacher ${c}`, passwordHash: hash })
        .returning();
      const [subject] = await tx.insert(subjects).values({ instituteId, code: `L${String(c).padStart(3, '0')}`, name: `Subject ${c}` }).returning();
      const [offering] = await tx.insert(offerings).values({ instituteId, termId: term!.id, subjectId: subject!.id }).returning();
      await tx.insert(offeringFaculty).values({ offeringId: offering!.id, userId: teacher!.id });
      await tx.insert(offeringAudience).values({ offeringId: offering!.id, unitId });
      const people = await tx
        .insert(users)
        .values(
          Array.from({ length: STUDENTS_PER_CLASS }, (_, i) => ({
            instituteId,
            role: 'student' as const,
            username: `s${String(c).padStart(2, '0')}${String(i + 1).padStart(3, '0')}`,
            fullName: `Student ${c}-${i + 1}`,
            passwordHash: hash,
          })),
        )
        .returning({ id: users.id });
      await tx.insert(students).values(people.map((p, i) => ({ userId: p.id, instituteId, unitId, rollNo: String(i + 1) })));
    }
  });
  console.log(`Set up ${CLASSES} classes, ${CLASSES * STUDENTS_PER_CLASS} students in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

type Sample = { name: string; ms: number; status: number; code?: string; at: number };
const samples: Sample[] = [];

async function call(name: string, base: string, path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const t = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    samples.push({ name, ms: performance.now() - t, status: res.status, code: (body as { error?: { code?: string } })?.error?.code, at: Date.now() });
    return { status: res.status, body };
  } catch (err) {
    samples.push({ name, ms: performance.now() - t, status: 0, code: (err as Error).message, at: Date.now() });
    return { status: 0, body: null };
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

function report(meta: Record<string, unknown>) {
  const names = [...new Set(samples.map((s) => s.name))];
  const rows = names.map((name) => {
    const list = samples.filter((s) => s.name === name);
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    const failed = list.filter((s) => s.status < 200 || s.status >= 300);
    const codes = [...new Set(failed.map((s) => `${s.status} ${s.code ?? ''}`.trim()))].join(', ');
    return { name, count: list.length, failed: failed.length, codes, p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms.at(-1) ?? 0 };
  });
  const perSecond = new Map<number, number>();
  for (const s of samples) perSecond.set(Math.floor(s.at / 1000), (perSecond.get(Math.floor(s.at / 1000)) ?? 0) + 1);
  const peak = Math.max(...perSecond.values());
  const f = (n: number) => n.toFixed(0);
  const lines = [
    `| Request | Count | Failed | p50 ms | p95 ms | p99 ms | max ms |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...rows.map((r) => `| ${r.name} | ${r.count} | ${r.failed}${r.codes ? ` (${r.codes})` : ''} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} |`),
  ];
  console.log(`\n${lines.join('\n')}\n\nPeak: ${peak} requests in one second.`);
  for (const [k, v] of Object.entries(meta)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return { rows, peak, meta };
}

// ---------------------------------------------------------------------------
// A period
// ---------------------------------------------------------------------------

type Phone = { deviceId: string; privateKey: KeyObject };

async function run(db: Db) {
  const base = values.base!;
  const classCount = Number(values.classes);
  const perClass = Number(values['per-class']);
  const windowMs = Number(values.window) * 1000;
  const [inst] = await db.select().from(institutes).where(eq(institutes.code, CODE));
  if (!inst) throw new Error('Run "setup" first');
  const instituteId = inst.id;

  // Fresh phones for everyone scanning (keys exist only in this process).
  const offeringRows = await db
    .select({ offeringId: offerings.id, unitId: offeringAudience.unitId, teacherId: offeringFaculty.userId, code: subjects.code })
    .from(offerings)
    .innerJoin(offeringAudience, eq(offeringAudience.offeringId, offerings.id))
    .innerJoin(offeringFaculty, eq(offeringFaculty.offeringId, offerings.id))
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .where(eq(offerings.instituteId, instituteId))
    .orderBy(subjects.code)
    .limit(classCount);
  // Anything left open by an earlier run.
  await db
    .update(attendanceSessions)
    .set({ status: 'closed', closedAt: new Date() })
    .where(and(eq(attendanceSessions.instituteId, instituteId), eq(attendanceSessions.status, 'open')));

  const classes = [];
  const phones = new Map<string, Phone>();
  const t0 = Date.now();
  await db.delete(devices).where(eq(devices.instituteId, instituteId));
  for (const o of offeringRows) {
    const roster = await db.select({ id: students.userId }).from(students).where(eq(students.unitId, o.unitId!)).orderBy(students.rollNo).limit(perClass);
    const rows = roster.map((s) => {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const id = randomUUID();
      phones.set(s.id, { deviceId: id, privateKey });
      return {
        id,
        instituteId,
        userId: s.id,
        platform: 'android' as const,
        status: 'active' as const,
        publicKey: der,
        keyHash: createHash('sha256').update(der).digest('hex'),
        phoneHash: createHash('sha256').update(`load:${s.id}`).digest('hex'),
        attestation: { securityLevel: 'tee' as const, bootState: 'verified' as const, bootloaderLocked: true, osPatchLevel: 202609, attestationVersion: 300 },
        model: 'Load test phone',
        activatedAt: new Date(),
      };
    });
    for (let i = 0; i < rows.length; i += 500) await db.insert(devices).values(rows.slice(i, i + 500));
    classes.push({ ...o, students: roster.map((s) => s.id) });
  }
  const token = (sub: string, role: 'student' | 'faculty' | 'admin') => signAccessToken({ sub, role, inst: instituteId }, secret!, 2 * 3600);
  const tokens = new Map<string, string>();
  for (const c of classes) {
    tokens.set(c.teacherId, await token(c.teacherId, 'faculty'));
    for (const s of c.students) tokens.set(s, await token(s, 'student'));
  }
  const adminIds = (await db.select({ id: users.id }).from(users).where(and(eq(users.instituteId, instituteId), eq(users.role, 'admin')))).map((a) => a.id);
  for (const a of adminIds) tokens.set(a, await token(a, 'admin'));
  console.log(`Prepared ${phones.size} phones and tokens in ${((Date.now() - t0) / 1000).toFixed(1)} s. Starting the period…`);

  // The bell rings: every teacher starts a session and opens the projector's live stream.
  const started = await Promise.all(
    classes.map(async (c) => {
      const t = tokens.get(c.teacherId)!;
      const res = await call('start session', base, '/v1/sessions', t, { method: 'POST', body: JSON.stringify({ offeringId: c.offeringId, scanMinutes: 10 }) });
      const session = res.body as { id: string };
      const cfg = (await call('projector: qr-config', base, `/v1/sessions/${session.id}/qr-config`, t)).body as { secret: string; rotationSeconds: number };
      await call('teacher: class list', base, `/v1/sessions/${session.id}/records`, t);
      return { ...c, sessionId: session.id, secret: cfg.secret, rotation: cfg.rotationSeconds };
    }),
  );
  const live = { events: 0, streams: 0 };
  const streams = started.map((s) => {
    const controller = new AbortController();
    void fetch(`${base}/v1/sessions/${s.sessionId}/live`, { headers: { authorization: `Bearer ${tokens.get(s.teacherId)}` }, signal: controller.signal })
      .then(async (res) => {
        live.streams++;
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          live.events += (decoder.decode(value).match(/^event: marked$/gm) ?? []).length;
        }
      })
      .catch(() => undefined);
    return controller;
  });

  // Admins watch the dashboard.
  let watching = true;
  const dashboards = adminIds.map(async (a) => {
    while (watching) {
      await call('admin: dashboard', base, '/v1/reports/summary', tokens.get(a)!);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  });

  // Students scan: most in the first part of the window (u^1.7 puts ~60% in the first third).
  const periodStart = Date.now();
  let present = 0;
  const scans = started.flatMap((s) =>
    s.students.map(async (studentId) => {
      await new Promise((r) => setTimeout(r, 1000 + windowMs * Math.random() ** 1.7));
      const qr = qrPayload(s.sessionId, s.secret, stepAt(Date.now(), s.rotation));
      const phone = phones.get(studentId)!;
      const signature = sign('sha256', scanSigningMessage(phone.deviceId, qr), { key: phone.privateKey, dsaEncoding: 'der' }).toString('base64');
      const t = tokens.get(studentId)!;
      const res = await call('student: scan', base, '/v1/attendance/scan', t, { method: 'POST', body: JSON.stringify({ qr, device: { id: phone.deviceId, signature } }) });
      if (res.status === 200) present++;
      await call('student: my attendance', base, '/v1/attendance/mine', t);
    }),
  );
  await Promise.all(scans);
  const scanSeconds = (Date.now() - periodStart) / 1000;
  await new Promise((r) => setTimeout(r, 2000)); // let the live streams catch up
  watching = false;
  await Promise.all(started.map((s) => call('close session', base, `/v1/sessions/${s.sessionId}/close`, tokens.get(s.teacherId)!, { method: 'POST' })));
  for (const c of streams) c.abort();
  await Promise.all(dashboards);

  const [stored] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(attendanceRecords)
    .where(and(inArray(attendanceRecords.sessionId, started.map((s) => s.sessionId)), eq(attendanceRecords.status, 'present')));
  const result = report({
    classes: classCount,
    'students scanning': classCount * perClass,
    'scan window': `${values.window} s (last scan answered after ${scanSeconds.toFixed(0)} s)`,
    'answered present': present,
    'present in the database': stored!.n,
    'live streams': `${live.streams} open, ${live.events} "marked" events (expected ${present})`,
  });
  if (values.out) await writeFile(values.out, JSON.stringify(result, null, 2));
  if (stored!.n !== present) process.exitCode = 1;
}

try {
  if (positionals[0] === 'setup') await setup(db);
  else if (positionals[0] === 'run') await run(db);
  else console.log('Usage: load-test.ts setup | run [--base URL] [--classes N] [--per-class N] [--window SECONDS] [--out file.json]');
} finally {
  await pool.end();
}
