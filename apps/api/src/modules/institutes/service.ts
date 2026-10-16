import { count, desc, eq, ilike, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { institutes } from '../../db/schema.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { containsPattern } from '../../lib/sql.js';
import { createUser, type CreatedUser } from '../users/service.js';

export type InstituteDto = {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
};

function toInstituteDto(row: typeof institutes.$inferSelect): InstituteDto {
  return { id: row.id, code: row.code, name: row.name, status: row.status, createdAt: row.createdAt.toISOString() };
}

export type CreateInstituteInput = {
  code: string;
  name: string;
  admin: { username: string; fullName: string; email?: string; password?: string };
};

/** Onboards a new institute together with its first administrator. */
export async function createInstitute(
  db: Db,
  actor: { userId: string; ip?: string },
  input: CreateInstituteInput,
): Promise<{ institute: InstituteDto; admin: CreatedUser['user']; temporaryPassword?: string }> {
  return db.transaction(async (tx) => {
    let row;
    try {
      [row] = await tx.insert(institutes).values({ code: input.code, name: input.name }).returning();
    } catch (err) {
      if (isUniqueViolation(err, 'institutes_code_unique')) {
        throw conflict('INSTITUTE_CODE_TAKEN', `Institute code "${input.code}" is already in use`);
      }
      throw err;
    }

    const admin = await createUser(tx, row!.id, actor, { ...input.admin, role: 'admin' });
    await writeAudit(tx, {
      instituteId: row!.id,
      actorUserId: actor.userId,
      action: 'institute.created',
      entityType: 'institute',
      entityId: row!.id,
      data: { code: input.code, name: input.name },
      ip: actor.ip,
    });
    return { institute: toInstituteDto(row!), admin: admin.user, temporaryPassword: admin.temporaryPassword };
  });
}

export async function listInstitutes(db: Db, query: { page: number; pageSize: number; q?: string }) {
  const where = query.q
    ? or(ilike(institutes.code, containsPattern(query.q)), ilike(institutes.name, containsPattern(query.q)))
    : undefined;
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(institutes)
      .where(where)
      .orderBy(desc(institutes.createdAt), institutes.id)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(institutes).where(where),
  ]);
  return { items: rows.map(toInstituteDto), total: totalRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
}

export async function updateInstitute(
  db: Db,
  actor: { userId: string; ip?: string },
  id: string,
  input: { name?: string; status?: 'active' | 'suspended' },
): Promise<InstituteDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(institutes).set(input).where(eq(institutes.id, id)).returning();
    if (!row) throw notFound('Institute');
    await writeAudit(tx, {
      instituteId: id,
      actorUserId: actor.userId,
      action: 'institute.updated',
      entityType: 'institute',
      entityId: id,
      data: { changes: input },
      ip: actor.ip,
    });
    return toInstituteDto(row);
  });
}
