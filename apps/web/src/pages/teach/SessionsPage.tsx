import { Badge, Group, Pagination, Progress, SegmentedControl, Switch, Table, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, unwrap } from '../../api/client';
import { useMe } from '../../auth/AuthContext';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { formatDateTime, KIND_LABELS, percent } from '../../lib/format';

const PAGE_SIZE = 30;

export function SessionsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | 'open' | 'closed' | 'cancelled'>('all');
  const [mine, setMine] = useState(me.user.role === 'faculty');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status, mine]);

  const sessions = useQuery({
    queryKey: ['sessions', { status, mine, page }],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/sessions/', {
          params: {
            query: {
              status: status === 'all' ? undefined : status,
              mine: mine ? 'true' : undefined,
              page,
              pageSize: PAGE_SIZE,
            },
          },
        }),
      ),
  });

  return (
    <>
      <PageHeader title="Sessions" description="Every attendance session, newest first. Open one to see or correct who was present." />
      <Group mb="md">
        <SegmentedControl
          value={status}
          onChange={(v) => setStatus(v as typeof status)}
          data={[
            { value: 'all', label: 'All' },
            { value: 'open', label: 'Running' },
            { value: 'closed', label: 'Closed' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
        {me.user.role !== 'faculty' && <Switch label="Only sessions I started" checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} />}
      </Group>
      <QueryState query={sessions}>
        {sessions.data?.items.length === 0 ? (
          <EmptyHint>No sessions yet.</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={760}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>When</Table.Th>
                    <Table.Th>Subject</Table.Th>
                    <Table.Th>Kind</Table.Th>
                    <Table.Th>Teacher</Table.Th>
                    <Table.Th w={200}>Present</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sessions.data?.items.map((s) => (
                    <Table.Tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/sessions/${s.id}`)}>
                      <Table.Td>{formatDateTime(s.startedAt)}</Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {s.offering.subject.code}
                        </Text>
                        <Text size="xs" c="dimmed" truncate maw={260}>
                          {s.topic ?? s.offering.subject.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>{KIND_LABELS[s.kind]}</Table.Td>
                      <Table.Td>{s.createdBy.fullName}</Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Progress value={percent(s.counts.present, s.counts.total)} w={90} color="teal" />
                          <Text size="sm">
                            {s.counts.present}/{s.counts.total}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={s.status === 'open' ? 'teal' : s.status === 'cancelled' ? 'red' : 'gray'}>
                          {s.status === 'open' ? 'running' : s.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="flex-end" mt="md">
              <Pagination total={Math.ceil((sessions.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
    </>
  );
}
