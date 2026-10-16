import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, max } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { structureLevels, students, units } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, deleteOrConflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';

export const MAX_LEVELS = 8;

type UnitRow = typeof units.$inferSelect;

// ---------------------------------------------------------------------------
// Lookups shared with other modules
// ---------------------------------------------------------------------------

/** Tenant-scoped fetch of one unit; a unit of another institute is "not found". */
export async function findUnit(db: DbOrTx, instituteId: string, unitId: string): Promise<UnitRow> {
  const [row] = await db
    .select()
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.instituteId, instituteId)))
    .limit(1);
  if (!row) throw notFound('Unit');
  return row;
}

/** All units of an institute held in memory (an institute has hundreds, not millions). */
export type UnitIndex = {
  byId: Map<string, UnitRow>;
  /** Names from the root down, e.g. ["Computer Engg", "SY", "Div A"]. */
  pathNames(unitId: string): string[];
};

export async function loadUnitIndex(db: DbOrTx, instituteId: string): Promise<UnitIndex> {
  const rows = await db.select().from(units).where(eq(units.instituteId, instituteId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    byId,
    pathNames: (unitId) => (byId.get(unitId)?.path ?? []).map((id) => byId.get(id)?.name ?? '?'),
  };
}

export const formatPath = (names: string[]) => names.join(' › ');

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export type LevelDto = { id: string; depth: number; name: string };

const toLevelDto = (r: typeof structureLevels.$inferSelect): LevelDto => ({ id: r.id, depth: r.depth, name: r.name });

export async function listLevels(db: DbOrTx, instituteId: string): Promise<LevelDto[]> {
  const rows = await db
    .select()
    .from(structureLevels)
    .where(eq(structureLevels.instituteId, instituteId))
    .orderBy(asc(structureLevels.depth));
  return rows.map(toLevelDto);
}

function levelNameTaken(err: unknown, name: string): never {
  if (isUniqueViolation(err, 'structure_levels_name_uq')) {
    throw conflict('LEVEL_NAME_TAKEN', `A level called "${name}" already exists`);
  }
  throw err;
}

/** Adds a level below the current deepest one. */
export async function addLevel(db: Db, auth: InstituteAuthContext, name: string, ip?: string): Promise<LevelDto> {
  return db.transaction(async (tx) => {
    const [{ deepest } = { deepest: null }] = await tx
      .select({ deepest: max(structureLevels.depth) })
      .from(structureLevels)
      .where(eq(structureLevels.instituteId, auth.instituteId));
    const depth = deepest === null ? 0 : deepest + 1;
    if (depth >= MAX_LEVELS) throw badRequest('TOO_MANY_LEVELS', `At most ${MAX_LEVELS} levels are supported`);

    const row = await tx
      .insert(structureLevels)
      .values({ instituteId: auth.instituteId, depth, name })
      .returning()
      .then((r) => r[0]!)
      .catch((err) => levelNameTaken(err, name));
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'structure.level_added',
      entityType: 'structure_level',
      entityId: row.id,
      data: { name, depth },
      ip,
    });
    return toLevelDto(row);
  });
}

export async function renameLevel(
  db: Db,
  auth: InstituteAuthContext,
  levelId: string,
  name: string,
  ip?: string,
): Promise<LevelDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(structureLevels)
      .set({ name })
      .where(and(eq(structureLevels.id, levelId), eq(structureLevels.instituteId, auth.instituteId)))
      .returning()
      .catch((err) => levelNameTaken(err, name));
    if (!row) throw notFound('Level');
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'structure.level_renamed',
      entityType: 'structure_level',
      entityId: levelId,
      data: { name },
      ip,
    });
    return toLevelDto(row);
  });
}

/** Only the deepest level can be removed, and only while no unit uses it. */
export async function deleteLevel(db: Db, auth: InstituteAuthContext, levelId: string, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const levels = await listLevels(tx, auth.instituteId);
    const level = levels.find((l) => l.id === levelId);
    if (!level) throw notFound('Level');
    if (level.depth !== levels.length - 1) {
      throw badRequest('NOT_DEEPEST_LEVEL', 'Only the lowest level can be removed');
    }
    await deleteOrConflict(
      () => tx.delete(structureLevels).where(eq(structureLevels.id, levelId)),
      'LEVEL_IN_USE',
      `Level "${level.name}" still has units; delete them first`,
    );
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'structure.level_deleted',
      entityType: 'structure_level',
      entityId: levelId,
      data: { name: level.name },
      ip,
    });
  });
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitDto = {
  id: string;
  parentId: string | null;
  levelId: string;
  depth: number;
  name: string;
  code: string | null;
  /** Students attached directly to this unit. */
  studentCount: number;
  /** Students in this unit and every unit below it. */
  totalStudentCount: number;
};

const unitNameTaken = (err: unknown, name: string): never => {
  if (isUniqueViolation(err, 'units_sibling_name_uq')) {
    throw conflict('UNIT_NAME_TAKEN', `"${name}" already exists at this place in the structure`);
  }
  throw err;
};

function toUnitDto(r: UnitRow, studentCount = 0, totalStudentCount = studentCount): UnitDto {
  return {
    id: r.id,
    parentId: r.parentId,
    levelId: r.levelId,
    depth: r.path.length - 1,
    name: r.name,
    code: r.code,
    studentCount,
    totalStudentCount,
  };
}

/** The institute's levels and its full unit tree (flat, parents before children). */
export async function getStructure(db: Db, instituteId: string): Promise<{ levels: LevelDto[]; units: UnitDto[] }> {
  const [levels, rows, counts] = await Promise.all([
    listLevels(db, instituteId),
    db.select().from(units).where(eq(units.instituteId, instituteId)),
    db
      .select({ unitId: students.unitId, n: count() })
      .from(students)
      .where(eq(students.instituteId, instituteId))
      .groupBy(students.unitId),
  ]);

  const direct = new Map(counts.map((c) => [c.unitId, c.n]));
  const total = new Map<string, number>();
  for (const r of rows) {
    const n = direct.get(r.id) ?? 0;
    for (const ancestorId of r.path) total.set(ancestorId, (total.get(ancestorId) ?? 0) + n);
  }

  rows.sort((a, b) => a.path.length - b.path.length || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { levels, units: rows.map((r) => toUnitDto(r, direct.get(r.id) ?? 0, total.get(r.id) ?? 0)) };
}

/**
 * Creates a unit at the level below its parent (or at the top level without a parent).
 * Works inside a caller's transaction so bulk import can reuse it.
 */
export async function createUnit(
  db: DbOrTx,
  auth: InstituteAuthContext,
  input: { parentId?: string | null; name: string; code?: string | null },
  ip?: string,
): Promise<UnitDto> {
  const parent = input.parentId ? await findUnit(db, auth.instituteId, input.parentId) : null;
  const depth = parent ? parent.path.length : 0;

  const [level] = await db
    .select()
    .from(structureLevels)
    .where(and(eq(structureLevels.instituteId, auth.instituteId), eq(structureLevels.depth, depth)))
    .limit(1);
  if (!level) {
    throw badRequest(
      'NO_LEVEL_DEFINED',
      parent ? `No level is defined below "${parent.name}"; add a level first` : 'Define the structure levels first',
    );
  }

  const id = randomUUID();
  const [row] = await db
    .insert(units)
    .values({
      id,
      instituteId: auth.instituteId,
      levelId: level.id,
      parentId: parent?.id ?? null,
      path: [...(parent?.path ?? []), id],
      name: input.name,
      code: input.code ?? null,
    })
    .returning()
    .catch((err) => unitNameTaken(err, input.name));

  await writeAudit(db, {
    instituteId: auth.instituteId,
    actorUserId: auth.userId,
    action: 'structure.unit_created',
    entityType: 'unit',
    entityId: id,
    data: { name: input.name, parentId: parent?.id ?? null, level: level.name },
    ip,
  });
  return toUnitDto(row!);
}

export async function updateUnit(
  db: Db,
  auth: InstituteAuthContext,
  unitId: string,
  input: { name?: string; code?: string | null },
  ip?: string,
): Promise<UnitDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(units)
      .set(input)
      .where(and(eq(units.id, unitId), eq(units.instituteId, auth.instituteId)))
      .returning()
      .catch((err) => unitNameTaken(err, input.name ?? ''));
    if (!row) throw notFound('Unit');
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'structure.unit_updated',
      entityType: 'unit',
      entityId: unitId,
      data: { changes: input },
      ip,
    });
    return toUnitDto(row);
  });
}

/** Deletes an empty unit: no child units, students, groups, staff, subjects or offerings. */
export async function deleteUnit(db: Db, auth: InstituteAuthContext, unitId: string, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const unit = await findUnit(tx, auth.instituteId, unitId);
    await deleteOrConflict(
      () => tx.delete(units).where(eq(units.id, unitId)),
      'UNIT_IN_USE',
      `"${unit.name}" is still in use (sub-units, students, groups, staff, subjects or offerings)`,
    );
    await writeAudit(tx, {
      instituteId: auth.instituteId,
      actorUserId: auth.userId,
      action: 'structure.unit_deleted',
      entityType: 'unit',
      entityId: unitId,
      data: { name: unit.name },
      ip,
    });
  });
}
