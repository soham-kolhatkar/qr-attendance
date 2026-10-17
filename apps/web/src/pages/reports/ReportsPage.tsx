import { LineChart } from '@mantine/charts';
import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Menu,
  Pagination,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconDownload, IconFileSpreadsheet, IconFileTypePdf, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useGroups, useSubjects, useTerms } from '../../api/hooks';
import type { ReportSummary } from '../../api/types';
import { EmptyHint, PageHeader, QueryState, UnitSelect } from '../../components/common';
import { formatPercent, Percent, PercentBar, percentColor } from '../../components/report';
import { downloadFromApi } from '../../lib/download';
import { StudentReportDrawer } from './StudentReportDrawer';

const PAGE_SIZE = 50;

type Filters = { termId: string | null; unitId: string | null; subjectId: string | null; groupId: string | null };

/** Only the filters that are set, as API query parameters. */
function filterQuery(f: Filters) {
  return {
    ...(f.termId && { termId: f.termId }),
    ...(f.unitId && { unitId: f.unitId }),
    ...(f.subjectId && { subjectId: f.subjectId }),
    ...(f.groupId && { groupId: f.groupId }),
  };
}

export function ReportsPage() {
  const [filters, setFilters] = useState<Filters>({ termId: null, unitId: null, subjectId: null, groupId: null });
  const set = (change: Partial<Filters>) => setFilters((f) => ({ ...f, ...change }));
  const query = filterQuery(filters);

  const summary = useQuery({
    queryKey: ['reports', 'summary', query],
    queryFn: async () => unwrap(await api.GET('/v1/reports/summary', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Attendance for the term. Only finished sessions count, and an excused absence counts neither for nor against a student."
      />
      <FilterBar filters={filters} set={set} termId={s?.term?.id ?? null} />
      <QueryState query={summary}>
        {s && !s.term && <EmptyHint>No terms yet. Add one under Terms &amp; subjects.</EmptyHint>}
        {s?.term && (
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, md: 4 }}>
              <Kpi label="Attendance" hint={`${s.overall.present.toLocaleString()} present`}>
                <Percent value={s.overall.percentage} minimum={s.minimumPercent} fz={30} fw={700} />
              </Kpi>
              <Kpi label={`Below ${s.minimumPercent}%`} hint={`of ${s.students.total.toLocaleString()} students`}>
                <Text fz={30} fw={700} c={s.students.below > 0 ? 'red' : undefined}>
                  {s.students.below.toLocaleString()}
                </Text>
              </Kpi>
              <Kpi label="Students" hint="with attendance taken">
                <Text fz={30} fw={700}>
                  {s.students.total.toLocaleString()}
                </Text>
              </Kpi>
              <Kpi label="Sessions" hint="finished this term">
                <Text fz={30} fw={700}>
                  {s.sessions.toLocaleString()}
                </Text>
              </Kpi>
            </SimpleGrid>

            {s.sessions === 0 ? (
              <EmptyHint>No finished sessions match these filters yet.</EmptyHint>
            ) : (
              <>
                <Card withBorder padding="lg">
                  <Text fw={600} mb="md">
                    Attendance by day
                  </Text>
                  <TrendChart summary={s} />
                </Card>
                <Grid gap="lg">
                  <Grid.Col span={{ base: 12, lg: 6 }}>
                    <BreakdownCard
                      title="By class"
                      rows={s.byUnit.map((u) => ({
                        key: u.unitId,
                        label: u.path.at(-1) ?? '?',
                        sub: [u.path.slice(0, -1).join(' › '), `${u.students} students`].filter(Boolean).join(' · '),
                        percentage: u.percentage,
                        below: u.below,
                        onClick: () => set({ unitId: u.unitId, groupId: null }),
                        active: filters.unitId === u.unitId,
                      }))}
                      minimum={s.minimumPercent}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, lg: 6 }}>
                    <BreakdownCard
                      title="By subject"
                      rows={s.bySubject.map((x) => ({
                        key: x.subjectId,
                        label: `${x.code} ${x.name}`,
                        sub: `${x.sessions} sessions · ${x.students} students`,
                        percentage: x.percentage,
                        below: x.below,
                        onClick: () => set({ subjectId: x.subjectId }),
                        active: filters.subjectId === x.subjectId,
                      }))}
                      minimum={s.minimumPercent}
                    />
                  </Grid.Col>
                </Grid>
                <Card withBorder padding="lg">
                  <Text fw={600}>By day and time</Text>
                  <Text size="sm" c="dimmed" mb="md">
                    When attendance is low. Each square is the attendance of sessions that started in that hour.
                  </Text>
                  <WeekHeatmap summary={s} />
                </Card>
              </>
            )}
            <StudentList filters={filters} minimum={s.minimumPercent} termId={s.term.id} />
          </Stack>
        )}
      </QueryState>
    </>
  );
}

function FilterBar({ filters, set, termId }: { filters: Filters; set: (f: Partial<Filters>) => void; termId: string | null }) {
  const terms = useTerms();
  const subjects = useSubjects();
  const groups = useGroups(filters.unitId);
  return (
    <Group mb="lg" wrap="wrap" align="flex-end">
      <Select
        label="Term"
        data={(terms.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        value={filters.termId ?? termId}
        onChange={(v) => set({ termId: v })}
        allowDeselect={false}
        w={220}
      />
      <UnitSelect
        label="Class"
        placeholder="All classes"
        value={filters.unitId}
        onChange={(v) => set({ unitId: v, groupId: null })}
        w={280}
      />
      <Select
        label="Subject"
        placeholder="All subjects"
        searchable
        clearable
        data={(subjects.data ?? []).map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))}
        value={filters.subjectId}
        onChange={(v) => set({ subjectId: v })}
        w={240}
      />
      <Select
        label="Batch or group"
        placeholder="All"
        searchable
        clearable
        data={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))}
        value={filters.groupId}
        onChange={(v) => set({ groupId: v })}
        w={160}
      />
      {(filters.unitId || filters.subjectId || filters.groupId) && (
        <Button variant="subtle" onClick={() => set({ unitId: null, subjectId: null, groupId: null })}>
          Clear filters
        </Button>
      )}
    </Group>
  );
}

function Kpi({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      {children}
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </Card>
  );
}

const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

function TrendChart({ summary }: { summary: ReportSummary }) {
  const data = summary.trend.map((d) => ({
    day: dayLabel.format(new Date(`${d.date}T00:00:00`)),
    Attendance: d.percentage,
    sessions: d.sessions,
  }));
  return (
    <LineChart
      h={240}
      data={data}
      dataKey="day"
      series={[{ name: 'Attendance', color: 'indigo.6' }]}
      curveType="monotone"
      connectNulls
      withDots={data.length <= 40}
      yAxisProps={{ domain: [0, 100] }}
      valueFormatter={(v) => formatPercent(v)}
      referenceLines={[{ y: summary.minimumPercent, label: `Minimum ${summary.minimumPercent}%`, color: 'red.6' }]}
    />
  );
}

type BreakdownRow = {
  key: string;
  label: string;
  sub: string;
  percentage: number | null;
  below: number;
  onClick: () => void;
  active: boolean;
};

/** A ranked list, lowest attendance first; click a row to filter by it. */
function BreakdownCard({ title, rows, minimum }: { title: string; rows: BreakdownRow[]; minimum: number }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101)), [rows]);
  const visible = showAll ? sorted : sorted.slice(0, 8);
  return (
    <Card withBorder padding="lg" h="100%">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>{title}</Text>
        <Text size="xs" c="dimmed">
          Lowest first · click to filter
        </Text>
      </Group>
      <Table verticalSpacing={6} highlightOnHover>
        <Table.Tbody>
          {visible.map((r) => (
            <Table.Tr key={r.key} style={{ cursor: 'pointer' }} onClick={r.onClick} bg={r.active ? 'var(--mantine-color-indigo-light)' : undefined}>
              <Table.Td>
                <Text size="sm" fw={500} lineClamp={1}>
                  {r.label}
                </Text>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {r.sub}
                </Text>
              </Table.Td>
              <Table.Td w={140}>
                <PercentBar value={r.percentage} minimum={minimum} />
              </Table.Td>
              <Table.Td w={84} ta="right">
                {r.below > 0 && (
                  <Badge size="sm" color="red" variant="light" tt="none">
                    {r.below} below
                  </Badge>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {sorted.length > 8 && (
        <Anchor component="button" size="sm" mt="xs" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
        </Anchor>
      )}
    </Card>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function WeekHeatmap({ summary }: { summary: ReportSummary }) {
  const cells = new Map(summary.heatmap.map((c) => [`${c.weekday}-${c.hour}`, c]));
  const hours = summary.heatmap.map((c) => c.hour);
  const from = Math.min(...hours);
  const to = Math.max(...hours);
  const days = [...new Set(summary.heatmap.map((c) => c.weekday))].sort();
  const columns = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

  return (
    <Box style={{ overflowX: 'auto' }}>
      <Box style={{ display: 'grid', gridTemplateColumns: `48px repeat(${columns.length}, minmax(40px, 1fr))`, gap: 4, minWidth: 48 + columns.length * 44 }}>
        <div />
        {columns.map((h) => (
          <Text key={h} size="xs" c="dimmed" ta="center">
            {hourLabel(h)}
          </Text>
        ))}
        {days.map((d) => (
          <Box key={d} style={{ display: 'contents' }}>
            <Text size="xs" c="dimmed" style={{ alignSelf: 'center' }}>
              {WEEKDAYS[d - 1]}
            </Text>
            {columns.map((h) => {
              const c = cells.get(`${d}-${h}`);
              const color = c ? percentColor(c.percentage, summary.minimumPercent) : null;
              return (
                <Tooltip
                  key={h}
                  disabled={!c}
                  label={c ? `${WEEKDAYS[d - 1]} ${hourLabel(h)} · ${c.sessions} session${c.sessions === 1 ? '' : 's'} · ${formatPercent(c.percentage)}` : ''}
                >
                  <Box
                    h={32}
                    style={{
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: color ? `var(--mantine-color-${color}-light)` : 'var(--mantine-color-default-hover)',
                      color: color ? `var(--mantine-color-${color}-light-color)` : undefined,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {c?.percentage !== undefined && c.percentage !== null ? Math.round(c.percentage) : ''}
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function StudentList({ filters, minimum, termId }: { filters: Filters; minimum: number; termId: string }) {
  const [view, setView] = useState<'below' | 'all'>('below');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<'xlsx' | 'pdf' | null>(null);
  const base = { ...filterQuery(filters), ...(view === 'below' && { below: 'true' as const }), ...(q && { q }) };
  useEffect(() => setPage(1), [view, q, filters]);

  const list = useQuery({
    queryKey: ['reports', 'students', base, page],
    queryFn: async () =>
      unwrap(await api.GET('/v1/reports/students', { params: { query: { ...base, page, pageSize: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });

  const download = async (format: 'xlsx' | 'pdf') => {
    setDownloading(format);
    try {
      await downloadFromApi(`/v1/reports/students/export?${new URLSearchParams({ ...base, format })}`);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md" wrap="wrap">
        <Group wrap="wrap">
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as 'below' | 'all')}
            data={[
              { value: 'below', label: `Below ${minimum}%` },
              { value: 'all', label: 'All students' },
            ]}
          />
          <TextInput
            placeholder="Search name, username or roll no."
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={260}
          />
        </Group>
        <Menu position="bottom-end">
          <Menu.Target>
            <Button variant="light" leftSection={<IconDownload size={16} />} loading={downloading !== null}>
              Download
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconFileSpreadsheet size={16} />} onClick={() => void download('xlsx')}>
              Excel, with a column per subject
            </Menu.Item>
            <Menu.Item leftSection={<IconFileTypePdf size={16} />} onClick={() => void download('pdf')}>
              PDF, for printing
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <QueryState query={list}>
        {list.data?.items.length === 0 ? (
          <EmptyHint>{view === 'below' ? `Nobody is below ${minimum}%.` : 'No attendance recorded yet.'}</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={640}>
              <Table highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Roll</Table.Th>
                    <Table.Th>Student</Table.Th>
                    <Table.Th>Class</Table.Th>
                    <Table.Th>Present</Table.Th>
                    <Table.Th>Attendance</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data?.items.map((r) => (
                    <Table.Tr key={r.student.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r.student.id)}>
                      <Table.Td c="dimmed">{r.student.rollNo ?? '—'}</Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {r.student.fullName}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {r.student.username}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{r.student.unitPath.join(' › ')}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {r.present} / {r.total - r.excused}
                          {r.excused > 0 && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              ({r.excused} excused)
                            </Text>
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <PercentBar value={r.percentage} minimum={minimum} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {list.data?.total.toLocaleString()} student{list.data?.total === 1 ? '' : 's'}
              </Text>
              <Pagination total={Math.ceil((list.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
      <StudentReportDrawer studentId={open} termId={termId} onClose={() => setOpen(null)} />
    </Card>
  );
}
