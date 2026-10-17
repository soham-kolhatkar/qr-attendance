import { Badge, Box, Button, Card, Group, Menu, SegmentedControl, SimpleGrid, Table, Text, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconDownload, IconFileSpreadsheet, IconFileTypePdf } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, unwrap } from '../../api/client';
import type { Register } from '../../api/types';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { formatPercent, Percent, percentColor, STATUS_COLOR, STATUS_LABEL, STATUS_LETTER } from '../../components/report';
import { formatDateTime, KIND_LABELS } from '../../lib/format';
import { downloadFromApi } from '../../lib/download';
import { StudentReportDrawer } from './StudentReportDrawer';

const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** The attendance register for one class: every student against every session. */
export function RegisterPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<'all' | 'below'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const register = useQuery({
    queryKey: ['reports', 'register', id],
    queryFn: async () => unwrap(await api.GET('/v1/reports/offerings/{id}/register', { params: { path: { id: id! } } })),
  });
  const r = register.data;

  const download = async (format: 'xlsx' | 'pdf') => {
    setDownloading(true);
    try {
      await downloadFromApi(`/v1/reports/offerings/${id}/register/export?format=${format}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title={r ? `${r.offering.subject.code} ${r.offering.subject.name}` : 'Register'}
        description={r ? `Attendance register · ${r.offering.term.name} · ${r.offering.faculty.join(', ')}` : undefined}
        actions={
          <>
            <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)}>
              Back
            </Button>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="light" leftSection={<IconDownload size={16} />} loading={downloading} disabled={!r}>
                  Download
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconFileSpreadsheet size={16} />} onClick={() => void download('xlsx')}>
                  Excel
                </Menu.Item>
                <Menu.Item leftSection={<IconFileTypePdf size={16} />} onClick={() => void download('pdf')}>
                  PDF, for printing
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      <QueryState query={register}>
        {r && (r.sessions.length === 0 ? <EmptyHint>No sessions yet for this class.</EmptyHint> : <RegisterBody r={r} view={view} setView={setView} onOpen={setOpen} />)}
      </QueryState>
      <StudentReportDrawer studentId={open} termId={r?.offering.term.id} onClose={() => setOpen(null)} />
    </>
  );
}

function RegisterBody({
  r,
  view,
  setView,
  onOpen,
}: {
  r: Register;
  view: 'all' | 'below';
  setView: (v: 'all' | 'below') => void;
  onOpen: (id: string) => void;
}) {
  const below = r.students.filter((s) => s.below).length;
  const counted = r.sessions.filter((s) => !s.open).length;
  const totals = r.students.reduce(
    (t, s) => ({ present: t.present + s.present, counted: t.counted + s.total - s.excused }),
    { present: 0, counted: 0 },
  );
  const overall = totals.counted > 0 ? Math.round((totals.present / totals.counted) * 1000) / 10 : null;
  const rows = view === 'below' ? r.students.filter((s) => s.below) : r.students;

  return (
    <>
      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <Stat label="Class attendance">
          <Percent value={overall} minimum={r.minimumPercent} fz={28} fw={700} />
        </Stat>
        <Stat label={`Below ${r.minimumPercent}%`}>
          <Text fz={28} fw={700} c={below > 0 ? 'red' : undefined}>
            {below}
          </Text>
        </Stat>
        <Stat label="Students">
          <Text fz={28} fw={700}>
            {r.students.length}
          </Text>
        </Stat>
        <Stat label="Sessions">
          <Text fz={28} fw={700}>
            {counted}
            {counted < r.sessions.length && (
              <Text span size="sm" c="dimmed">
                {' '}
                + {r.sessions.length - counted} open
              </Text>
            )}
          </Text>
        </Stat>
      </SimpleGrid>

      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md" wrap="wrap">
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as 'all' | 'below')}
            data={[
              { value: 'all', label: 'Everyone' },
              { value: 'below', label: `Below ${r.minimumPercent}%` },
            ]}
          />
          <Group gap="xs">
            {(['present', 'absent', 'excused'] as const).map((s) => (
              <Badge key={s} variant="light" color={STATUS_COLOR[s]} size="sm">
                {STATUS_LETTER[s]} = {STATUS_LABEL[s].toLowerCase()}
              </Badge>
            ))}
            <Text size="xs" c="dimmed">
              Blank: not on that session's list
            </Text>
          </Group>
        </Group>
        <Table.ScrollContainer minWidth={420 + r.sessions.length * 34}>
          <Table withColumnBorders verticalSpacing={4} horizontalSpacing={6} highlightOnHover stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 2 }} miw={200}>
                  Student
                </Table.Th>
                {r.sessions.map((s) => (
                  <Table.Th key={s.id} ta="center" w={34} p={2}>
                    <Tooltip label={`${formatDateTime(s.startedAt)} · ${KIND_LABELS[s.kind] ?? s.kind}${s.topic ? ` · ${s.topic}` : ''}${s.open ? ' · still open' : ''}`}>
                      <Text size="10px" fw={600} c={s.open ? 'dimmed' : undefined} style={{ whiteSpace: 'pre-line', lineHeight: 1.15 }}>
                        {day.format(new Date(s.startedAt)).replace(' ', '\n')}
                      </Text>
                    </Tooltip>
                  </Table.Th>
                ))}
                <Table.Th ta="right">Present</Table.Th>
                <Table.Th ta="right">%</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((st) => (
                <Table.Tr key={st.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(st.id)}>
                  <Table.Td style={{ position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 1 }}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {st.rollNo ? `${st.rollNo}. ` : ''}
                      {st.fullName}
                    </Text>
                  </Table.Td>
                  {st.marks.map((m, i) => (
                    <Table.Td key={r.sessions[i]!.id} p={2} ta="center">
                      {m && (
                        <Box
                          style={{
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 700,
                            lineHeight: '20px',
                            background: `var(--mantine-color-${STATUS_COLOR[m]}-light)`,
                            color: `var(--mantine-color-${STATUS_COLOR[m]}-light-color)`,
                            opacity: r.sessions[i]!.open ? 0.5 : 1,
                          }}
                        >
                          {STATUS_LETTER[m]}
                        </Box>
                      )}
                    </Table.Td>
                  ))}
                  <Table.Td ta="right">
                    <Text size="sm">
                      {st.present}/{st.total - st.excused}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" fw={600} c={percentColor(st.percentage, r.minimumPercent)}>
                      {formatPercent(st.percentage)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {rows.length === 0 && <EmptyHint>Nobody is below {r.minimumPercent}%.</EmptyHint>}
      </Card>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      {children}
    </Card>
  );
}
