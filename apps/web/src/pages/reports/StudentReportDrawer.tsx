import { Card, Drawer, Group, ScrollArea, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api/client';
import { EmptyHint, QueryState } from '../../components/common';
import { countsText, Percent, PercentBar, StatusBadge } from '../../components/report';
import { formatDateTime, KIND_LABELS } from '../../lib/format';

/** One student's attendance by subject and session (staff see the classes they're allowed to). */
export function StudentReportDrawer({
  studentId,
  termId,
  onClose,
}: {
  studentId: string | null;
  termId?: string | null;
  onClose: () => void;
}) {
  const report = useQuery({
    queryKey: ['reports', 'student', studentId, termId ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/reports/students/{id}', {
          params: { path: { id: studentId! }, query: termId ? { termId } : {} },
        }),
      ),
    enabled: studentId !== null,
  });
  const r = report.data;

  return (
    <Drawer opened={studentId !== null} onClose={onClose} position="right" size="lg" title={r?.student.fullName ?? 'Student'}>
      <QueryState query={report}>
        {r && (
          <Stack>
            <Text size="sm" c="dimmed">
              {r.student.username}
              {r.student.rollNo && ` · Roll ${r.student.rollNo}`} · {r.student.unitPath.join(' › ')}
              {r.term && ` · ${r.term.name}`}
            </Text>
            <SimpleGrid cols={2}>
              <Card withBorder padding="sm">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Attendance
                </Text>
                <Percent value={r.overall.percentage} minimum={r.minimumPercent} fz={28} fw={700} />
                <Text size="xs" c="dimmed">
                  Present in {countsText(r.overall)}
                </Text>
              </Card>
              <Card withBorder padding="sm">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Minimum
                </Text>
                <Text fz={28} fw={700}>
                  {r.minimumPercent}%
                </Text>
                <Text size="xs" c="dimmed">
                  {r.overall.percentage !== null && r.overall.percentage < r.minimumPercent ? 'Below the minimum' : 'Meets the minimum'}
                </Text>
              </Card>
            </SimpleGrid>

            {r.subjects.length === 0 ? (
              <EmptyHint>No finished classes yet this term.</EmptyHint>
            ) : (
              <>
                <Table verticalSpacing={6}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Subject</Table.Th>
                      <Table.Th>Present</Table.Th>
                      <Table.Th>Attendance</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {r.subjects.map((s) => (
                      <Table.Tr key={s.subjectId}>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {s.code}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {s.name}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {s.present} / {s.total - s.excused}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <PercentBar value={s.percentage} minimum={r.minimumPercent} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>

                <Text fw={600} mt="sm">
                  Sessions
                </Text>
                <ScrollArea.Autosize mah={420}>
                  <Stack gap={6}>
                    {r.sessions.map((s) => (
                      <Group key={s.sessionId} justify="space-between" wrap="nowrap" align="flex-start">
                        <div style={{ minWidth: 0 }}>
                          <Text size="sm" truncate>
                            {s.subject.code} · {KIND_LABELS[s.kind] ?? s.kind}
                            {s.topic ? ` · ${s.topic}` : ''}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {formatDateTime(s.startedAt)}
                            {s.method === 'manual' && ` · marked by hand${s.reason ? `: ${s.reason}` : ''}`}
                            {s.method === 'qr' && ' · scanned'}
                          </Text>
                        </div>
                        <StatusBadge status={s.status} />
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </>
            )}
          </Stack>
        )}
      </QueryState>
    </Drawer>
  );
}
