import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, unwrap } from '../api/client';
import { useMeQuery } from '../api/hooks';
import type { Me } from '../api/types';
import { session } from './session';

const LAST_INSTITUTE_KEY = 'qra.lastInstituteCode';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; me: Me };

type AuthContextValue = {
  state: AuthState;
  login(input: { instituteCode?: string; username: string; password: string }): Promise<Me>;
  logout(): Promise<void>;
  /** Re-reads the current user (e.g. after a password change). */
  reload(): Promise<void>;
  lastInstituteCode: string;
  /**
   * True after the user signed out themselves (as opposed to their session expiring):
   * the next sign-in may be someone else, so it starts from their own home page.
   */
  signedOutDeliberately: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [signedIn, setSignedIn] = useState(session.hasRefreshToken());
  const [signedOutDeliberately, setSignedOutDeliberately] = useState(false);
  const me = useMeQuery(signedIn);

  useEffect(() => session.onCleared(() => {
    setSignedIn(false);
    queryClient.clear();
  }), [queryClient]);

  const login = useCallback<AuthContextValue['login']>(async (input) => {
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? 'Login failed'), { code: body?.error?.code });
    session.setTokens(body);
    try {
      if (input.instituteCode) localStorage.setItem(LAST_INSTITUTE_KEY, input.instituteCode.toUpperCase());
    } catch {
      // ignore
    }
    queryClient.clear();
    const fresh = await queryClient.fetchQuery({ queryKey: ['me'], queryFn: async () => unwrap(await api.GET('/v1/me')) });
    setSignedIn(true);
    setSignedOutDeliberately(false);
    return fresh;
  }, [queryClient]);

  const logout = useCallback(async () => {
    const refreshToken = session.getRefreshToken();
    if (refreshToken) await api.POST('/v1/auth/logout', { body: { refreshToken } }).catch(() => undefined);
    setSignedOutDeliberately(true);
    session.clear();
  }, []);

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [queryClient]);

  let state: AuthState;
  if (!signedIn) state = { status: 'anonymous' };
  else if (me.data) state = { status: 'authenticated', me: me.data };
  else if (me.isError) state = { status: 'anonymous' };
  else state = { status: 'loading' };

  let lastInstituteCode = '';
  try {
    lastInstituteCode = localStorage.getItem(LAST_INSTITUTE_KEY) ?? '';
  } catch {
    // ignore
  }

  return (
    <AuthContext.Provider value={{ state, login, logout, reload, lastInstituteCode, signedOutDeliberately }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** The signed-in user; only call inside pages behind RequireAuth. */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('Not signed in');
  return state.me;
}
