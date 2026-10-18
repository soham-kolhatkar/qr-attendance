import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Group,
  Menu,
  NavLink as MantineNavLink,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBooks,
  IconBuildingCommunity,
  IconCalendarEvent,
  IconChalkboard,
  IconChartBar,
  IconDeviceMobile,
  IconFileImport,
  IconHistory,
  IconMessageCheck,
  IconPlugConnected,
  IconHierarchy2,
  IconHome,
  IconId,
  IconKey,
  IconLogout,
  IconMoon,
  IconNotebook,
  IconSchool,
  IconSettings,
  IconSun,
  IconUser,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Role } from '../api/types';
import { useAuth, useMe } from '../auth/AuthContext';
import { ROLE_LABELS } from '../lib/format';
import { usePendingPhoneCount } from '../pages/admin/PhonesPage';
import { usePendingCorrectionCount } from './corrections';
import { Logo } from './Logo';
import { NotificationBell } from './NotificationBell';

type NavItem = { to: string; label: string; icon: Icon; roles: Role[] };

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: IconHome, roles: ['admin'] },
  { to: '/platform/institutes', label: 'Institutes', icon: IconBuildingCommunity, roles: ['platform_admin'] },
  { to: '/classes', label: 'My classes', icon: IconChalkboard, roles: ['admin', 'hod', 'faculty'] },
  { to: '/sessions', label: 'Sessions', icon: IconCalendarEvent, roles: ['admin', 'hod', 'faculty'] },
  { to: '/corrections', label: 'Corrections', icon: IconMessageCheck, roles: ['admin', 'hod', 'faculty'] },
  { to: '/reports', label: 'Reports', icon: IconChartBar, roles: ['admin', 'hod', 'faculty'] },
  { to: '/students', label: 'Students', icon: IconSchool, roles: ['admin', 'hod'] },
  { to: '/phones', label: 'Phones', icon: IconDeviceMobile, roles: ['admin', 'hod'] },
  { to: '/groups', label: 'Batches & groups', icon: IconUsersGroup, roles: ['admin', 'hod'] },
  { to: '/offerings', label: 'Offerings', icon: IconBooks, roles: ['admin', 'hod'] },
  { to: '/catalog', label: 'Terms & subjects', icon: IconNotebook, roles: ['admin', 'hod'] },
  { to: '/staff', label: 'Staff', icon: IconId, roles: ['admin'] },
  { to: '/structure', label: 'Structure', icon: IconHierarchy2, roles: ['admin'] },
  { to: '/import', label: 'Import', icon: IconFileImport, roles: ['admin'] },
  { to: '/integrations', label: 'Integrations', icon: IconPlugConnected, roles: ['admin'] },
  { to: '/activity', label: 'Activity', icon: IconHistory, roles: ['admin', 'platform_admin'] },
  { to: '/settings', label: 'Settings', icon: IconSettings, roles: ['admin'] },
  { to: '/profile', label: 'My profile', icon: IconUser, roles: ['student'] },
];

export function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure();
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const items = NAV.filter((n) => n.roles.includes(me.user.role));
  const pendingPhones = usePendingPhoneCount(me.user.role === 'admin' || me.user.role === 'hod');
  const pendingCorrections = usePendingCorrectionCount(['admin', 'hod', 'faculty'].includes(me.user.role));
  const badges: Record<string, number | undefined> = { '/phones': pendingPhones.data, '/corrections': pendingCorrections.data };

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Logo />
            {me.institute && (
              <Text c="dimmed" size="sm" visibleFrom="xs" truncate>
                {me.institute.name}
              </Text>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {me.user.role !== 'platform_admin' && <NotificationBell role={me.user.role} />}
            <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
                aria-label="Toggle colour scheme"
              >
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end" width={220}>
              <Menu.Target>
                <UnstyledButton aria-label="Account menu">
                  <Group gap="xs" wrap="nowrap">
                    <Avatar size="sm" color="indigo" name={me.user.fullName} />
                    <div style={{ lineHeight: 1.1 }}>
                      <Text size="sm" fw={500} visibleFrom="sm">
                        {me.user.fullName}
                      </Text>
                      <Text size="xs" c="dimmed" visibleFrom="sm">
                        {ROLE_LABELS[me.user.role]}
                      </Text>
                    </div>
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{me.user.username}</Menu.Label>
                <Menu.Item leftSection={<IconKey size={16} />} onClick={() => navigate('/change-password')}>
                  Change password
                </Menu.Item>
                <Menu.Item leftSection={<IconLogout size={16} />} color="red" onClick={() => void logout()}>
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <ScrollArea>
          {items.map((item) => (
            <MantineNavLink
              key={item.to}
              component={NavLink}
              to={item.to}
              end={item.to === '/'}
              label={item.label}
              leftSection={<item.icon size={18} stroke={1.6} />}
              rightSection={
                badges[item.to] ? (
                  <Badge size="sm" circle color="orange" aria-label={`${badges[item.to]} waiting`}>
                    {badges[item.to]}
                  </Badge>
                ) : undefined
              }
              active={item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)}
              onClick={close}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
