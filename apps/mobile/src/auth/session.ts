import * as SecureStore from 'expo-secure-store';
import { server } from '../api/server';

/**
 * Login tokens.
 *
 * - The access token (15 min) lives only in memory.
 * - The refresh token is kept in the phone's secure storage (encrypted with a key in
 *   the phone's hardware), so the student stays signed in. The server rotates it on
 *   every use and ends the whole login if an old one is replayed.
 * - Refreshes are single-flight: many requests failing at once trigger one refresh.
 */

const REFRESH_KEY = 'qra.refreshToken';

export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const session = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,

  /** Reads the saved login, if any. */
  async load(): Promise<boolean> {
    refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    return refreshToken !== null;
  },

  async setTokens(tokens: TokenPair): Promise<void> {
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  },

  async clear(): Promise<void> {
    accessToken = null;
    refreshToken = null;
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    listeners.forEach((l) => l());
  },

  /** Called when the login has ended (sign-out, or the server refused the refresh token). */
  onCleared(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Exchanges the refresh token for a new pair. Resolves false if the login is over or offline. */
  refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const token = refreshToken;
      if (!token) return false;
      try {
        const res = await fetch(`${server.url}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
        });
        if (!res.ok) {
          if (res.status === 401) await session.clear();
          return false;
        }
        await session.setTokens((await res.json()) as TokenPair);
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
