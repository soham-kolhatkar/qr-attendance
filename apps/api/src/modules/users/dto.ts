import { z } from 'zod';
import { ROLES, users } from '../../db/schema.js';

export const userDtoSchema = z.object({
  id: z.uuid(),
  instituteId: z.uuid().nullable(),
  role: z.enum(ROLES),
  username: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type UserDto = z.infer<typeof userDtoSchema>;

/** Strips private columns (password hash) from a users row. */
export function toUserDto(row: typeof users.$inferSelect): UserDto {
  return {
    id: row.id,
    instituteId: row.instituteId,
    role: row.role,
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
