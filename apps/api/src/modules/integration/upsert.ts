import type { Db } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';
import { loadExistingAccounts } from '../imports/common.js';
import { MAX_IMPORT_ROWS, normalizeHeader, type Sheet } from '../imports/sheet.js';
import { importStaff } from '../imports/staff.js';
import { importStudents } from '../imports/students.js';
import { listLevels } from '../structure/service.js';

/**
 * Bulk create-or-update from JSON, for systems that own the student and staff lists. It
 * runs the same checks and rules as the spreadsheet import (it builds the same sheet):
 * matched by username, blank fields never erase data, all or nothing.
 */

export type StudentRow = {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  rollNo?: string;
  /** The class from the top level down, e.g. ["Computer Engineering", "SY", "Div A"]. */
  class?: string[];
  /** Replaces the student's groups when given. */
  groups?: string[];
};

export type StaffRow = {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  role?: 'faculty' | 'hod' | 'admin';
  designation?: string;
  /** Their department or home unit, from the top level down. */
  unit?: string[];
};

export type UpsertOptions = { dryRun: boolean; createMissing: boolean };

/** One sheet row per JSON row; rows are numbered from 1 in the order sent. */
async function toSheet(
  db: Db,
  instituteId: string,
  rows: { fields: Record<string, string | undefined>; path?: string[] }[],
): Promise<Sheet> {
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest('TOO_MANY_ROWS', `At most ${MAX_IMPORT_ROWS} rows per request`);
  const levels = (await listLevels(db, instituteId)).map((l) => normalizeHeader(l.name));
  const headers = new Set<string>();
  const sheetRows = rows.map(({ fields, path }, i) => {
    if (path && path.length > levels.length) {
      throw badRequest('CLASS_TOO_DEEP', `Row ${i + 1}: the institute's structure has ${levels.length} levels, but ${path.length} were given`);
    }
    const cells = new Map<string, string>();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      cells.set(key, value.trim());
      headers.add(key);
    }
    path?.forEach((name, depth) => {
      cells.set(levels[depth]!, name.trim());
      headers.add(levels[depth]!);
    });
    return { rowNumber: i + 1, cells };
  });
  return { headers: [...headers], rows: sheetRows };
}

export async function upsertStudents(db: Db, auth: InstituteAuthContext, rows: StudentRow[], options: UpsertOptions, ip?: string) {
  const sheet = await toSheet(
    db,
    auth.instituteId,
    rows.map((r) => ({
      fields: {
        username: r.username,
        full_name: r.fullName,
        email: r.email,
        phone: r.phone,
        roll_no: r.rollNo,
        groups: r.groups?.join(', '),
      },
      path: r.class,
    })),
  );
  return importStudents(db, auth, sheet, options, ip);
}

/**
 * Through an API key, admin accounts can't be created or changed: a leaked key must not
 * be able to make itself a way into the admin screens.
 */
export async function upsertStaff(db: Db, auth: InstituteAuthContext, rows: StaffRow[], options: UpsertOptions, ip?: string) {
  if (auth.apiKey) {
    const adminRow = rows.findIndex((r) => r.role === 'admin');
    if (adminRow >= 0) throw badRequest('ADMIN_NOT_ALLOWED', `Row ${adminRow + 1}: API keys can't create admin accounts`);
    const existing = await loadExistingAccounts(db, auth.instituteId, [...new Set(rows.map((r) => r.username.trim().toLowerCase()))]);
    const admin = [...existing.values()].find((a) => a.user.role === 'admin');
    if (admin) throw badRequest('ADMIN_NOT_ALLOWED', `"${admin.user.username}" is an admin; API keys can't change admin accounts`);
  }
  const sheet = await toSheet(
    db,
    auth.instituteId,
    rows.map((r) => ({
      fields: {
        username: r.username,
        full_name: r.fullName,
        email: r.email,
        phone: r.phone,
        role: r.role,
        designation: r.designation,
      },
      path: r.unit,
    })),
  );
  return importStaff(db, auth, sheet, options, ip);
}
