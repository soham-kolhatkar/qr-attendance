/**
 * Creates the platform admin (from env) and, when demo data is wanted, a DEMO institute
 * with a small structure, staff, students and offerings so everything can be tried at
 * once. Runs on every server start in deployments; safe to repeat, it only fills in
 * what is missing.
 *
 * Demo data: on by default in development, opt-in elsewhere with SEED_DEMO=true (e.g. a
 * test deployment). Its passwords are public, so never enable it for a real institute.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import type { InstituteAuthContext } from '../plugins/auth.js';
import { createSubject, createTerm, listTerms } from '../modules/catalog/service.js';
import { createGroup } from '../modules/groups/service.js';
import { createInstitute } from '../modules/institutes/service.js';
import { createOffering } from '../modules/offerings/service.js';
import { addLevel, createUnit, listLevels } from '../modules/structure/service.js';
import { createUser } from '../modules/users/service.js';
import { createDb, type Db } from './client.js';
import { groupMembers, institutes, staffProfiles, students, users } from './schema.js';

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
}

const { db, pool } = createDb(url);
try {
  const owner = await ensureOwner(db);
  if (seedDemoData) await seedDemo(db, owner.id);
} finally {
  await pool.end();
}
