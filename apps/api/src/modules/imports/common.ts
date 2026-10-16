import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client.js';
import { groupMembers, groups, staffProfiles, students, units, users } from '../../db/schema.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { generateTemporaryPassword, hashTemporaryPassword } from '../../lib/password.js';
import { usernameSchema } from '../../lib/validation.js';
import { formatPath, type LevelDto, type UnitIndex } from '../structure/service.js';
import { normalizeHeader, type Sheet, type SheetRow } from './sheet.js';

export type ImportIssue = { row: number; column?: string; message: string };

export type ImportReport = {
  dryRun: boolean;
  summary: { rows: number; create: number; update: number; unchanged: number; errors: number };
  /** Units that will be (or were) created, as "Dept › Year › Division". */
  newUnits: string[];
  /** Groups that will be (or were) created, as "A1 (Dept › Year › Division)". */
  newGroups: string[];
  errors: ImportIssue[];
  warnings: string[];
  /** Commit only: temporary passwords for newly created accounts. */
  credentials?: { username: string; fullName: string; temporaryPassword: string }[];
};

export const MAX_REPORTED_ERRORS = 500;

/** Thrown when a commit is attempted on a file that has errors. */
export const importHasErrors = (report: ImportReport) =>
  new AppError(422, 'IMPORT_HAS_ERRORS', 'The file has errors; nothing was imported', report);

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type FieldSpec = { key: string; label: string; aliases: string[]; required?: boolean };

export type ColumnMap = {
  /** Field key → normalised header present in the file. */
  fields: Map<string, string>;
  /** One normalised header per structure level, in depth order (undefined if absent). */
  levels: (string | undefined)[];
  warnings: string[];
};

/** Matches file headers to known fields and structure levels; rejects files missing required columns. */
export function mapColumns(sheet: Sheet, specs: FieldSpec[], levels: LevelDto[]): ColumnMap {
  const present = new Set(sheet.headers);
  const used = new Set<string>();
  const fields = new Map<string, string>();

  for (const spec of specs) {
    const header = [spec.key, ...spec.aliases].map(normalizeHeader).find((h) => present.has(h));
    if (header) {
      fields.set(spec.key, header);
      used.add(header);
    }
  }
  const missing = specs.filter((s) => s.required && !fields.has(s.key)).map((s) => s.label);
  if (missing.length > 0) {
    throw badRequest('MISSING_COLUMNS', `Required column(s) missing: ${missing.join(', ')}`, {
      expected: [...specs.map((s) => s.label), ...levels.map((l) => l.name)],
    });
  }

  const levelHeaders = levels.map((l) => {
    const h = normalizeHeader(l.name);
    if (!present.has(h) || used.has(h)) return undefined;
    used.add(h);
    return h;
  });

  const unknown = sheet.headers.filter((h) => !used.has(h));
  const warnings = unknown.length > 0 ? [`Ignored unknown column(s): ${unknown.join(', ')}`] : [];
  return { fields, levels: levelHeaders, warnings };
}

export function cell(row: SheetRow, columns: ColumnMap, key: string): string {
  const header = columns.fields.get(key);
  return header ? (row.cells.get(header) ?? '') : '';
}

export const hasColumn = (columns: ColumnMap, key: string) => columns.fields.has(key);

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

/** Collects problems for one row. */
export class RowIssues {
  readonly list: ImportIssue[] = [];
  constructor(readonly row: number) {}
  add(message: string, column?: string) {
    this.list.push({ row: this.row, column, message });
  }
  get ok() {
    return this.list.length === 0;
  }
}

export function parseUsername(raw: string, issues: RowIssues): string | undefined {
  if (!raw) return void issues.add('Username is required', 'username');
  const parsed = usernameSchema.safeParse(raw);
  if (!parsed.success) return void issues.add(`"${raw}": ${parsed.error.issues[0]!.message}`, 'username');
  return parsed.data;
}

const emailSchema = z.email();

export function parseOptional(
  raw: string,
  column: string,
  issues: RowIssues,
  rule: { max: number; min?: number; email?: boolean },
): string | undefined {
  if (!raw) return undefined;
  if (rule.email && !emailSchema.safeParse(raw).success) return void issues.add(`"${raw}" is not a valid email`, column);
  if (raw.length > rule.max || raw.length < (rule.min ?? 1)) {
    return void issues.add(`Must be ${rule.min ?? 1}–${rule.max} characters`, column);
  }
  return raw;
}

/** Collapses whitespace so "Div  A " matches "Div A". */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// Units: find existing or plan new ones
// ---------------------------------------------------------------------------

export type PlannedUnit = { id: string; parentId: string | null; levelId: string; path: string[]; name: string };

export class UnitResolver {
  private readonly byKey = new Map<string, { id: string; path: string[] }>();
  readonly planned: PlannedUnit[] = [];
  private readonly names = new Map<string, string>();
  private readonly paths = new Map<string, string[]>();

  constructor(
    index: UnitIndex,
    private readonly levels: LevelDto[],
    private readonly createMissing: boolean,
  ) {
    for (const u of index.byId.values()) {
      this.byKey.set(this.key(u.parentId, u.name), { id: u.id, path: u.path });
      this.names.set(u.id, u.name);
      this.paths.set(u.id, u.path);
    }
  }

  private key(parentId: string | null, name: string) {
    return `${parentId ?? ''}|${cleanName(name).toLowerCase()}`;
  }

  /** Level cells of a row in depth order → unit names. Blank-then-filled is an error. */
  namesFromRow(row: SheetRow, columns: ColumnMap, issues: RowIssues): string[] {
    const values = columns.levels.map((h) => (h ? cleanName(row.cells.get(h) ?? '') : ''));
    const firstBlank = values.indexOf('');
    const names = firstBlank === -1 ? values : values.slice(0, firstBlank);
    const later = firstBlank === -1 ? -1 : values.findIndex((v, i) => i > firstBlank && v !== '');
    if (later !== -1) {
      issues.add(`Fill in "${this.levels[firstBlank]!.name}" before "${this.levels[later]!.name}"`, this.levels[later]!.name);
      return [];
    }
    return names;
  }

  resolve(names: string[], issues: RowIssues): { id: string; path: string[] } | undefined {
    let parent: { id: string; path: string[] } | null = null;
    for (const [depth, name] of names.entries()) {
      const key = this.key(parent?.id ?? null, name);
      let unit = this.byKey.get(key);
      if (!unit) {
        if (!this.createMissing) {
          const where = parent ? ` under "${this.label(parent.path)}"` : '';
          return void issues.add(`${this.levels[depth]!.name} "${name}" does not exist${where}`, this.levels[depth]!.name);
        }
        const id = randomUUID();
        const plannedUnit: PlannedUnit = {
          id,
          parentId: parent?.id ?? null,
          levelId: this.levels[depth]!.id,
          path: [...(parent?.path ?? []), id],
          name,
        };
        this.planned.push(plannedUnit);
        this.names.set(id, name);
        this.paths.set(id, plannedUnit.path);
        unit = { id, path: plannedUnit.path };
        this.byKey.set(key, unit);
      }
      parent = unit;
    }
    return parent ?? undefined;
  }

  label(path: string[]): string {
    return formatPath(path.map((id) => this.names.get(id) ?? '?'));
  }

  labelOf(unitId: string): string {
    return this.label(this.paths.get(unitId) ?? [unitId]);
  }

  async insertPlanned(tx: DbOrTx, instituteId: string): Promise<void> {
    const ordered = [...this.planned].sort((a, b) => a.path.length - b.path.length);
    for (let i = 0; i < ordered.length; i += 500) {
      await tx.insert(units).values(ordered.slice(i, i + 500).map((u) => ({ ...u, instituteId })));
    }
  }
}

// ---------------------------------------------------------------------------
// Groups: nearest group with that name up the student's unit path, or plan one
// ---------------------------------------------------------------------------

export type PlannedGroup = { id: string; unitId: string; name: string };

export class GroupResolver {
  private readonly byKey = new Map<string, string>();
  /** Group id → the unit it is anchored at (null = institute-wide). */
  readonly unitOf = new Map<string, string | null>();
  readonly planned: PlannedGroup[] = [];

  private constructor(private readonly createMissing: boolean) {}

  static async load(db: DbOrTx, instituteId: string, createMissing: boolean): Promise<GroupResolver> {
    const resolver = new GroupResolver(createMissing);
    const rows = await db.select().from(groups).where(eq(groups.instituteId, instituteId));
    for (const g of rows) {
      resolver.byKey.set(resolver.key(g.unitId, g.name), g.id);
      resolver.unitOf.set(g.id, g.unitId);
    }
    return resolver;
  }

  private key(unitId: string | null, name: string) {
    return `${unitId ?? ''}|${cleanName(name).toLowerCase()}`;
  }

  /** Looks in the student's unit, then each parent, then institute-wide. */
  resolve(name: string, unitPath: string[], issues: RowIssues, column: string): string | undefined {
    for (const unitId of [...unitPath].reverse()) {
      const id = this.byKey.get(this.key(unitId, name));
      if (id) return id;
    }
    const global = this.byKey.get(this.key(null, name));
    if (global) return global;

    if (!this.createMissing) return void issues.add(`Group "${name}" does not exist for this class`, column);
    const unitId = unitPath[unitPath.length - 1]!;
    const id = randomUUID();
    this.planned.push({ id, unitId, name: cleanName(name) });
    this.byKey.set(this.key(unitId, name), id);
    this.unitOf.set(id, unitId);
    return id;
  }

  async insertPlanned(tx: DbOrTx, instituteId: string): Promise<void> {
    for (let i = 0; i < this.planned.length; i += 500) {
      await tx.insert(groups).values(this.planned.slice(i, i + 500).map((g) => ({ ...g, instituteId, kind: 'batch' })));
    }
  }
}

/** "A1, A2; Elective-ML" → ["A1", "A2", "Elective-ML"] */
export const splitList = (raw: string) =>
  raw
    .split(/[,;]/)
    .map(cleanName)
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Existing accounts
// ---------------------------------------------------------------------------

export type ExistingAccount = {
  user: typeof users.$inferSelect;
  student: typeof students.$inferSelect | null;
  staff: typeof staffProfiles.$inferSelect | null;
  groupIds: Set<string>;
};

export async function loadExistingAccounts(
  db: DbOrTx,
  instituteId: string,
  usernames: string[],
): Promise<Map<string, ExistingAccount>> {
  const result = new Map<string, ExistingAccount>();
  for (let i = 0; i < usernames.length; i += 1000) {
    const rows = await db
      .select({ user: users, student: students, staff: staffProfiles })
      .from(users)
      .leftJoin(students, eq(students.userId, users.id))
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.instituteId, instituteId), inArray(users.username, usernames.slice(i, i + 1000))));
    for (const r of rows) result.set(r.user.username, { ...r, groupIds: new Set() });
  }

  const studentIds = [...result.values()].filter((a) => a.student).map((a) => a.user.id);
  const byId = new Map([...result.values()].map((a) => [a.user.id, a]));
  for (let i = 0; i < studentIds.length; i += 1000) {
    const memberships = await db
      .select()
      .from(groupMembers)
      .where(inArray(groupMembers.studentId, studentIds.slice(i, i + 1000)));
    for (const m of memberships) byId.get(m.studentId)!.groupIds.add(m.groupId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// New accounts
// ---------------------------------------------------------------------------

/** Generates and hashes temporary passwords, a few at a time on the libuv thread pool. */
export async function withTemporaryPasswords<T>(items: T[]): Promise<(T & { password: string; passwordHash: string })[]> {
  const out: (T & { password: string; passwordHash: string })[] = [];
  for (let i = 0; i < items.length; i += 64) {
    const chunk = await Promise.all(
      items.slice(i, i + 64).map(async (item) => {
        const password = generateTemporaryPassword();
        return { ...item, password, passwordHash: await hashTemporaryPassword(password) };
      }),
    );
    out.push(...chunk);
  }
  return out;
}

export function buildReport(
  dryRun: boolean,
  rows: number,
  counts: { create: number; update: number; unchanged: number },
  errors: ImportIssue[],
  warnings: string[],
  unitsResolver: UnitResolver,
  groupsResolver?: GroupResolver,
): ImportReport {
  return {
    dryRun,
    summary: { rows, ...counts, errors: errors.length },
    newUnits: unitsResolver.planned.map((u) => unitsResolver.label(u.path)),
    newGroups: (groupsResolver?.planned ?? []).map((g) => `${g.name} (${unitsResolver.labelOf(g.unitId)})`),
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    warnings,
  };
}
