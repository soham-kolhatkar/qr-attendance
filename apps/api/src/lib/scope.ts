import { eq, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.js';
import { staffProfiles } from '../db/schema.js';
import type { InstituteAuthContext } from '../plugins/auth.js';
import { forbidden } from './errors.js';

/**
 * Which part of the institute's unit tree a user may manage.
 * - admin: everything
 * - hod:   the subtree under their staff-profile unit (nothing if none is set)
 * - others: nothing (they get narrower, role-specific access elsewhere)
 */
export type Scope = { all: true } | { all: false; unitId: string | null };

export async function resolveScope(db: DbOrTx, auth: InstituteAuthContext): Promise<Scope> {
  if (auth.role === 'admin') return { all: true };
  if (auth.role !== 'hod') return { all: false, unitId: null };
  const [profile] = await db
    .select({ unitId: staffProfiles.unitId })
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, auth.userId))
    .limit(1);
  return { all: false, unitId: profile?.unitId ?? null };
}

/** `unitPath` is a unit's root-to-self id path. */
export function isPathInScope(scope: Scope, unitPath: readonly string[] | null | undefined): boolean {
  if (scope.all) return true;
  return scope.unitId !== null && !!unitPath?.includes(scope.unitId);
}

export function assertPathInScope(scope: Scope, unitPath: readonly string[] | null | undefined, what: string): void {
  if (!isPathInScope(scope, unitPath)) throw forbidden(`${what} is outside the part of the institute you manage`);
}

/** SQL condition limiting rows to the scope, given a units.path column. undefined = no limit. */
export function scopeCondition(scope: Scope, pathColumn: PgColumn): SQL | undefined {
  if (scope.all) return undefined;
  if (scope.unitId === null) return sql`false`;
  return sql`${pathColumn} @> ARRAY[${scope.unitId}]::uuid[]`;
}

/** SQL: `pathColumn` overlaps any of `unitIds`, i.e. the row is in one of those subtrees. */
export function pathWithinAny(pathColumn: PgColumn, unitIds: readonly string[]): SQL {
  if (unitIds.length === 0) return sql`false`;
  return sql`${pathColumn} && ARRAY[${sql.join(
    unitIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}
