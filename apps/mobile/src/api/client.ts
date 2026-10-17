import createClient, { type Client } from 'openapi-fetch';
import { session } from '../auth/session';
import type { paths } from './schema';
import { server } from './server';

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
 * retries; if that fails the session is cleared and the app shows the sign-in screen.
 */
async function authFetch(request: Request): Promise<Response> {
  const retry = request.clone();
  const withToken = (r: Request) => {
    const token = session.getAccessToken();
    if (token) r.headers.set('authorization', `Bearer ${token}`);
    return r;
  };
  if (!session.getAccessToken() && session.getRefreshToken()) await session.refresh();
  const response = await fetch(withToken(request));
  if (response.status !== 401 || !session.getRefreshToken()) return response;
  if (!(await session.refresh())) return response;
  return fetch(withToken(retry));
}

const clients = new Map<string, Client<paths>>();

/** The typed API client for the current server. */
export function api(): Client<paths> {
  let client = clients.get(server.url);
  if (!client) {
    client = createClient<paths>({ baseUrl: server.url, fetch: authFetch });
    clients.set(server.url, client);
  }
  return client;
}

/** Turns an openapi-fetch result into its data, or throws ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const err = (result.error as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    const status = result.response.status;
    throw new ApiError(status, err?.code ?? 'UNKNOWN', err?.message ?? `Request failed (${status})`, err?.details);
  }
  return result.data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.';
    return err.message;
  }
  if (err instanceof TypeError) return "Can't reach the server. Check your internet connection and try again.";
  return err instanceof Error ? err.message : 'Something went wrong';
}

export const errorCode = (err: unknown) => (err instanceof ApiError ? err.code : null);
