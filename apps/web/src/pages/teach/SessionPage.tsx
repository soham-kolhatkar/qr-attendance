import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Grid,
  Group,
  Menu,
  Modal,
  RingProgress,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import {
  IconBan,
  IconClockPlus,
  IconDeviceDesktop,
  IconHandStop,
  IconPlayerStop,
  IconQrcode,
  IconSearch,
  IconWifi,
  IconWifiOff,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { api, unwrap } from '../../api/client';
import { useApiMutation } from '../../api/mutations';
import type { AttendanceStatus, LiveEvent, Session, SessionRecord } from '../../api/types';
import { PageHeader, QueryState } from '../../components/common';
import { CorrectionList } from '../../components/corrections';
import { openFormModal } from '../../components/FormModal';
import { formatCountdown, formatDateTime, formatTime, KIND_LABELS, percent, STATUS_COLORS } from '../../lib/format';
import { useLiveSession } from '../../lib/live';

type FeedItem = { key: string; name: string; rollNo: string | null; status: AttendanceStatus; method: 'qr' | 'manual'; at: number };

export function SessionPage() {
  const { id } = useParams() as { id: string };
  const queryClient = useQueryClient();
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const session = useQuery({
    queryKey: ['session', id],
    queryFn: async () => unwrap(await api.GET('/v1/sessions/{id}', { params: { path: { id } } })),
  });
  const records = useQuery({
    queryKey: ['session', id, 'records'],
    queryFn: async () => unwrap(await api.GET('/v1/sessions/{id}/records', { params: { path: { id } } })),
  });

  // Keep both queries current from the live stream instead of polling.
  const live = useLiveSession(id, {
    onSnapshot: (s) => {
      queryClient.setQueryData(['session', id], s);
      void queryClient.invalidateQueries({ queryKey: ['session', id, 'records'] });
    },
    onEvent: (e: LiveEvent) => {
      if (e.type === 'marked') {
        queryClient.setQueryData<Session>(['session', id], (s) => (s ? { ...s, counts: e.counts } : s));
        queryClient.setQueryData<SessionRecord[]>(['session', id, 'records'], (rows) =>
          rows?.map((r) =>
            r.studentId === e.student.id ? { ...r, status: e.status, method: e.method, markedAt: new Date().toISOString() } : r,
          ),
        );
        setFeed((f) =>
          [{ key: `${e.student.id}-${Date.now()}`, name: e.student.fullName, rollNo: e.student.rollNo, status: e.status, method: e.method, at: Date.now() }, ...f].slice(0, 8),
        );
      } else {
        queryClient.setQueryData<Session>(['session', id], (s) => (s ? { ...s, status: e.status, closesAt: e.closesAt } : s));
      }
    },
  });

  return (
    <QueryState query={session}>
      {session.data && (
        <SessionView session={session.data} records={records.data} recordsQuery={records} feed={feed} live={live} />
      )}
    </QueryState>
  );
}

function SessionView({
  session,
  records,
  recordsQuery,
  feed,
  live,
}: {
  session: Session;
  records: SessionRecord[] | undefined;
  recordsQuery: Parameters<typeof QueryState>[0]['query'];
  feed: FeedItem[];
  live: 'connecting' | 'live' | 'reconnecting';
}) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), 1000, { autoInvoke: true });
  const refresh = [['session', session.id], ['sessions']];
  const action = (path: '/v1/sessions/{id}/close' | '/v1/sessions/{id}/extend' | '/v1/sessions/{id}/cancel', body?: object) =>
    api.POST(path, { params: { path: { id: session.id } }, body: body as never }).then(unwrap);

  const close = useApiMutation(() => action('/v1/sessions/{id}/close'), { invalidate: refresh, success: 'Scanning closed' });
  const extend = useApiMutation((minutes: number) => action('/v1/sessions/{id}/extend', { minutes }), {
    invalidate: refresh,
    success: 'Scanning extended',
  });
  const cancel = useApiMutation((reason: string) => action('/v1/sessions/{id}/cancel', { reason }), {
    invalidate: refresh,
    success: 'Session cancelled',
  });

  const { counts } = session;
  const isOpen = session.status === 'open' && new Date(session.closesAt).getTime() > now;
  const statusLabel = session.status === 'cancelled' ? 'Cancelled' : isOpen ? 'Scanning open' : 'Closed';

  return (
    <>
      <PageHeader
        title={`${session.offering.subject.code} · ${session.offering.subject.name}`}
        description={
          <>
            {KIND_LABELS[session.kind]}
            {session.topic && ` · ${session.topic}`} · started {formatDateTime(session.startedAt)} by {session.createdBy.fullName}
          </>
        }
        actions={
          <>
            <Badge size="lg" variant="light" color={isOpen ? 'teal' : session.status === 'cancelled' ? 'red' : 'gray'}>
              {statusLabel}
            </Badge>
            <Tooltip label={live === 'live' ? 'Live updates on' : 'Reconnecting…'}>
              <Badge size="lg" variant="outline" color={live === 'live' ? 'teal' : 'orange'} leftSection={live === 'live' ? <IconWifi size={14} /> : <IconWifiOff size={14} />}>
                {live === 'live' ? 'Live' : 'Offline'}
              </Badge>
            </Tooltip>
          </>
        }
      />
      {session.status === 'cancelled' && (
        <Alert color="red" mb="md" title="This session was cancelled">
          {session.cancelReason} It is left out of attendance reports.
        </Alert>
      )}

      <Grid gap="md" mb="md">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card withBorder padding="lg" h="100%">
            <Group wrap="nowrap" align="center">
              <RingProgress
                size={140}
                thickness={14}
                roundCaps
                sections={[
                  { value: percent(counts.present, counts.total), color: 'teal' },
                  { value: percent(counts.excused, counts.total), color: 'yellow' },
                ].filter((section) => section.value > 0)}
                label={
                  <Text ta="center" fw={700} fz={22}>
                    {percent(counts.present, counts.total)}%
                  </Text>
                }
              />
              <Stack gap={4}>
                <Text fz={36} fw={800} lh={1}>
                  {counts.present}
                  <Text span c="dimmed" fz={20} fw={500}>
                    {' '}
                    / {counts.total}
                  </Text>
                </Text>
                <Text size="sm" c="dimmed">
                  present
                </Text>
                <Group gap="xs">
                  <Badge color="red" variant="light">
                    {counts.absent} absent
                  </Badge>
                  {counts.excused > 0 && (
                    <Badge color="yellow" variant="light">
                      {counts.excused} excused
                    </Badge>
                  )}
                </Group>
              </Stack>
            </Group>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card withBorder padding="lg" h="100%">
            <Stack gap="sm">
              {isOpen ? (
                <Text size="sm">
                  Scanning closes in <b>{formatCountdown(new Date(session.closesAt).getTime() - now)}</b> (at {formatTime(session.closesAt)}).
                </Text>
              ) : (
                session.status !== 'cancelled' && (
                  <Text size="sm" c="dimmed">
                    Scanning closed at {formatTime(session.closedAt ?? session.closesAt)}. You can still correct attendance below.
                  </Text>
                )
              )}
              <Group gap="xs">
                {isOpen && (
                  <Button
                    component="a"
                    href={`/sessions/${session.id}/projector`}
                    target="_blank"
                    leftSection={<IconDeviceDesktop size={16} />}
                    size="md"
                  >
                    Show QR on projector
                  </Button>
                )}
                {isOpen && (
                  <Button variant="light" color="gray" leftSection={<IconPlayerStop size={16} />} loading={close.isPending} onClick={() => close.mutate()}>
                    Close scanning
                  </Button>
                )}
                {session.status !== 'cancelled' && (
                  <Menu>
                    <Menu.Target>
                      <Button variant="light" color="gray" leftSection={<IconClockPlus size={16} />} loading={extend.isPending}>
                        {isOpen ? 'More time' : 'Re-open'}
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {[2, 5, 10, 15].map((m) => (
                        <Menu.Item key={m} onClick={() => extend.mutate(m)}>
                          {m} minutes
                        </Menu.Item>
                      ))}
                    </Menu.Dropdown>
                  </Menu>
                )}
                {session.status !== 'cancelled' && (
                  <Button
                    variant="subtle"
                    color="red"
                    leftSection={<IconBan size={16} />}
                    onClick={() =>
                      openFormModal({
                        title: 'Cancel this session?',
                        fields: [{ name: 'reason', label: 'Reason', placeholder: 'e.g. Started for the wrong class' }],
                        submitLabel: 'Cancel session',
                        onSubmit: (v) => cancel.mutateAsync(v.reason!),
                      })
                    }
                  >
                    Cancel session
                  </Button>
                )}
              </Group>
              <Stack gap={4}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Latest
                </Text>
                {feed.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {isOpen ? 'Waiting for the first scan…' : 'No recent activity.'}
                  </Text>
                ) : (
                  feed.map((f) => (
                    <Group key={f.key} gap="xs" wrap="nowrap">
                      {f.method === 'qr' ? <IconQrcode size={14} /> : <IconHandStop size={14} />}
                      <Text size="sm" truncate>
                        {f.rollNo ? `${f.rollNo} · ` : ''}
                        {f.name}
                      </Text>
                      <Badge size="xs" color={STATUS_COLORS[f.status]} variant="light">
                        {f.status}
                      </Badge>
                    </Group>
                  ))
                )}
              </Stack>
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <SessionRequests sessionId={session.id} />
      <QueryState query={recordsQuery}>
        {records && <RecordsTable session={session} records={records} />}
      </QueryState>
    </>
  );
}

/** Students of this class asking for their mark to be corrected. */
function SessionRequests({ sessionId }: { sessionId: string }) {
  const pending = useQuery({
    queryKey: ['corrections', { status: 'pending', sessionId }],
    queryFn: async () =>
      unwrap(await api.GET('/v1/corrections/', { params: { query: { status: 'pending', sessionId, pageSize: 50 } } })),
  });
  const items = pending.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card withBorder padding="lg" mb="md">
      <Title order={4} mb={4}>
        Correction requests
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        {items.length === 1 ? 'A student asks' : `${items.length} students ask`} for their mark in this class to be changed.
      </Text>
      <CorrectionList items={items} showSession={false} />
    </Card>
  );
}

const REASONS = ['No phone', 'Phone not working', 'Medical leave', 'On duty', 'Left early', 'Proxy attempt'];

function RecordsTable({ session, records }: { session: Session; records: SessionRecord[] }) {
  const [filter, setFilter] = useState<'all' | AttendanceStatus>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState<AttendanceStatus | null>(null);
  const editable = session.status !== 'cancelled';

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter(
      (r) =>
        (filter === 'all' || r.status === filter) &&
        (!q || r.fullName.toLowerCase().includes(q) || r.username.includes(q) || (r.rollNo ?? '').toLowerCase() === q),
    );
  }, [records, filter, search]);

  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.studentId));

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md" wrap="wrap">
        <Title order={4}>Class list</Title>
        <Group gap="xs" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            data={[
              { value: 'all', label: `All ${records.length}` },
              { value: 'present', label: `Present ${session.counts.present}` },
              { value: 'absent', label: `Absent ${session.counts.absent}` },
              { value: 'excused', label: `Excused ${session.counts.excused}` },
            ]}
          />
          <TextInput size="xs" placeholder="Search" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        </Group>
      </Group>

      {editable && selected.size > 0 && (
        <Group mb="sm" p="xs" bg="var(--mantine-color-default-hover)" style={{ borderRadius: 8 }}>
          <Text size="sm" fw={500}>
            {selected.size} selected — mark as
          </Text>
          <Button size="xs" color="teal" onClick={() => setMarking('present')}>
            Present
          </Button>
          <Button size="xs" color="red" onClick={() => setMarking('absent')}>
            Absent
          </Button>
          <Button size="xs" color="yellow" onClick={() => setMarking('excused')}>
            Excused
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </Group>
      )}

      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {editable && (
                <Table.Th w={36}>
                  <Checkbox
                    aria-label="Select all shown"
                    checked={allShownSelected}
                    indeterminate={!allShownSelected && rows.some((r) => selected.has(r.studentId))}
                    onChange={() =>
                      setSelected(allShownSelected ? new Set() : new Set([...selected, ...rows.map((r) => r.studentId)]))
                    }
                  />
                </Table.Th>
              )}
              <Table.Th w={60}>Roll</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Class</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>How</Table.Th>
              <Table.Th>Time</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.studentId}>
                {editable && (
                  <Table.Td>
                    <Checkbox
                      aria-label={`Select ${r.fullName}`}
                      checked={selected.has(r.studentId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.currentTarget.checked) next.add(r.studentId);
                        else next.delete(r.studentId);
                        setSelected(next);
                      }}
                    />
                  </Table.Td>
                )}
                <Table.Td>{r.rollNo ?? '—'}</Table.Td>
                <Table.Td fw={500}>{r.fullName}</Table.Td>
                <Table.Td c="dimmed">{r.unitPath.at(-1)}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLORS[r.status]} variant="light">
                    {r.status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {r.method === 'qr' && (
                    <Tooltip label="Scanned the QR code">
                      <ActionIcon variant="transparent" color="gray" size="sm">
                        <IconQrcode size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {r.method === 'manual' && (
                    <Tooltip label={`Marked by hand: ${r.reason ?? ''}`}>
                      <Group gap={4} wrap="nowrap">
                        <IconHandStop size={16} />
                        <Text size="xs" c="dimmed" truncate maw={160}>
                          {r.reason}
                        </Text>
                      </Group>
                    </Tooltip>
                  )}
                </Table.Td>
                <Table.Td c="dimmed">{r.markedAt ? formatTime(r.markedAt) : ''}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <MarkModal
        sessionId={session.id}
        status={marking}
        studentIds={[...selected]}
        onClose={() => setMarking(null)}
        onDone={() => {
          setMarking(null);
          setSelected(new Set());
        }}
      />
    </Card>
  );
}

function MarkModal({
  sessionId,
  status,
  studentIds,
  onClose,
  onDone,
}: {
  sessionId: string;
  status: AttendanceStatus | null;
  studentIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  // Keep the title steady while the dialog animates closed after the selection clears.
  const shown = useRef({ status, count: studentIds.length });
  if (status) shown.current = { status, count: studentIds.length };
  const mark = useApiMutation(
    async () =>
      unwrap(
        await api.POST('/v1/sessions/{id}/mark', {
          params: { path: { id: sessionId } },
          body: { studentIds, status: status!, reason: reason.trim() },
        }),
      ),
    { invalidate: [['session', sessionId]], success: (r) => `Updated ${r.updated} student${r.updated === 1 ? '' : 's'}` },
  );
  return (
    <Modal opened={!!status} onClose={onClose} title={`Mark ${shown.current.count} as ${shown.current.status}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          A reason is required and is kept with the record, so everyone can see why it was changed. Students cannot override
          it by scanning.
        </Text>
        <Chip.Group value={REASONS.includes(reason) ? reason : ''} onChange={(v) => setReason(v as string)}>
          <Group gap={6}>
            {REASONS.map((r) => (
              <Chip key={r} value={r} size="sm">
                {r}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} data-autofocus />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color={shown.current.status ? STATUS_COLORS[shown.current.status] : undefined}
            disabled={reason.trim().length < 3}
            loading={mark.isPending}
            onClick={() => mark.mutate(undefined, { onSuccess: () => { setReason(''); onDone(); } })}
          >
            Mark {shown.current.status}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
