import { Badge, CloseButton, Group, Pagination, SegmentedControl, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, unwrap } from '../../api/client';
import type { CorrectionStatus } from '../../api/types';
import { CorrectionList, usePendingCorrectionCount } from '../../components/corrections';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';

const PAGE_SIZE = 25;

const VIEWS: { value: CorrectionStatus; label: string }[] = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Turned down' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const EMPTY: Record<CorrectionStatus, string> = {
  pending: 'Nothing waiting. When a student asks for a mark to be corrected, it appears here.',
  approved: 'No requests approved yet.',
  rejected: 'No requests turned down.',
  withdrawn: 'No requests withdrawn.',
};

/** Students' requests to correct a mark, for the classes the signed-in teacher, HOD or admin looks after. */
export function CorrectionsPage() {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('sessionId') ?? undefined;
  const [status, setStatus] = useState<CorrectionStatus>('pending');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status, q, sessionId]);

  const pending = usePendingCorrectionCount(true);
  const list = useQuery({
    queryKey: ['corrections', { status, q, sessionId, page }],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/corrections/', {
          params: { query: { status, q: q || undefined, sessionId, page, pageSize: PAGE_SIZE } },
        }),
      ),
  });
  const views = VIEWS.map((v) => (v.value === 'pending' && pending.data ? { ...v, label: `${v.label} (${pending.data})` } : v));

  return (
    <>
      <PageHeader
        title="Correction requests"
        description="Students can ask, in the app, for their mark in a finished class to be changed: their scan failed, or they had a valid reason to be away. Approving changes the mark; either way the student is told."
      />
      <Group mb="md" wrap="wrap">
        <SegmentedControl data={views} value={status} onChange={(v) => setStatus(v as CorrectionStatus)} />
        <TextInput
          placeholder="Search student or subject code"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          flex={1}
          miw={220}
        />
        {sessionId && (
          <Badge
            size="lg"
            variant="light"
            rightSection={<CloseButton size="xs" aria-label="Show all classes" onClick={() => setParams({})} />}
          >
            One class only
          </Badge>
        )}
      </Group>
      <QueryState query={list}>
        {list.data?.items.length === 0 ? (
          <EmptyHint>{q ? 'No requests match.' : EMPTY[status]}</EmptyHint>
        ) : (
          <>
            <CorrectionList items={list.data?.items ?? []} />
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {list.data?.total} {list.data?.total === 1 ? 'request' : 'requests'}
              </Text>
              <Pagination total={Math.ceil((list.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
    </>
  );
}
