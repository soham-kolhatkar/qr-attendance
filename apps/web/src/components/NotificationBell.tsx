import { ActionIcon, Button, Divider, Group, Indicator, Popover, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, unwrap } from '../api/client';
import type { NotificationItem, Role } from '../api/types';
import { formatAgo } from '../lib/format';

/** Where a notification leads on the web. */
function target(n: NotificationItem, role: Role): string {
  if (n.kind === 'summary.weekly') return '/reports';
  return role === 'student' ? '/profile' : '/';
}

/** The bell in the header: unread count, the latest notifications, and where each leads. */
export function NotificationBell({ role }: { role: Role }) {
  const [opened, setOpened] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: async () => unwrap(await api.GET('/v1/notifications/unread-count')).count,
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: async () => unwrap(await api.GET('/v1/notifications/', { params: { query: { limit: 30 } } })),
    enabled: opened,
  });
  const markRead = async (ids?: string[]) => {
    const { unread: left } = unwrap(await api.POST('/v1/notifications/read', { body: ids ? { ids } : {} }));
    queryClient.setQueryData(['notifications', 'unread'], left);
    await queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
  };
  const open = (n: NotificationItem) => {
    if (!n.read) void markRead([n.id]);
    setOpened(false);
    navigate(target(n, role));
  };
  const count = unread.data ?? 0;

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={380} shadow="md" withinPortal>
      <Popover.Target>
        <Tooltip label="Notifications" disabled={opened}>
          <Indicator label={count > 99 ? '99+' : count} size={16} disabled={count === 0} color="red" offset={4}>
            <ActionIcon variant="subtle" color="gray" onClick={() => setOpened((o) => !o)} aria-label={`Notifications, ${count} unread`}>
              <IconBell size={18} />
            </ActionIcon>
          </Indicator>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" px="md" py="xs">
          <Text fw={600}>Notifications</Text>
          {count > 0 && (
            <Button size="compact-xs" variant="subtle" onClick={() => void markRead()}>
              Mark all read
            </Button>
          )}
        </Group>
        <Divider />
        <ScrollArea.Autosize mah={440}>
          {list.data?.items.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" p="lg">
              Nothing yet. Changes to your attendance and reminders will show up here.
            </Text>
          )}
          {list.isPending && (
            <Text size="sm" c="dimmed" ta="center" p="lg">
              Loading…
            </Text>
          )}
          <Stack gap={0}>
            {list.data?.items.map((n) => (
              <UnstyledButton
                key={n.id}
                onClick={() => open(n)}
                px="md"
                py="sm"
                style={{
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                  background: n.read ? undefined : 'var(--mantine-color-indigo-light)',
                }}
              >
                <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                  <Text size="sm" fw={n.read ? 500 : 700}>
                    {n.title}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {formatAgo(n.createdAt)}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" lineClamp={4} style={{ whiteSpace: 'pre-line' }}>
                  {n.body}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
