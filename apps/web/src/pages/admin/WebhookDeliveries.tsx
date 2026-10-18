import { Badge, Button, Code, Collapse, Drawer, Group, Pagination, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useApiMutation } from '../../api/mutations';
import type { WebhookDelivery, WebhookEndpoint } from '../../api/types';
import { EmptyHint, QueryState } from '../../components/common';
import { formatAgo, formatDateTime } from '../../lib/format';

const PAGE_SIZE = 25;
type Filter = 'all' | WebhookDelivery['status'];
const STATUS = {
  succeeded: { label: 'Delivered', color: 'teal' },
  pending: { label: 'Waiting', color: 'blue' },
  failed: { label: 'Failed', color: 'red' },
} as const;

/** What was sent to one webhook and how it went (kept for 30 days), with retries for failures. */
export function DeliveriesDrawer({ endpoint, onClose }: { endpoint: WebhookEndpoint | null; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setPage(1), [filter, endpoint?.id]);
  const list = useQuery({
    queryKey: ['webhooks', endpoint?.id, 'deliveries', { filter, page }],
    enabled: !!endpoint,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/webhooks/{id}/deliveries', {
          params: { path: { id: endpoint!.id }, query: { status: filter === 'all' ? undefined : filter, page, pageSize: PAGE_SIZE } },
        }),
      ),
  });
  const retryAll = useApiMutation(
    async () => unwrap(await api.POST('/v1/webhooks/{id}/deliveries/retry', { params: { path: { id: endpoint!.id } } })),
    { invalidate: [['webhooks']], success: (r) => (r.queued ? `${r.queued} failed deliveries will be sent again.` : 'Nothing failed in the past week.') },
  );
  const retryOne = useApiMutation(
    async (d: WebhookDelivery) =>
      unwrap(await api.POST('/v1/webhooks/{id}/deliveries/{deliveryId}/retry', { params: { path: { id: endpoint!.id, deliveryId: d.id } } })),
    { invalidate: [['webhooks']], success: 'It will be sent again in a moment.' },
  );

  return (
    <Drawer opened={!!endpoint} onClose={onClose} position="right" size="xl" title={endpoint ? `Deliveries to ${endpoint.url}` : ''}>
      <Group justify="space-between" mb="md">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'all', label: 'All' },
            { value: 'failed', label: 'Failed' },
            { value: 'pending', label: 'Waiting' },
            { value: 'succeeded', label: 'Delivered' },
          ]}
        />
        <Button size="xs" variant="light" disabled={!endpoint?.enabled} loading={retryAll.isPending} onClick={() => retryAll.mutate()}>
          Send failed ones again
        </Button>
      </Group>
      <QueryState query={list}>
        {list.data?.items.length === 0 ? (
          <EmptyHint>Nothing here yet.</EmptyHint>
        ) : (
          <>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Answer</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.data?.items.map((d) => (
                  <Table.Tr key={d.id} style={{ verticalAlign: 'top' }}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {d.eventType}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatDateTime(d.createdAt)}
                      </Text>
                      <Collapse expanded={open === d.id}>
                        <Code block fz="xs" mt={4} maw={420}>
                          {JSON.stringify(d.payload, null, 2)}
                        </Code>
                      </Collapse>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={STATUS[d.status].color}>
                        {STATUS[d.status].label}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}
                        {d.nextAttemptAt && ` · next ${formatAgo(d.nextAttemptAt)}`}
                      </Text>
                    </Table.Td>
                    <Table.Td maw={260}>
                      <Text size="xs" c={d.lastError ? 'red' : undefined} style={{ wordBreak: 'break-word' }}>
                        {d.lastError ?? (d.responseStatus ? `HTTP ${d.responseStatus}` : '—')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4} align="flex-end">
                        <Button size="compact-xs" variant="subtle" onClick={() => setOpen(open === d.id ? null : d.id)}>
                          {open === d.id ? 'Hide' : 'Body'}
                        </Button>
                        {d.status === 'failed' && (
                          <Button
                            size="compact-xs"
                            variant="light"
                            disabled={!endpoint?.enabled}
                            loading={retryOne.isPending && retryOne.variables?.id === d.id}
                            onClick={() => retryOne.mutate(d)}
                          >
                            Send again
                          </Button>
                        )}
                      </Stack>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {list.data?.total} {list.data?.total === 1 ? 'delivery' : 'deliveries'} in the past 30 days
              </Text>
              <Pagination total={Math.ceil((list.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
    </Drawer>
  );
}
