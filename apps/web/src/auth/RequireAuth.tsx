import { Center, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '../api/types';
import { NotFoundPage } from '../pages/NotFoundPage';
import { useAuth } from './AuthContext';

/**
 * Gate for signed-in pages. Sends anonymous visitors to /login (and back afterwards),
 * forces a password change when the account has a temporary password, and hides
 * pages the role cannot use (the API enforces the same rules).
 */
export function RequireAuth({
  children,
  roles,
  allowPasswordChange = false,
}: {
  children: ReactNode;
  roles?: Role[];
  allowPasswordChange?: boolean;
}) {
  const { state, signedOutDeliberately } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (state.status === 'anonymous') {
    // Remember the page only when the session lapsed, so the same person returns to it.
    const from = signedOutDeliberately ? undefined : location.pathname + location.search;
    return <Navigate to="/login" replace state={from ? { from } : undefined} />;
  }
  if (state.me.user.mustChangePassword && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />;
  }
  if (roles && !roles.includes(state.me.user.role)) return <NotFoundPage />;
  return <>{children}</>;
}
