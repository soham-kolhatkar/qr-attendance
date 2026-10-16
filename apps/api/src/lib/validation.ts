import { z } from 'zod';

/** Institute short code, e.g. "VJTI" or "MIT-WPU". Normalised to upper-case. */
export const instituteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,20}$/, 'Use 2–20 letters, digits or hyphens');

/** Login id (enrollment no., employee id or email). Normalised to lower-case. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._@-]{3,64}$/, 'Use 3–64 letters, digits or . _ @ -');

export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);

export const idParamsSchema = z.object({ id: z.uuid() });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
}
