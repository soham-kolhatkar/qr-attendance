/** An error that is safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

function hasPgCode(err: unknown, code: string, constraint?: string): boolean {
  // Drizzle wraps driver errors; the pg error is on `cause`.
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const pgErr = e as { code?: string; constraint?: string };
    if (pgErr.code === code) return constraint === undefined || pgErr.constraint === constraint;
  }
  return false;
}

/** True if `err` is a Postgres unique-constraint violation, optionally on a specific constraint. */
export const isUniqueViolation = (err: unknown, constraint?: string) => hasPgCode(err, '23505', constraint);

/** True if `err` is a foreign-key violation, e.g. deleting a row that is still referenced. */
export const isForeignKeyViolation = (err: unknown) => hasPgCode(err, '23503');

/** Runs a delete and turns "still referenced elsewhere" into a 409 with a helpful message. */
export async function deleteOrConflict<T>(run: () => Promise<T>, code: string, message: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isForeignKeyViolation(err)) throw conflict(code, message);
    throw err;
  }
}
