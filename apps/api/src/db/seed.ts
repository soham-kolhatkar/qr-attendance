/**
 * Development seed: creates the platform admin (from env) and, outside production,
 * a DEMO institute with one user per role so the API can be tried immediately.
 * Safe to run repeatedly.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { createInstitute } from '../modules/institutes/service.js';
import { createUser } from '../modules/users/service.js';
import { createDb } from './client.js';
import { institutes, users } from './schema.js';

const url = process.env.DATABASE_URL;
const ownerUsername = process.env.SEED_PLATFORM_ADMIN_USERNAME?.toLowerCase();
const ownerPassword = process.env.SEED_PLATFORM_ADMIN_PASSWORD;
if (!url || !ownerUsername || !ownerPassword) {
  throw new Error('Set DATABASE_URL, SEED_PLATFORM_ADMIN_USERNAME and SEED_PLATFORM_ADMIN_PASSWORD');
}

const { db, pool } = createDb(url);
try {
  let [owner] = await db
    .select()
    .from(users)
    .where(and(isNull(users.instituteId), eq(users.username, ownerUsername)))
    .limit(1);
  if (!owner) {
    [owner] = await db
      .insert(users)
      .values({
        role: 'platform_admin',
        username: ownerUsername,
        fullName: 'Platform Owner',
        passwordHash: await hashPassword(ownerPassword),
      })
      .returning();
    console.log(`Created platform admin "${ownerUsername}".`);
  } else {
    console.log(`Platform admin "${ownerUsername}" already exists.`);
  }

  if (process.env.NODE_ENV !== 'production') {
    const [demo] = await db.select().from(institutes).where(eq(institutes.code, 'DEMO')).limit(1);
    if (demo) {
      console.log('DEMO institute already exists.');
    } else {
      const actor = { userId: owner!.id };
      const password = 'demo-pass-123';
      const { institute } = await createInstitute(db, actor, {
        code: 'DEMO',
        name: 'Demo Institute of Technology',
        admin: { username: 'admin', fullName: 'Demo Admin', password },
      });
      for (const [role, username, fullName] of [
        ['hod', 'hod.comp', 'Demo HOD'],
        ['faculty', 'prof.sharma', 'Prof. Sharma'],
        ['student', '2024comp001', 'Demo Student'],
      ] as const) {
        await createUser(db, institute.id, actor, { role, username, fullName, password, mustChangePassword: false });
      }
      console.log(
        `Created DEMO institute. Log in with instituteCode "DEMO" and password "${password}" as: ` +
          'admin, hod.comp, prof.sharma, 2024comp001',
      );
    }
  }
} finally {
  await pool.end();
}
