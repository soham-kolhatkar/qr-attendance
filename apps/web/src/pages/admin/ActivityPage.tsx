import { Anchor, Badge, Button, Code, Collapse, Group, Pagination, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, unwrap } from '../../api/client';
import type { AuditEntry } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { formatDateTime, ROLE_LABELS } from '../../lib/format';

const PAGE_SIZE = 50;

type Category = 'changes' | 'attendance' | 'people' | 'phones' | 'academic' | 'settings' | 'integrations' | 'security';
const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'changes', label: 'All changes' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'people', label: 'Students & staff' },
  { value: 'phones', label: 'Phones' },
  { value: 'academic', label: 'Classes & subjects' },
  { value: 'settings', label: 'Settings' },
  { value: 'integrations', label: 'API keys & webhooks' },
  { value: 'security', label: 'Sign-ins & passwords' },
];

/** The start of a local day, as the API wants it. */
const dayStart = (date: string, plusDays = 0) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + plusDays);
  return d.toISOString();
};

/**
 * Who did what, and when: every change to students, staff, classes, settings, phones and
 * attendance (including marks changed by hand and correction requests), plus sign-ins.
 */
export function ActivityPage() {
  const me = useMe();
  const platform = me.user.role === 'platform_admin';
  const [params, setParams] = useSearchParams();
  const actorId = params.get('actorId') ?? undefined;
  const entityType = params.get('entityType') ?? undefined;
  const entityId = params.get('entityId') ?? undefined;
  const [category, setCategory] = useState<Category>('changes');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [instituteId, setInstituteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [category, from, to, instituteId, actorId, entityId]);

  const institutes = useQuery({
    queryKey: ['platform', 'institutes', 'all'],
    queryFn: async () => unwrap(await api.GET('/v1/platform/institutes', { params: { query: { pageSize: 100 } } })),
    enabled: platform,
  });
  const log = useQuery({
    queryKey: ['audit', { category, from, to, instituteId, actorId, entityType, entityId, page }],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/audit/', {
          params: {
            query: {
              category,
              actorId,
              entityType,
              entityId,
              from: from ? dayStart(from) : undefined,
              to: to ? dayStart(to, 1) : undefined,
              instituteId: instituteId ?? undefined,
              page,
              pageSize: PAGE_SIZE,
            },
          },
        }),
      ),
  });
  const narrowed = actorId || entityId;
  const first = log.data?.items[0];
  const narrowedTo = actorId ? (first?.actor?.fullName ?? 'one person') : (first?.entity?.label ?? 'one item');

  return (
    <>
      <PageHeader
        title="Activity"
        description="Who changed what, and when. Entries can't be edited or deleted, by anyone."
      />
      <Group mb="md" wrap="wrap" align="flex-end">
        <Select
          label="Show"
          data={CATEGORIES}
          value={category}
          onChange={(v) => setCategory((v as Category) ?? 'changes')}
          allowDeselect={false}
          w={220}
        />
        <TextInput label="From" type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} w={160} />
        <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} w={160} />
        {platform && (
          <Select
            label="Institute"
            placeholder="All institutes"
            data={(institutes.data?.items ?? []).map((i) => ({ value: i.id, label: i.name }))}
            value={instituteId}
            onChange={setInstituteId}
            clearable
            searchable
            w={240}
          />
        )}
        {narrowed && (
          <Button variant="light" onClick={() => setParams({})}>
            Only {narrowedTo} · show everything
          </Button>
        )}
      </Group>

      <QueryState query={log}>
        {log.data?.items.length === 0 ? (
          <EmptyHint>Nothing recorded for these filters.</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={170}>When</Table.Th>
                    <Table.Th w={200}>Who</Table.Th>
                    <Table.Th>What</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {log.data?.items.map((e) => <Row key={e.id} entry={e} />)}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {log.data?.total.toLocaleString()} {log.data?.total === 1 ? 'entry' : 'entries'}
              </Text>
              <Pagination total={Math.ceil((log.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
    </>
  );
}

function Row({ entry: e }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!e.data || !!e.ip;
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm">{formatDateTime(e.createdAt)}</Text>
        {e.institute && (
          <Text size="xs" c="dimmed">
            {e.institute.name}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {e.actor ? (
          <>
            <Anchor component={Link} to={`/activity?actorId=${e.actor.id}`} size="sm" fw={500}>
              {e.actor.fullName}
            </Anchor>
            <Text size="xs" c="dimmed">
              {ROLE_LABELS[e.actor.role] ?? e.actor.role} · {e.actor.username}
            </Text>
          </>
        ) : (
          <Text size="sm" c="dimmed">
            System
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Stack gap={4} style={{ flex: 1 }}>
            <Text size="sm">
              {e.summary}
              {e.action === 'auth.login_failed' && (
                <Badge ml="xs" size="xs" color="orange" variant="light">
                  failed
                </Badge>
              )}
            </Text>
            {e.entity?.type === 'attendance_session' && (
              <Group gap="sm">
                <Anchor component={Link} to={`/sessions/${e.entity.id}`} size="xs">
                  Open session
                </Anchor>
                <Anchor component={Link} to={`/activity?entityType=attendance_session&entityId=${e.entity.id}`} size="xs">
                  Its history
                </Anchor>
              </Group>
            )}
            <Collapse expanded={open}>
              <Stack gap={4}>
                {e.ip && (
                  <Text size="xs" c="dimmed">
                    From {e.ip}
                  </Text>
                )}
                {e.data && (
                  <Code block fz="xs">
                    {JSON.stringify(e.data, null, 2)}
                  </Code>
                )}
              </Stack>
            </Collapse>
          </Stack>
          {hasDetails && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => setOpen((o) => !o)}
              rightSection={open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            >
              Details
            </Button>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
