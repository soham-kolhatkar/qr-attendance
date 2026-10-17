import { Alert, Badge, Button, Card, Group, Modal, SegmentedControl, Stack, Table, Text, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconDeviceMobile } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useApiMutation } from '../../api/mutations';
import type { RecentClass } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { PageHeader } from '../../components/common';
import { formatDate, formatDateTime, KIND_LABELS, ROLE_LABELS } from '../../lib/format';
import { countsText, Percent, PercentBar, StatusBadge } from '../../components/report';

export function ProfilePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="My profile" />
      <Stack maw={640}>
        {me.user.role === 'student' && <MyPhone />}
        {me.user.role === 'student' && <MyAttendance />}
        {me.user.role === 'student' && <RecentClasses />}
        <Card withBorder padding="lg">
          <Table variant="vertical" withRowBorders={false} verticalSpacing={6}>
            <Table.Tbody>
              <Table.Tr>
                <Table.Th w={140}>Name</Table.Th>
                <Table.Td>{me.user.fullName}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Username</Table.Th>
                <Table.Td>{me.user.username}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Role</Table.Th>
                <Table.Td>{ROLE_LABELS[me.user.role]}</Table.Td>
              </Table.Tr>
              {me.institute && (
                <Table.Tr>
                  <Table.Th>Institute</Table.Th>
                  <Table.Td>{me.institute.name}</Table.Td>
                </Table.Tr>
              )}
              {me.student && (
                <>
                  <Table.Tr>
                    <Table.Th>Class</Table.Th>
                    <Table.Td>{me.student.unitPath.join(' › ')}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>Roll no.</Table.Th>
                    <Table.Td>{me.student.rollNo ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>Batches</Table.Th>
                    <Table.Td>
                      <Group gap={4}>
                        {me.student.groups.length === 0 ? (
                          <Text c="dimmed">—</Text>
                        ) : (
                          me.student.groups.map((g) => (
                            <Badge key={g.id} variant="light">
                              {g.name}
                            </Badge>
                          ))
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                </>
              )}
            </Table.Tbody>
          </Table>
        </Card>
        <Text size="xs" c="dimmed">
          Details wrong? Ask your institute admin to correct them.
        </Text>
      </Stack>
    </>
  );
}

function MyPhone() {
  const phones = useQuery({ queryKey: ['devices', 'mine'], queryFn: async () => unwrap(await api.GET('/v1/devices/mine')) });
  const { active, pending } = phones.data ?? { active: null, pending: null };
  return (
    <Alert icon={<IconDeviceMobile />} color="indigo" title="Marking attendance">
      <Stack gap={4}>
        <Text size="sm">Use the QR Attendance app on your phone and scan the code your teacher shows in class.</Text>
        {active && (
          <Text size="sm">
            Your linked phone: <b>{active.model ?? 'phone'}</b>, since {formatDate(active.activatedAt)}. Only this phone
            can mark your attendance.
          </Text>
        )}
        {!active && phones.isSuccess && <Text size="sm">Sign in to the app on your phone to link it.</Text>}
        {pending && (
          <Text size="sm">
            Switching to <b>{pending.model ?? 'a new phone'}</b> is waiting for approval from your admin or HOD.
          </Text>
        )}
      </Stack>
    </Alert>
  );
}

const useMyAttendance = () =>
  useQuery({ queryKey: ['attendance', 'mine'], queryFn: async () => unwrap(await api.GET('/v1/attendance/mine')) });

function MyAttendance() {
  const m = useMyAttendance().data;
  if (!m?.term) return null;
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Text fw={600}>My attendance</Text>
          <Text size="xs" c="dimmed">
            {m.term.name} · minimum {m.minimumPercent}%
          </Text>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Percent value={m.overall.percentage} minimum={m.minimumPercent} fz={26} fw={700} />
          <Text size="xs" c="dimmed">
            Present in {countsText(m.overall)}
          </Text>
        </div>
      </Group>
      <Table verticalSpacing={6}>
        <Table.Tbody>
          {m.subjects.map((s) => (
            <Table.Tr key={s.offeringId}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {s.subject.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {s.subject.code} · {s.present}/{s.total - s.excused}
                </Text>
              </Table.Td>
              <Table.Td w={150}>
                <PercentBar value={s.percentage} minimum={m.minimumPercent} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

const CORRECTION_LOOK = {
  pending: { label: 'Correction asked', color: 'blue' },
  approved: { label: 'Corrected', color: 'teal' },
  rejected: { label: 'Correction turned down', color: 'red' },
  withdrawn: { label: 'Request withdrawn', color: 'gray' },
} as const;

const RECENT_SHOWN = 8;

/** Recent classes, with correction requests: ask, see the answer, or take the request back. */
function RecentClasses() {
  const m = useMyAttendance().data;
  const [asking, setAsking] = useState<RecentClass | null>(null);
  const [all, setAll] = useState(false);
  const withdraw = useApiMutation(
    async (id: string) => unwrap(await api.POST('/v1/corrections/{id}/withdraw', { params: { path: { id } } })),
    { invalidate: [['attendance']], success: 'Request withdrawn' },
  );
  if (!m?.term || m.recent.length === 0) return null;
  return (
    <Card withBorder padding="lg">
      <Text fw={600}>Recent classes</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {m.correctionWindowDays > 0
          ? `Marked wrongly? You can ask for a correction up to ${m.correctionWindowDays} day${m.correctionWindowDays === 1 ? '' : 's'} after the class.`
          : 'Marked wrongly? Speak to your teacher.'}
      </Text>
      <Stack gap="xs">
        {(all ? m.recent : m.recent.slice(0, RECENT_SHOWN)).map((r) => (
          <Group key={r.sessionId} justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {r.subject.code} {r.subject.name}
              </Text>
              <Text size="xs" c="dimmed">
                {KIND_LABELS[r.kind] ?? r.kind} · {formatDateTime(r.startedAt)}
                {r.topic ? ` · ${r.topic}` : ''}
              </Text>
              {r.correction && (
                <Text size="xs" c={CORRECTION_LOOK[r.correction.status].color}>
                  {CORRECTION_LOOK[r.correction.status].label}
                  {r.correction.reviewNote && r.correction.status !== 'withdrawn' ? `: ${r.correction.reviewNote}` : ''}
                </Text>
              )}
            </div>
            <Group gap="xs" wrap="nowrap">
              {r.open && r.status === 'absent' ? (
                <Badge size="sm" variant="light" color="gray">
                  Not marked yet
                </Badge>
              ) : (
                <StatusBadge status={r.status} />
              )}
              {r.canRequest.length > 0 && (
                <Button size="compact-xs" variant="light" onClick={() => setAsking(r)}>
                  Ask to correct
                </Button>
              )}
              {r.correction?.status === 'pending' && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  loading={withdraw.isPending && withdraw.variables === r.correction.id}
                  onClick={() => withdraw.mutate(r.correction!.id)}
                >
                  Withdraw
                </Button>
              )}
            </Group>
          </Group>
        ))}
      </Stack>
      {m.recent.length > RECENT_SHOWN && (
        <Button variant="subtle" size="xs" mt="xs" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${m.recent.length}`}
        </Button>
      )}
      <RequestModal recent={asking} onClose={() => setAsking(null)} />
    </Card>
  );
}

function RequestModal({ recent, onClose }: { recent: RecentClass | null; onClose: () => void }) {
  const form = useForm<{ requestedStatus: 'present' | 'excused'; reason: string }>({
    initialValues: { requestedStatus: 'present', reason: '' },
    validate: { reason: (v) => (v.trim().length >= 5 ? null : 'Say what happened (at least 5 characters)') },
  });
  useEffect(() => {
    if (recent) form.setValues({ requestedStatus: recent.canRequest[0] ?? 'present', reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);
  const ask = useApiMutation(
    async (v: { requestedStatus: 'present' | 'excused'; reason: string }) =>
      unwrap(await api.POST('/v1/corrections/', { body: { sessionId: recent!.sessionId, ...v } })),
    { invalidate: [['attendance']], success: 'Sent. You’ll get a notification when your teacher answers.' },
  );
  return (
    <Modal opened={!!recent} onClose={onClose} title="Ask for a correction">
      {recent && (
        <form onSubmit={form.onSubmit((v) => ask.mutate({ ...v, reason: v.reason.trim() }, { onSuccess: onClose }))}>
          <Stack>
            <Text size="sm">
              {recent.subject.code} {recent.subject.name} · {formatDateTime(recent.startedAt)}. You're marked <b>{recent.status}</b>.
            </Text>
            {recent.canRequest.length > 1 && (
              <SegmentedControl
                data={[
                  { value: 'present', label: 'I was there' },
                  { value: 'excused', label: 'I had a valid reason' },
                ]}
                {...form.getInputProps('requestedStatus')}
              />
            )}
            <Textarea
              label="What happened"
              placeholder={form.values.requestedStatus === 'present' ? 'e.g. I was in class but the app couldn’t read the QR code' : 'e.g. I was at the hospital; I have a certificate'}
              autosize
              minRows={3}
              maxLength={500}
              data-autofocus
              {...form.getInputProps('reason')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={ask.isPending}>
                Send request
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
