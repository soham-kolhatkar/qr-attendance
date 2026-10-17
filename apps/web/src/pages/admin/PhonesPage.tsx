import {
  Badge,
  Button,
  Group,
  Modal,
  Pagination,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconSearch, IconShieldCheck, IconX } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useApiMutation } from '../../api/mutations';
import type { Device, DeviceStatus, ManagedDevice } from '../../api/types';
import { EmptyHint, PageHeader, QueryState, UnitSelect } from '../../components/common';
import { formatAgo, formatDate, formatDateTime } from '../../lib/format';

const PAGE_SIZE = 50;

/** Pending phone changes, for the menu badge. */
export function usePendingPhoneCount(enabled: boolean) {
  return useQuery({
    queryKey: ['devices', 'pending-count'],
    queryFn: async () => unwrap(await api.GET('/v1/devices/pending-count')).count,
    enabled,
    refetchInterval: 60_000,
  });
}

const VIEWS: { value: DeviceStatus; label: string }[] = [
  { value: 'pending', label: 'Requests' },
  { value: 'active', label: 'Linked' },
  { value: 'revoked', label: 'Replaced & unlinked' },
  { value: 'rejected', label: 'Turned down' },
];

const EMPTY: Record<DeviceStatus, string> = {
  pending: 'No requests waiting. Students who switch phones will appear here.',
  active: 'No phones linked yet. Students link their phone when they first sign in to the app.',
  revoked: 'No phones have been replaced or unlinked.',
  rejected: 'No requests have been turned down.',
};

export function PhonesPage() {
  const [status, setStatus] = useState<DeviceStatus>('pending');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ device: ManagedDevice; action: 'reject' | 'revoke' } | null>(null);
  useEffect(() => setPage(1), [status, q, unitId]);

  const pendingCount = usePendingPhoneCount(true);
  const list = useQuery({
    queryKey: ['devices', { status, q, unitId, page }],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/devices/', {
          params: { query: { status, q: q || undefined, unitId: unitId ?? undefined, page, pageSize: PAGE_SIZE } },
        }),
      ),
  });
  const approve = useApiMutation(
    async (d: ManagedDevice) => unwrap(await api.POST('/v1/devices/{id}/approve', { params: { path: { id: d.id } } })),
    { invalidate: [['devices']], success: 'Approved. The new phone works now; the old one has stopped working.' },
  );

  const views = VIEWS.map((v) =>
    v.value === 'pending' && pendingCount.data ? { ...v, label: `${v.label} (${pendingCount.data})` } : v,
  );

  return (
    <>
      <PageHeader
        title="Phones"
        description="Each student marks attendance from one phone, proven by a key locked inside that phone's hardware. When a student switches phones the request waits here; their old phone keeps working until you approve."
      />
      <Group mb="md" wrap="wrap">
        <SegmentedControl data={views} value={status} onChange={(v) => setStatus(v as DeviceStatus)} />
        <TextInput
          placeholder="Search name, username or roll no."
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          flex={1}
          miw={220}
        />
        <UnitSelect placeholder="All classes" value={unitId} onChange={setUnitId} w={260} />
      </Group>

      <QueryState query={list}>
        {list.data?.items.length === 0 ? (
          <EmptyHint>{q || unitId ? 'No phones match.' : EMPTY[status]}</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={860}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Student</Table.Th>
                    <Table.Th>{status === 'pending' ? 'New phone' : 'Phone'}</Table.Th>
                    {status === 'pending' && <Table.Th>Replaces</Table.Th>}
                    <Table.Th>{status === 'pending' ? 'Requested' : status === 'active' ? 'Linked' : 'Ended'}</Table.Th>
                    <Table.Th>{status === 'pending' || status === 'active' ? '' : 'Reason'}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data?.items.map((d) => (
                    <Table.Tr key={d.id}>
                      <Table.Td>
                        <Text fw={500} size="sm">
                          {d.student.fullName}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {d.student.username}
                          {d.student.rollNo && ` · Roll ${d.student.rollNo}`} · {d.student.unitPath.join(' › ')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <PhoneCell device={d} />
                      </Table.Td>
                      {status === 'pending' && (
                        <Table.Td>
                          {d.replaces ? (
                            <>
                              <Text size="sm">{d.replaces.model ?? 'Unknown phone'}</Text>
                              <Text size="xs" c="dimmed">
                                Linked {formatDate(d.replaces.activatedAt)}
                              </Text>
                            </>
                          ) : (
                            <Text size="sm" c="dimmed">
                              No phone linked now
                            </Text>
                          )}
                          <Text size="xs" c={d.history.phones >= 2 ? 'orange' : 'dimmed'}>
                            {d.history.phones === 0 ? 'First phone' : `${d.history.phones} phone${d.history.phones > 1 ? 's' : ''} before`}
                            {d.history.lastLinkedAt && `, last change ${formatAgo(d.history.lastLinkedAt)}`}
                          </Text>
                        </Table.Td>
                      )}
                      <Table.Td>
                        <Text size="sm">
                          {status === 'pending'
                            ? formatAgo(d.createdAt)
                            : formatDateTime(status === 'active' ? d.activatedAt : d.endedAt)}
                        </Text>
                        {status === 'active' && d.history.phones > 0 && (
                          <Text size="xs" c="dimmed">
                            {d.history.phones} phone{d.history.phones > 1 ? 's' : ''} before
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {status === 'pending' && (
                          <Group gap="xs" wrap="nowrap" justify="flex-end">
                            <Button
                              size="xs"
                              color="teal"
                              leftSection={<IconCheck size={14} />}
                              loading={approve.isPending && approve.variables?.id === d.id}
                              onClick={() => approve.mutate(d)}
                            >
                              Approve
                            </Button>
                            <Button
                              size="xs"
                              variant="default"
                              leftSection={<IconX size={14} />}
                              onClick={() => setActing({ device: d, action: 'reject' })}
                            >
                              Turn down
                            </Button>
                          </Group>
                        )}
                        {status === 'active' && (
                          <Group justify="flex-end">
                            <Button size="xs" variant="subtle" color="red" onClick={() => setActing({ device: d, action: 'revoke' })}>
                              Unlink
                            </Button>
                          </Group>
                        )}
                        {(status === 'revoked' || status === 'rejected') && <Text size="sm">{d.endReason ?? '—'}</Text>}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {list.data?.total} {list.data?.total === 1 ? 'phone' : 'phones'}
              </Text>
              <Pagination total={Math.ceil((list.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
      <ReasonModal acting={acting} onClose={() => setActing(null)} />
    </>
  );
}

/** Model, Android version and what the hardware said about the phone. */
function PhoneCell({ device }: { device: Device }) {
  const modified = device.bootState !== 'verified' || device.bootloaderLocked === false;
  return (
    <Stack gap={2}>
      <Text size="sm">{device.model ?? 'Unknown phone'}</Text>
      <Group gap={6}>
        <Text size="xs" c="dimmed">
          {device.platform === 'android' ? 'Android' : 'iOS'} {device.osVersion ?? ''}
          {device.appVersion && ` · app ${device.appVersion}`}
        </Text>
        {modified ? (
          <Tooltip
            multiline
            w={280}
            label="This phone's bootloader is unlocked or it isn't running its maker's software — it may be rooted. Its key is still in hardware, but be careful approving it."
          >
            <Badge size="xs" color="orange" variant="light" leftSection={<IconAlertTriangle size={10} />}>
              Modified phone
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip label={device.securityLevel === 'strongbox' ? 'Key held in a separate security chip' : "Key held in the phone's secure hardware"}>
            <Badge size="xs" color="teal" variant="light" leftSection={<IconShieldCheck size={10} />}>
              {device.securityLevel === 'strongbox' ? 'Security chip' : 'Secure hardware'}
            </Badge>
          </Tooltip>
        )}
      </Group>
    </Stack>
  );
}

function ReasonModal({
  acting,
  onClose,
}: {
  acting: { device: ManagedDevice; action: 'reject' | 'revoke' } | null;
  onClose: () => void;
}) {
  const form = useForm({
    initialValues: { reason: '' },
    validate: { reason: (v) => (v.trim().length >= 3 ? null : 'Give a short reason (at least 3 characters)') },
  });
  useEffect(() => {
    if (acting) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acting]);
  const reject = acting?.action === 'reject';
  const run = useApiMutation(
    async (reason: string) => {
      const params = { path: { id: acting!.device.id } };
      return unwrap(
        reject
          ? await api.POST('/v1/devices/{id}/reject', { params, body: { reason } })
          : await api.POST('/v1/devices/{id}/revoke', { params, body: { reason } }),
      );
    },
    { invalidate: [['devices']], success: reject ? 'Request turned down' : 'Phone unlinked' },
  );

  return (
    <Modal opened={!!acting} onClose={onClose} title={reject ? 'Turn down this phone?' : 'Unlink this phone?'}>
      {acting && (
        <form onSubmit={form.onSubmit((v) => run.mutate(v.reason.trim(), { onSuccess: onClose }))}>
          <Stack>
            <Text size="sm">
              {reject ? (
                <>
                  <b>{acting.device.student.fullName}</b> keeps using their current phone. The reason is recorded in
                  the audit log.
                </>
              ) : (
                <>
                  <b>{acting.device.student.fullName}</b>'s {acting.device.model ?? 'phone'} stops working for
                  attendance straight away. The next phone they sign in on is linked without needing approval — use
                  this for a lost, stolen or sold phone.
                </>
              )}
            </Text>
            <TextInput
              label="Reason"
              placeholder={reject ? 'e.g. Not your phone — see the office' : 'e.g. Phone lost, reported by student'}
              data-autofocus
              {...form.getInputProps('reason')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" color="red" loading={run.isPending}>
                {reject ? 'Turn down' : 'Unlink'}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
