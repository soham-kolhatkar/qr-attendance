/**
 * Creates the platform admin (from env) and, when demo data is wanted, a DEMO institute
 * with a small structure, staff, students and offerings so everything can be tried at
 * once. Runs on every server start in deployments; safe to repeat, it only fills in
 * what is missing.
 *
 * Demo data: on by default in development, opt-in elsewhere with SEED_DEMO=true (e.g. a
 * test deployment). Its passwords are public, so never enable it for a real institute.
 */
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import type { InstituteAuthContext } from '../plugins/auth.js';
import { createSubject, createTerm, listTerms } from '../modules/catalog/service.js';
import { createGroup } from '../modules/groups/service.js';
import { createInstitute } from '../modules/institutes/service.js';
import { rejectCorrection, requestCorrection } from '../modules/corrections/service.js';
import { createOffering } from '../modules/offerings/service.js';
import { addLevel, createUnit, listLevels } from '../modules/structure/service.js';
import { createUser } from '../modules/users/service.js';
import { createDb, type Db } from './client.js';
import {
  attendanceCorrections,
  attendanceRecords,
  attendanceSessions,
  groupMembers,
  institutes,
  offeringAudience,
  offerings,
  staffProfiles,
  students,
  subjects,
  users,
} from './schema.js';

const url = process.env.DATABASE_URL;
const ownerUsername = process.env.SEED_PLATFORM_ADMIN_USERNAME?.toLowerCase();
const ownerPassword = process.env.SEED_PLATFORM_ADMIN_PASSWORD;
if (!url || !ownerUsername || !ownerPassword) {
  throw new Error('Set DATABASE_URL, SEED_PLATFORM_ADMIN_USERNAME and SEED_PLATFORM_ADMIN_PASSWORD');
}
if (process.env.NODE_ENV === 'production' && ownerPassword.length < 12) {
  throw new Error('SEED_PLATFORM_ADMIN_PASSWORD must be at least 12 characters in production');
}
const seedDemoData = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : process.env.NODE_ENV !== 'production';

const DEMO_PASSWORD = 'demo-pass-123';

async function ensureOwner(db: Db) {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(isNull(users.instituteId), eq(users.username, ownerUsername!)))
    .limit(1);
  if (existing) {
    console.log(`Platform admin "${ownerUsername}" already exists.`);
    return existing;
  }
  const [owner] = await db
    .insert(users)
    .values({
      role: 'platform_admin',
      username: ownerUsername!,
      fullName: 'Platform Owner',
      passwordHash: await hashPassword(ownerPassword!),
    })
    .returning();
  console.log(`Created platform admin "${ownerUsername}".`);
  return owner!;
}

async function findUserId(db: Db, instituteId: string, username: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.instituteId, instituteId), eq(users.username, username)))
    .limit(1);
  return row?.id;
}

async function seedDemo(db: Db, ownerId: string) {
  let [demo] = await db.select().from(institutes).where(eq(institutes.code, 'DEMO')).limit(1);
  if (!demo) {
    const { institute } = await createInstitute(db, { userId: ownerId }, {
      code: 'DEMO',
      name: 'Demo Institute of Technology',
      admin: { username: 'admin', fullName: 'Demo Admin', password: DEMO_PASSWORD },
    });
    [demo] = await db.select().from(institutes).where(eq(institutes.id, institute.id));
    console.log('Created DEMO institute.');
  }
  const instituteId = demo!.id;
  const adminId = (await findUserId(db, instituteId, 'admin'))!;
  // Demo accounts use a known password, so don't force the admin to change it.
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, adminId));
  const auth: InstituteAuthContext = { userId: adminId, role: 'admin', instituteId };

  if ((await listLevels(db, instituteId)).length > 0) {
    console.log('DEMO structure already exists.');
    await seedDemoHistory(db, instituteId);
    await seedDemoCorrections(db, instituteId);
    return;
  }

  // Structure: Department › Year › Division, with lab batches under Div A.
  for (const name of ['Department', 'Year', 'Division']) await addLevel(db, auth, name);
  const comp = await createUnit(db, auth, { name: 'Computer Engineering', code: 'COMP' });
  const sy = await createUnit(db, auth, { parentId: comp.id, name: 'SY' });
  const divA = await createUnit(db, auth, { parentId: sy.id, name: 'Div A' });
  const divB = await createUnit(db, auth, { parentId: sy.id, name: 'Div B' });
  const a1 = await createGroup(db, auth, { all: true }, { name: 'A1', kind: 'batch', unitId: divA.id });
  const a2 = await createGroup(db, auth, { all: true }, { name: 'A2', kind: 'batch', unitId: divA.id });

  // Staff (Feature 1 may already have created these accounts without a department).
  const staff = [
    { role: 'hod' as const, username: 'hod.comp', fullName: 'Dr. Kulkarni', designation: 'Head of Department' },
    { role: 'faculty' as const, username: 'prof.sharma', fullName: 'Prof. Sharma', designation: 'Assistant Professor' },
  ];
  const staffIds: Record<string, string> = {};
  for (const s of staff) {
    let id = await findUserId(db, instituteId, s.username);
    if (id) {
      await db
        .insert(staffProfiles)
        .values({ userId: id, instituteId, unitId: comp.id, designation: s.designation })
        .onConflictDoUpdate({ target: staffProfiles.userId, set: { unitId: comp.id, designation: s.designation } });
    } else {
      id = (
        await createUser(db, instituteId, auth, {
          ...s,
          unitId: comp.id,
          password: DEMO_PASSWORD,
          mustChangePassword: false,
        })
      ).user.id;
    }
    staffIds[s.username] = id;
  }

  // Students: four in Div A (batches A1/A2), two in Div B.
  const roster = [
    { username: '2024comp001', fullName: 'Aarav Patil', unitId: divA.id, rollNo: '1', groupId: a1.id },
    { username: '2024comp002', fullName: 'Diya Deshmukh', unitId: divA.id, rollNo: '2', groupId: a1.id },
    { username: '2024comp003', fullName: 'Kabir Joshi', unitId: divA.id, rollNo: '3', groupId: a2.id },
    { username: '2024comp004', fullName: 'Meera Kulkarni', unitId: divA.id, rollNo: '4', groupId: a2.id },
    { username: '2024comp051', fullName: 'Rohan Shinde', unitId: divB.id, rollNo: '1' },
    { username: '2024comp052', fullName: 'Sara Pawar', unitId: divB.id, rollNo: '2' },
  ];
  for (const s of roster) {
    let id = await findUserId(db, instituteId, s.username);
    if (id) {
      await db.update(users).set({ fullName: s.fullName }).where(eq(users.id, id));
    } else {
      id = (
        await createUser(db, instituteId, auth, {
          role: 'student',
          username: s.username,
          fullName: s.fullName,
          password: DEMO_PASSWORD,
          mustChangePassword: false,
        })
      ).user.id;
    }
    await db
      .insert(students)
      .values({ userId: id, instituteId, unitId: s.unitId, rollNo: s.rollNo })
      .onConflictDoUpdate({ target: students.userId, set: { unitId: s.unitId, rollNo: s.rollNo } });
    if (s.groupId) await db.insert(groupMembers).values({ groupId: s.groupId, studentId: id }).onConflictDoNothing();
  }

  // Teaching: one term, two subjects, a lecture for Div A and a lab for batch A1.
  const term =
    (await listTerms(db, instituteId))[0] ??
    (await createTerm(db, auth, { name: '2026-27 Odd Semester', startsOn: '2026-07-01', endsOn: '2026-11-30' }));
  const ds = await createSubject(db, auth, { all: true }, { code: 'CS301', name: 'Data Structures', unitId: comp.id });
  const dbms = await createSubject(db, auth, { all: true }, { code: 'CS302L', name: 'DBMS Lab', unitId: comp.id });
  await createOffering(db, auth, { all: true }, {
    termId: term.id,
    subjectId: ds.id,
    facultyIds: [staffIds['prof.sharma']!],
    audience: { unitIds: [divA.id], groupIds: [] },
  });
  await createOffering(db, auth, { all: true }, {
    termId: term.id,
    subjectId: dbms.id,
    facultyIds: [staffIds['prof.sharma']!],
    audience: { unitIds: [], groupIds: [a1.id] },
  });

  console.log(
    `Seeded DEMO structure. Log in with institute code "DEMO" and password "${DEMO_PASSWORD}" as: ` +
      `admin, hod.comp, prof.sharma, ${roster.map((s) => s.username).join(', ')}`,
  );
  await seedDemoHistory(db, instituteId);
  await seedDemoCorrections(db, instituteId);
}

/** How often each demo student turns up, so the reports have defaulters to show. */
const DEMO_ATTENDANCE: Record<string, number> = {
  '2024comp001': 0.95,
  '2024comp002': 0.86,
  '2024comp003': 0.68,
  '2024comp004': 0.55,
};

/**
 * Six weeks of past classes for the DEMO institute, so reports and dashboards have
 * something to show: CS301 lectures on Mon/Wed/Thu/Fri and the CS302L lab for batch A1
 * on Tuesdays. Added once, while DEMO has hardly any sessions (a few test runs at most).
 * Attendance is pseudo-random but the same on every run.
 */
async function seedDemoHistory(db: Db, instituteId: string) {
  const now = Date.now();
  const [existing] = await db
    .select({ n: count() })
    .from(attendanceSessions)
    .where(eq(attendanceSessions.instituteId, instituteId));
  if ((existing?.n ?? 0) >= 10) return;

  const teacherId = await findUserId(db, instituteId, 'prof.sharma');
  const classes = await db
    .select({ offeringId: offerings.id, code: subjects.code, unitId: offeringAudience.unitId, groupId: offeringAudience.groupId })
    .from(offerings)
    .innerJoin(subjects, eq(subjects.id, offerings.subjectId))
    .innerJoin(offeringAudience, eq(offeringAudience.offeringId, offerings.id))
    .where(and(eq(offerings.instituteId, instituteId), inArray(subjects.code, ['CS301', 'CS302L'])));
  const lecture = classes.find((c) => c.code === 'CS301' && c.unitId);
  const lab = classes.find((c) => c.code === 'CS302L' && c.groupId);
  if (!teacherId || !lecture || !lab) return;

  const rosterOf = async (c: typeof lecture) =>
    c.unitId
      ? db.select({ id: students.userId, username: users.username }).from(students).innerJoin(users, eq(users.id, students.userId)).where(eq(students.unitId, c.unitId))
      : db
          .select({ id: groupMembers.studentId, username: users.username })
          .from(groupMembers)
          .innerJoin(users, eq(users.id, groupMembers.studentId))
          .where(eq(groupMembers.groupId, c.groupId!));
  const rosters = { lecture: await rosterOf(lecture), lab: await rosterOf(lab) };
  const topics = ['Arrays', 'Linked lists', 'Recursion', 'Trees', 'Binary search trees', 'Heaps', 'Hashing', 'Graphs', 'Sorting', 'Searching'];
  const labTopics = ['SQL basics', 'Joins', 'Normalisation', 'Transactions', 'Indexes', 'Views'];
  // A deterministic stand-in for Math.random (0–1), so every run seeds the same history.
  const chance = (a: number, b: number) => (((a * 2654435761 + (b + 1) * 40503 + 12345) >>> 0) % 10007) / 10007;

  let made = 0;
  for (let daysAgo = 42; daysAgo >= 2; daysAgo--) {
    const day = new Date(now - daysAgo * 24 * 3600_000);
    const weekday = day.getUTCDay(); // 0 = Sunday
    // Times in India (UTC+5:30): lectures at 10:00, Thursday's at 11:00, the lab at 14:00.
    const slot =
      weekday === 2
        ? { c: lab, roster: rosters.lab, kind: 'lab' as const, utcHour: 8, topic: labTopics[made % labTopics.length]! }
        : [1, 3, 4, 5].includes(weekday)
          ? { c: lecture, roster: rosters.lecture, kind: 'lecture' as const, utcHour: weekday === 4 ? 5 : 4, topic: topics[made % topics.length]! }
          : null;
    if (!slot) continue;
    const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), slot.utcHour, 30));
    const closesAt = new Date(startedAt.getTime() + 10 * 60_000);
    const [session] = await db
      .insert(attendanceSessions)
      .values({
        instituteId,
        offeringId: slot.c.offeringId,
        createdBy: teacherId,
        kind: slot.kind,
        topic: slot.topic,
        status: 'closed',
        startedAt,
        closesAt,
        closedAt: closesAt,
        qrSecret: randomBytes(32).toString('base64url'),
        qrRotationSeconds: 5,
        qrGraceSeconds: 10,
      })
      .returning({ id: attendanceSessions.id });
    if (slot.roster.length > 0) {
      await db.insert(attendanceRecords).values(
        slot.roster.map((st, i) => {
          const roll = chance(made, i);
          const excused = st.username === '2024comp002' && made % 9 === 4;
          const present = !excused && roll < (DEMO_ATTENDANCE[st.username] ?? 0.85);
          return {
            sessionId: session!.id,
            studentId: st.id,
            instituteId,
            status: excused ? ('excused' as const) : present ? ('present' as const) : ('absent' as const),
            method: excused ? ('manual' as const) : present ? ('qr' as const) : null,
            markedAt: excused || present ? new Date(startedAt.getTime() + (2 + i) * 60_000) : null,
            markedBy: excused ? teacherId : present ? st.id : null,
            reason: excused ? 'Medical certificate' : null,
          };
        }),
      );
    }
    made++;
  }
  await db.update(offerings).set({ talliesStale: true }).where(inArray(offerings.id, [lecture.offeringId, lab.offeringId]));
  console.log(`Added ${made} past DEMO sessions for the reports.`);
}

/**
 * A few correction requests from demo students about recent classes they missed, so the
 * Corrections page and the app have something to show: two waiting, one turned down.
 * Added once (when DEMO has none), through the same code the app and web use.
 */
async function seedDemoCorrections(db: Db, instituteId: string) {
  const [existing] = await db.select({ n: count() }).from(attendanceCorrections).where(eq(attendanceCorrections.instituteId, instituteId));
  if ((existing?.n ?? 0) > 0) return;
  const teacherId = await findUserId(db, instituteId, 'prof.sharma');
  if (!teacherId) return;
  const now = new Date();
  const requests = [
    { username: '2024comp003', requestedStatus: 'present' as const, reason: 'I was in class (second row) but the app said the code had expired. Prof. Sharma saw me.' },
    { username: '2024comp004', requestedStatus: 'excused' as const, reason: 'I had a fever and went to the doctor. I will bring the certificate to the office.' },
    { username: '2024comp002', requestedStatus: 'present' as const, reason: 'My phone battery died, but I was there for the whole lecture.', reject: 'You left after the first ten minutes.' },
  ];
  let made = 0;
  for (const r of requests) {
    const studentId = await findUserId(db, instituteId, r.username);
    if (!studentId) continue;
    // Their latest missed class from the past few days (requests are only allowed for a week).
    const [missed] = await db
      .select({ sessionId: attendanceRecords.sessionId })
      .from(attendanceRecords)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
      .where(
        and(
          eq(attendanceRecords.studentId, studentId),
          eq(attendanceRecords.status, 'absent'),
          eq(attendanceSessions.status, 'closed'),
          gte(attendanceSessions.startedAt, new Date(now.getTime() - 6 * 24 * 3600_000)),
        ),
      )
      .orderBy(desc(attendanceSessions.startedAt))
      .limit(1);
    if (!missed) continue;
    const student: InstituteAuthContext = { userId: studentId, role: 'student', instituteId };
    const request = await requestCorrection(db, student, { sessionId: missed.sessionId, requestedStatus: r.requestedStatus, reason: r.reason }, now);
    if (r.reject) {
      const teacher: InstituteAuthContext = { userId: teacherId, role: 'faculty', instituteId };
      await rejectCorrection(db, teacher, { all: false, unitId: null }, request.id, r.reject, now);
    }
    made++;
  }
  if (made) console.log(`Added ${made} demo correction requests.`);
}

const { db, pool } = createDb(url);
try {
  const owner = await ensureOwner(db);
  if (seedDemoData) await seedDemo(db, owner.id);
} finally {
  await pool.end();
}
