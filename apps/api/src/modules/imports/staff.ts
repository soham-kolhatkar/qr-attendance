import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { staffProfiles, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, isUniqueViolation } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { listLevels, loadUnitIndex } from '../structure/service.js';
import {
  buildReport,
  cell,
  cleanName,
  type FieldSpec,
  hasColumn,
  type ImportIssue,
  type ImportReport,
  importHasErrors,
  loadExistingAccounts,
  mapColumns,
  parseOptional,
  parseUsername,
  RowIssues,
  UnitResolver,
  withTemporaryPasswords,
} from './common.js';
import type { Sheet } from './sheet.js';
import type { ImportOptions } from './students.js';

export const STAFF_FIELDS: FieldSpec[] = [
  { key: 'username', label: 'Username', aliases: ['employee_id', 'emp_id', 'staff_id'], required: true },
  { key: 'full_name', label: 'Full Name', aliases: ['name'], required: true },
  { key: 'email', label: 'Email', aliases: ['e_mail', 'email_id'] },
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'mobile_no', 'phone_no', 'contact'] },
  { key: 'role', label: 'Role', aliases: [] },
  { key: 'designation', label: 'Designation', aliases: ['title'] },
];

const STAFF_ROLES = ['faculty', 'hod', 'admin'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

type StaffCreate = {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  role: StaffRole;
  designation?: string;
  unitId: string | null;
};

type StaffUpdate = {
  userId: string;
  account: Partial<Pick<typeof users.$inferInsert, 'fullName' | 'email' | 'phone'>>;
  profile?: { unitId: string | null; designation: string | null };
};

/**
 * Creates and updates faculty / HOD / admin accounts (matched by username). The
 * structure columns give the person's department (home unit); a HOD must have one.
 * Roles of existing accounts are never changed by an import.
 */
export async function importStaff(
  db: Db,
  auth: InstituteAuthContext,
  sheet: Sheet,
  options: ImportOptions,
  ip?: string,
): Promise<ImportReport> {
  const levels = await listLevels(db, auth.instituteId);
  const columns = mapColumns(sheet, STAFF_FIELDS, levels);
  const index = await loadUnitIndex(db, auth.instituteId);
  const unitResolver = new UnitResolver(index, levels, options.createMissing);
  const usernames = sheet.rows.map((r) => cell(r, columns, 'username').toLowerCase()).filter(Boolean);
  const existing = await loadExistingAccounts(db, auth.instituteId, [...new Set(usernames)]);

  const errors: ImportIssue[] = [];
  const creates: StaffCreate[] = [];
  const updates: StaffUpdate[] = [];
  let unchanged = 0;
  const firstRowOf = new Map<string, number>();

  for (const row of sheet.rows) {
    const issues = new RowIssues(row.rowNumber);
    const username = parseUsername(cell(row, columns, 'username'), issues);
    if (username !== undefined) {
      const first = firstRowOf.get(username);
      if (first !== undefined) issues.add(`Same username as row ${first}`, 'username');
      else firstRowOf.set(username, row.rowNumber);
    }
    const account = username ? existing.get(username) : undefined;
    if (account?.user.role === 'student') issues.add(`"${username}" is a student account`, 'username');

    const roleCell = cell(row, columns, 'role').toLowerCase();
    let role: StaffRole | undefined;
    if (roleCell) {
      if ((STAFF_ROLES as readonly string[]).includes(roleCell)) role = roleCell as StaffRole;
      else issues.add(`Role must be one of: ${STAFF_ROLES.join(', ')}`, 'role');
    }
    if (account && role && account.user.role !== 'student' && role !== account.user.role) {
      issues.add(`Role differs from the existing ${account.user.role} account; change roles in user management`, 'role');
    }

    const fullName = cleanName(cell(row, columns, 'full_name'));
    if (!fullName && !account) issues.add('Full name is required', 'full_name');
    if (fullName.length > 200) issues.add('Full name is too long (max 200)', 'full_name');
    const email = parseOptional(cell(row, columns, 'email'), 'email', issues, { max: 254, email: true });
    const phone = parseOptional(cell(row, columns, 'phone'), 'phone', issues, { min: 5, max: 20 });
    const designation = parseOptional(cell(row, columns, 'designation'), 'designation', issues, { max: 100 });
    const unitNames = unitResolver.namesFromRow(row, columns, issues);
    if (!issues.ok) {
      errors.push(...issues.list);
      continue;
    }

    const unit = unitNames.length > 0 ? unitResolver.resolve(unitNames, issues) : undefined;
    const finalRole = account?.user.role ?? role ?? 'faculty';
    const finalUnitId = unit?.id ?? account?.staff?.unitId ?? null;
    if (issues.ok && finalRole === 'hod' && !finalUnitId) {
      issues.add('A HOD needs a department: fill in the structure columns', levels[0]?.name);
    }
    if (!issues.ok) {
      errors.push(...issues.list);
      continue;
    }

    if (!account) {
      creates.push({
        username: username!,
        fullName,
        email,
        phone,
        role: finalRole as StaffRole,
        designation,
        unitId: finalUnitId,
      });
      continue;
    }

    const change: StaffUpdate = { userId: account.user.id, account: {} };
    if (fullName && fullName !== account.user.fullName) change.account.fullName = fullName;
    if (email && email !== account.user.email) change.account.email = email;
    if (phone && phone !== account.user.phone) change.account.phone = phone;
    const newDesignation = designation ?? account.staff?.designation ?? null;
    if (!account.staff || finalUnitId !== account.staff.unitId || newDesignation !== account.staff.designation) {
      change.profile = { unitId: finalUnitId, designation: newDesignation };
    }
    if (Object.keys(change.account).length > 0 || change.profile) updates.push(change);
    else unchanged++;
  }

  const warnings = [...columns.warnings];
  if (!hasColumn(columns, 'role')) warnings.push('No "Role" column: new accounts will be faculty');

  const counts = { create: creates.length, update: updates.length, unchanged };
  const report = buildReport(options.dryRun, sheet.rows.length, counts, errors, warnings, unitResolver);
  if (options.dryRun) return report;
  if (errors.length > 0) throw importHasErrors(report);

  const newAccounts = await withTemporaryPasswords(creates);
  try {
    await db.transaction(async (tx) => {
      await unitResolver.insertPlanned(tx, auth.instituteId);
      for (let i = 0; i < newAccounts.length; i += 500) {
        const chunk = newAccounts.slice(i, i + 500);
        const inserted = await tx
          .insert(users)
          .values(
            chunk.map((c) => ({
              instituteId: auth.instituteId,
              role: c.role,
              username: c.username,
              fullName: c.fullName,
              email: c.email,
              phone: c.phone,
              passwordHash: c.passwordHash,
              mustChangePassword: true,
            })),
          )
          .returning({ id: users.id, username: users.username });
        const idOf = new Map(inserted.map((u) => [u.username, u.id]));
        await tx.insert(staffProfiles).values(
          chunk.map((c) => ({
            userId: idOf.get(c.username)!,
            instituteId: auth.instituteId,
            unitId: c.unitId,
            designation: c.designation ?? null,
          })),
        );
      }

      for (const u of updates) {
        if (Object.keys(u.account).length > 0) await tx.update(users).set(u.account).where(eq(users.id, u.userId));
        if (u.profile) {
          await tx
            .insert(staffProfiles)
            .values({ userId: u.userId, instituteId: auth.instituteId, ...u.profile })
            .onConflictDoUpdate({ target: staffProfiles.userId, set: u.profile });
        }
      }

      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: 'import.staff',
        data: { ...counts, newUnits: unitResolver.planned.length },
        ip,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('IMPORT_CONFLICT', 'Data changed while importing (e.g. a username was just taken); run the import again');
    }
    throw err;
  }

  return {
    ...report,
    credentials: newAccounts.map((a) => ({ username: a.username, fullName: a.fullName, temporaryPassword: a.password })),
  };
}
