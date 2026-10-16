/**
 * Login tokens.
 *
 * - The access token (15 min) lives only in memory.
 * - The refresh token is kept in localStorage so teachers stay signed in on their
 *   laptop. The server rotates it on every use and kills the whole login if an old
 *   one is replayed.
 * - Refreshes are single-flight: many requests failing at once trigger one refresh.
 */

const STORAGE_KEY = 'qra.refreshToken';
const API_URL = import.meta.env.VITE_API_URL ?? '';

export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRefreshToken(token: string | null) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): the login simply won't survive a reload.
  }
}

export const session = {
  getAccessToken: () => accessToken,
  getRefreshToken: readRefreshToken,
  hasRefreshToken: () => readRefreshToken() !== null,

  setTokens(tokens: TokenPair) {
    accessToken = tokens.accessToken;
    writeRefreshToken(tokens.refreshToken);
  },

  clear() {
    accessToken = null;
    writeRefreshToken(null);
    listeners.forEach((l) => l());
  },

  /** Called when the login has ended (logout, or refresh failed). */
  onCleared(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Exchanges the refresh token for a new pair. Resolves false if the login is over. */
  refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const refreshToken = readRefreshToken();
      if (!refreshToken) return false;
      try {
        const res = await fetch(`${API_URL}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          if (res.status === 401) session.clear();
          return false;
        }
        session.setTokens((await res.json()) as TokenPair);
        return true;
      } catch {
        return false; // offline: keep the refresh token and try again later
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
};
