import { createBrowserRouter } from 'react-router';
import type { Role } from './api/types';
import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './components/AppLayout';
import { ActivityPage } from './pages/admin/ActivityPage';
import { CatalogPage } from './pages/admin/CatalogPage';
import { GroupsPage } from './pages/admin/GroupsPage';
import { ImportPage } from './pages/admin/ImportPage';
import { OfferingsPage } from './pages/admin/OfferingsPage';
import { PhonesPage } from './pages/admin/PhonesPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { StaffPage } from './pages/admin/StaffPage';
import { StructurePage } from './pages/admin/StructurePage';
import { StudentsPage } from './pages/admin/StudentsPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { CorrectionsPage } from './pages/corrections/CorrectionsPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { InstitutesPage } from './pages/platform/InstitutesPage';
import { RegisterPage } from './pages/reports/RegisterPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { ProfilePage } from './pages/student/ProfilePage';
import { MyClassesPage } from './pages/teach/MyClassesPage';
import { ProjectorPage } from './pages/teach/ProjectorPage';
import { SessionPage } from './pages/teach/SessionPage';
import { SessionsPage } from './pages/teach/SessionsPage';

const ADMIN: Role[] = ['admin'];
const MANAGERS: Role[] = ['admin', 'hod'];
const STAFF: Role[] = ['admin', 'hod', 'faculty'];

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth allowPasswordChange>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    // Full-screen, no navigation: this is what the projector shows.
    path: '/sessions/:id/projector',
    element: (
      <RequireAuth roles={STAFF}>
        <ProjectorPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: 'structure', element: <RequireAuth roles={ADMIN}><StructurePage /></RequireAuth> },
      { path: 'groups', element: <RequireAuth roles={MANAGERS}><GroupsPage /></RequireAuth> },
      { path: 'students', element: <RequireAuth roles={MANAGERS}><StudentsPage /></RequireAuth> },
      { path: 'phones', element: <RequireAuth roles={MANAGERS}><PhonesPage /></RequireAuth> },
      { path: 'staff', element: <RequireAuth roles={ADMIN}><StaffPage /></RequireAuth> },
      { path: 'import', element: <RequireAuth roles={ADMIN}><ImportPage /></RequireAuth> },
      { path: 'catalog', element: <RequireAuth roles={MANAGERS}><CatalogPage /></RequireAuth> },
      { path: 'offerings', element: <RequireAuth roles={MANAGERS}><OfferingsPage /></RequireAuth> },
      { path: 'settings', element: <RequireAuth roles={ADMIN}><SettingsPage /></RequireAuth> },
      { path: 'activity', element: <RequireAuth roles={['admin', 'platform_admin']}><ActivityPage /></RequireAuth> },
      { path: 'corrections', element: <RequireAuth roles={STAFF}><CorrectionsPage /></RequireAuth> },
      { path: 'classes', element: <RequireAuth roles={STAFF}><MyClassesPage /></RequireAuth> },
      { path: 'sessions', element: <RequireAuth roles={STAFF}><SessionsPage /></RequireAuth> },
      { path: 'sessions/:id', element: <RequireAuth roles={STAFF}><SessionPage /></RequireAuth> },
      { path: 'reports', element: <RequireAuth roles={STAFF}><ReportsPage /></RequireAuth> },
      { path: 'reports/offerings/:id', element: <RequireAuth roles={STAFF}><RegisterPage /></RequireAuth> },
      { path: 'platform/institutes', element: <RequireAuth roles={['platform_admin']}><InstitutesPage /></RequireAuth> },
      { path: 'profile', element: <ProfilePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
