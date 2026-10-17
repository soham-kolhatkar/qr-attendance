import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, api, unwrap } from '../api/client';
import { server } from '../api/server';
import type { Me } from '../api/types';
import { unregisterPush } from '../notifications/push';
import { session, type TokenPair } from './session';

type AuthState =
  | { status: 'loading' }
  /** A saved login exists but the server can't be reached to check it. */
  | { status: 'offline' }
  | { status: 'signedOut'; notice?: string }
  | { status: 'signedIn'; me: Me };

type AuthContextValue = {
  state: AuthState;
  signIn(input: { instituteCode: string; username: string; password: string }): Promise<void>;
  signOut(notice?: string): Promise<void>;
  /** Re-reads the account (e.g. after changing the password). */
  reloadMe(): Promise<void>;
  /** Tries the saved login again after being offline. */
  retry(): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const NOT_A_STUDENT = (url: string) =>
  `This app is for students. Teachers and admins use the website: ${url.replace(/^https?:\/\//, '')}`;

async function fetchMe(): Promise<Me> {
  return unwrap(await api().GET('/v1/me'));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const queryClient = useQueryClient();

  const end = useCallback(
    (notice?: string) => {
      queryClient.clear();
      setState({ status: 'signedOut', notice });
    },
    [queryClient],
  );

  // Restore the saved login on launch.
  const restore = useCallback(async () => {
    setState({ status: 'loading' });
    await server.load();
    if (!(await session.load())) return setState({ status: 'signedOut' });
    try {
      const me = await fetchMe();
      if (me.user.role !== 'student') {
        await session.clear();
        return setState({ status: 'signedOut', notice: NOT_A_STUDENT(server.url) });
      }
      setState({ status: 'signedIn', me });
    } catch (err) {
      // The server refused the login (expired, disabled): sign in again. Otherwise we're
      // offline and the saved login may still be good.
      if (err instanceof ApiError) {
        await session.clear();
        setState({ status: 'signedOut' });
      } else {
        setState({ status: 'offline' });
      }
    }
  }, []);
  useEffect(() => {
    void restore();
  }, [restore]);

  // The server ended the login (expired, signed out elsewhere, account disabled).
  useEffect(
    () =>
      session.onCleared(() => {
        queryClient.clear();
        setState((s) => (s.status === 'signedIn' ? { status: 'signedOut' } : s));
      }),
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      async signIn(input) {
        const res = await fetch(`${server.url}/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'Sign-in failed');
        }
        await session.setTokens(body as TokenPair);
        queryClient.clear(); // nothing from a previous student on this phone
        const me = await fetchMe();
        if (me.user.role !== 'student') {
          await logout();
          throw new Error(NOT_A_STUDENT(server.url));
        }
        setState({ status: 'signedIn', me });
      },
      async signOut(notice) {
        await logout();
        end(notice);
      },
      async reloadMe() {
        setState({ status: 'signedIn', me: await fetchMe() });
      },
      retry: () => void restore(),
    }),
    [state, end, restore, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Ends the login on the server (best effort) and forgets it here. */
async function logout(): Promise<void> {
  await unregisterPush().catch(() => undefined);
  const refreshToken = session.getRefreshToken();
  if (refreshToken) {
    await fetch(`${server.url}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
  await session.clear();
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in student. Only for screens behind the sign-in gate. */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('Not signed in');
  return state.me;
}
