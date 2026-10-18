import { Alert, Badge, Card, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api/client';
import type { SystemStatus } from '../../api/types';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { formatAgo, formatDateTime } from '../../lib/format';

const LOOP_NAMES: Record<string, string> = {
  sweeper: 'Closing sessions, report totals, notifications, scheduled reminders',
  webhooks: 'Webhook deliveries',
};

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/** For the platform owner: is the server healthy, how full is it, what went wrong lately. */
export function SystemPage() {
  const status = useQuery({
    queryKey: ['platform', 'system'],
    queryFn: async () => unwrap(await api.GET('/v1/platform/system/')),
    refetchInterval: 30_000,
  });
  const s = status.data;
  return (
    <>
      <PageHeader
        title="System"
        description="How the server is doing. It refreshes every 30 seconds. Problems are also emailed to the addresses in ALERT_EMAIL (at most once an hour)."
      />
      <QueryState query={status}>{s && <SystemView s={s} />}</QueryState>
    </>
  );
}

function SystemView({ s }: { s: SystemStatus }) {
  const stalled = s.loops.filter((l) => l.stalled);
  const healthy = s.database.ok && stalled.length === 0;
  return (
    <Stack>
      <Alert color={healthy ? 'teal' : 'red'} icon={healthy ? <IconCircleCheck /> : <IconAlertTriangle />} title={healthy ? 'Everything is running' : 'Something needs attention'}>
        {!s.database.ok && <Text size="sm">The database can’t be reached: {s.database.error}</Text>}
        {stalled.map((l) => (
          <Text size="sm" key={l.name}>
            Background work has stopped: {LOOP_NAMES[l.name] ?? l.name}
            {l.lastError ? ` (last error: ${l.lastError})` : ''}.
          </Text>
        ))}
        {healthy && (
          <Text size="sm">
            Version {s.version}, running for {duration(s.uptimeSeconds)}.
          </Text>
        )}
      </Alert>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Stat label="Database" value={s.database.ok ? `${s.database.sizeMb} MB` : 'Down'} hint={s.database.ok ? `answers in ${s.database.latencyMs} ms` : undefined} warn={!s.database.ok} />
        <Stat label="Memory in use" value={`${s.runtime.rssMb} MB`} hint={`Node ${s.runtime.node}`} />
        <Stat label="Institutes" value={String(s.totals?.institutes ?? '—')} hint={s.totals ? `${s.totals.activeUsers.toLocaleString()} active accounts` : undefined} />
        <Stat label="Sessions, past day" value={String(s.totals?.sessionsLastDay ?? '—')} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder padding="lg">
          <Text fw={600} mb="xs">
            Background work
          </Text>
          <Stack gap="xs">
            {s.loops.length === 0 && (
              <Text size="sm" c="dimmed">
                Not running on this server.
              </Text>
            )}
            {s.loops.map((l) => (
              <Group key={l.name} justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm">{LOOP_NAMES[l.name] ?? l.name}</Text>
                  <Text size="xs" c="dimmed">
                    Every {l.everySeconds} s or sooner · last done {l.lastOkAt ? formatAgo(l.lastOkAt) : 'not yet'}
                    {l.lastError && ` · last error ${formatAgo(l.lastErrorAt)}: ${l.lastError}`}
                  </Text>
                </div>
                <Badge color={l.stalled ? 'red' : 'teal'} variant="light" style={{ flexShrink: 0 }}>
                  {l.stalled ? 'Stalled' : 'Running'}
                </Badge>
              </Group>
            ))}
          </Stack>
        </Card>
        <Card withBorder padding="lg">
          <Text fw={600} mb="xs">
            Waiting to go out
          </Text>
          {s.backlog ? (
            <Table withRowBorders={false} verticalSpacing={4}>
              <Table.Tbody>
                <Row label="Emails and phone notifications" value={s.backlog.notifications} />
                <Row label="Webhook deliveries (with retries)" value={s.backlog.webhooks} note={s.backlog.oldestWebhookAt ? `oldest ${formatAgo(s.backlog.oldestWebhookAt)}` : undefined} />
                <Row label="Classes waiting for report totals" value={s.backlog.staleOfferings} />
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed">
              Unknown while the database is down.
            </Text>
          )}
          <Group gap="xs" mt="sm">
            <Channel on={s.channels.email} label="Email" />
            <Channel on={s.channels.push} label="Phone notifications" />
            <Channel on={s.channels.alertEmails} label="Alert emails to you" />
          </Group>
        </Card>
      </SimpleGrid>

      <Card withBorder padding="lg">
        <Text fw={600} mb="xs">
          Recent server errors (since this server started)
        </Text>
        {s.errors.length === 0 ? (
          <EmptyHint>None.</EmptyHint>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing={6}>
              <Table.Tbody>
                {s.errors.map((e, i) => (
                  <Table.Tr key={`${e.at}-${i}`}>
                    <Table.Td w={190}>
                      <Text size="sm">{formatDateTime(e.at)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {e.where}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>
                        {e.message}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text fz={26} fw={700} c={warn ? 'red' : undefined}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

function Row({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm">{label}</Text>
        {note && (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm" fw={600}>
          {value.toLocaleString()}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

function Channel({ on, label }: { on: boolean; label: string }) {
  return (
    <Badge variant="light" color={on ? 'teal' : 'gray'}>
      {label}: {on ? 'set up' : 'off'}
    </Badge>
  );
}
