import createClient from 'openapi-fetch';
import { session } from '../auth/session';
import type { paths } from './schema';

export const API_URL = import.meta.env.VITE_API_URL ?? '';

/** An error response from the API: { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * fetch with the access token attached. On a 401 it refreshes the login once and
 * retries; if that fails the session is cleared and the app shows the login page.
 */
export async function authFetch(input: Request | string, init?: RequestInit): Promise<Response> {
  const request = typeof input === 'string' ? new Request(`${API_URL}${input}`, init) : input;
  const retry = request.clone();
  const withToken = (r: Request) => {
    const token = session.getAccessToken();
    if (token) r.headers.set('authorization', `Bearer ${token}`);
    return r;
  };

  if (!session.getAccessToken() && session.hasRefreshToken()) await session.refresh();
  const response = await fetch(withToken(request));
  if (response.status !== 401 || !session.hasRefreshToken()) return response;
  if (!(await session.refresh())) return response;
  return fetch(withToken(retry));
}

export const api = createClient<paths>({ baseUrl: API_URL, fetch: (req) => authFetch(req) });

/** Turns an openapi-fetch result into its data, or throws ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    throw toApiError(result.response.status, result.error);
  }
  return result.data as T;
}

export function toApiError(status: number, body: unknown): ApiError {
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
  return new ApiError(status, err?.code ?? 'UNKNOWN', err?.message ?? `Request failed (${status})`, err?.details);
}

/** For non-JSON calls (file upload/download): throws ApiError on failure. */
export async function checkedFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await authFetch(path, init);
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => undefined));
  return res;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return 'Cannot reach the server. Check your connection.';
  return err instanceof Error ? err.message : 'Something went wrong';
}
