import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { groupMembers, students, users } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, isUniqueViolation } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { groupAcceptsUnit } from '../groups/service.js';
import { listLevels, loadUnitIndex } from '../structure/service.js';
import {
  buildReport,
  cell,
  cleanName,
  type FieldSpec,
  GroupResolver,
  type ImportIssue,
  type ImportReport,
  importHasErrors,
  loadExistingAccounts,
  mapColumns,
  parseOptional,
  parseUsername,
  RowIssues,
  splitList,
  UnitResolver,
  withTemporaryPasswords,
} from './common.js';
import type { Sheet } from './sheet.js';
import { markStudentsStale } from '../reports/tallies.js';

export const STUDENT_FIELDS: FieldSpec[] = [
  {
    key: 'username',
    label: 'Username',
    aliases: ['enrollment_no', 'enrollment_number', 'enrollment', 'prn'],
    required: true,
  },
  { key: 'full_name', label: 'Full Name', aliases: ['name', 'student_name'], required: true },
  { key: 'email', label: 'Email', aliases: ['e_mail', 'email_id'] },
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'mobile_no', 'phone_no', 'contact'] },
  { key: 'roll_no', label: 'Roll No', aliases: ['roll', 'roll_number'] },
  { key: 'groups', label: 'Groups', aliases: ['group', 'batch', 'batches'] },
];

type StudentCreate = {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  rollNo?: string;
  unitId: string;
  groupIds: string[];
};

type StudentUpdate = {
  userId: string;
  account: Partial<Pick<typeof users.$inferInsert, 'fullName' | 'email' | 'phone'>>;
  /** Set when the class or roll number changes, or the student had no profile yet. */
  profile?: { unitId: string; rollNo: string | null };
  /** Replace all memberships with these. */
  groupIds?: string[];
  /** Memberships the new class cannot keep. */
  dropGroupIds: string[];
};

export type ImportOptions = { dryRun: boolean; createMissing: boolean };

/**
 * Creates new students and updates existing ones (matched by username). Blank cells
 * never erase data. A non-empty Groups cell replaces the student's groups.
 * Validation always runs in full; nothing is written on a dry run or if any row fails.
 */
export async function importStudents(
  db: Db,
  auth: InstituteAuthContext,
  sheet: Sheet,
  options: ImportOptions,
  ip?: string,
): Promise<ImportReport> {
  const levels = await listLevels(db, auth.instituteId);
  if (levels.length === 0) {
    throw badRequest('NO_LEVELS', 'Define the structure levels (e.g. Department, Year, Division) before importing');
  }
  const columns = mapColumns(sheet, STUDENT_FIELDS, levels);
  const warnings = [...columns.warnings];
  if (columns.levels.every((h) => !h)) {
    warnings.push(`No structure columns found; expected ${levels.map((l) => `"${l.name}"`).join(', ')}`);
  }

  const index = await loadUnitIndex(db, auth.instituteId);
  const unitResolver = new UnitResolver(index, levels, options.createMissing);
  const groupResolver = await GroupResolver.load(db, auth.instituteId, options.createMissing);
  const usernames = sheet.rows.map((r) => cell(r, columns, 'username').toLowerCase()).filter(Boolean);
  const existing = await loadExistingAccounts(db, auth.instituteId, [...new Set(usernames)]);

  const errors: ImportIssue[] = [];
  const creates: StudentCreate[] = [];
  const updates: StudentUpdate[] = [];
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
    if (account && account.user.role !== 'student') {
      issues.add(`"${username}" is a ${account.user.role} account, not a student`, 'username');
    }

    const fullName = cleanName(cell(row, columns, 'full_name'));
    if (!fullName && !account) issues.add('Full name is required', 'full_name');
    if (fullName.length > 200) issues.add('Full name is too long (max 200)', 'full_name');
    const email = parseOptional(cell(row, columns, 'email'), 'email', issues, { max: 254, email: true });
    const phone = parseOptional(cell(row, columns, 'phone'), 'phone', issues, { min: 5, max: 20 });
    const rollNo = parseOptional(cell(row, columns, 'roll_no'), 'roll_no', issues, { max: 20 });
    const unitNames = unitResolver.namesFromRow(row, columns, issues);

    if (issues.ok && unitNames.length === 0 && !account?.student) {
      issues.add(`Class is required: fill in ${levels.map((l) => `"${l.name}"`).join(', ')}`);
    }
    if (!issues.ok) {
      errors.push(...issues.list);
      continue;
    }

    const unit = unitNames.length > 0 ? unitResolver.resolve(unitNames, issues) : undefined;
    const unitPath = unit?.path ?? index.byId.get(account?.student?.unitId ?? '')?.path ?? [];
    const groupsCell = cell(row, columns, 'groups');
    const resolvedGroups = groupsCell
      ? splitList(groupsCell).map((name) => groupResolver.resolve(name, unitPath, issues, 'groups'))
      : undefined;
    if (!issues.ok) {
      errors.push(...issues.list);
      continue;
    }
    const groupIds = resolvedGroups && [...new Set(resolvedGroups.filter((g): g is string => g !== undefined))];

    if (!account) {
      creates.push({ username: username!, fullName, email, phone, rollNo, unitId: unit!.id, groupIds: groupIds ?? [] });
      continue;
    }

    const change: StudentUpdate = { userId: account.user.id, account: {}, dropGroupIds: [] };
    if (fullName && fullName !== account.user.fullName) change.account.fullName = fullName;
    if (email && email !== account.user.email) change.account.email = email;
    if (phone && phone !== account.user.phone) change.account.phone = phone;

    const currentUnitId = account.student?.unitId;
    const newUnitId = unit?.id ?? currentUnitId!;
    const newRollNo = rollNo ?? account.student?.rollNo ?? null;
    if (!account.student || newUnitId !== currentUnitId || newRollNo !== account.student.rollNo) {
      change.profile = { unitId: newUnitId, rollNo: newRollNo };
    }

    if (groupIds) {
      const wanted = new Set(groupIds);
      const same = wanted.size === account.groupIds.size && [...wanted].every((g) => account.groupIds.has(g));
      if (!same) change.groupIds = [...wanted];
    } else if (newUnitId !== currentUnitId) {
      change.dropGroupIds = [...account.groupIds].filter(
        (g) => !groupAcceptsUnit(groupResolver.unitOf.get(g) ?? null, unitPath),
      );
    }

    const changed =
      Object.keys(change.account).length > 0 || change.profile || change.groupIds || change.dropGroupIds.length > 0;
    if (changed) updates.push(change);
    else unchanged++;
  }

  const counts = { create: creates.length, update: updates.length, unchanged };
  const report = buildReport(options.dryRun, sheet.rows.length, counts, errors, warnings, unitResolver, groupResolver);
  if (options.dryRun) return report;
  if (errors.length > 0) throw importHasErrors(report);

  // Hash outside the transaction so it stays short.
  const newAccounts = await withTemporaryPasswords(creates);

  try {
    await db.transaction(async (tx) => {
      await unitResolver.insertPlanned(tx, auth.instituteId);
      await groupResolver.insertPlanned(tx, auth.instituteId);

      for (let i = 0; i < newAccounts.length; i += 500) {
        const chunk = newAccounts.slice(i, i + 500);
        const inserted = await tx
          .insert(users)
          .values(
            chunk.map((c) => ({
              instituteId: auth.instituteId,
              role: 'student' as const,
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
        await tx.insert(students).values(
          chunk.map((c) => ({
            userId: idOf.get(c.username)!,
            instituteId: auth.instituteId,
            unitId: c.unitId,
            rollNo: c.rollNo ?? null,
          })),
        );
        const memberships = chunk.flatMap((c) => c.groupIds.map((groupId) => ({ groupId, studentId: idOf.get(c.username)! })));
        if (memberships.length > 0) await tx.insert(groupMembers).values(memberships);
      }

      for (const u of updates) {
        if (Object.keys(u.account).length > 0) await tx.update(users).set(u.account).where(eq(users.id, u.userId));
        if (u.profile) {
          await tx
            .insert(students)
            .values({ userId: u.userId, instituteId: auth.instituteId, ...u.profile })
            .onConflictDoUpdate({ target: students.userId, set: u.profile });
        }
        if (u.groupIds) {
          await tx.delete(groupMembers).where(eq(groupMembers.studentId, u.userId));
          if (u.groupIds.length > 0) {
            await tx.insert(groupMembers).values(u.groupIds.map((groupId) => ({ groupId, studentId: u.userId })));
          }
        } else if (u.dropGroupIds.length > 0) {
          await tx
            .delete(groupMembers)
            .where(and(eq(groupMembers.studentId, u.userId), inArray(groupMembers.groupId, u.dropGroupIds)));
        }
      }
      // Report trends are grouped by class.
      await markStudentsStale(
        tx,
        updates.filter((u) => u.profile).map((u) => u.userId),
      );

      await writeAudit(tx, {
        instituteId: auth.instituteId,
        actorUserId: auth.userId,
        action: 'import.students',
        data: { ...counts, newUnits: unitResolver.planned.length, newGroups: groupResolver.planned.length },
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
