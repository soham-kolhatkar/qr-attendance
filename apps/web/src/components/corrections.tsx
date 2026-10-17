import { Badge, Button, Card, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconArrowRight, IconCheck, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from '../api/client';
import { useApiMutation } from '../api/mutations';
import type { Correction } from '../api/types';
import { formatAgo, formatDateTime, KIND_LABELS } from '../lib/format';
import { StatusBadge } from './report';

/** Requests waiting for the signed-in teacher, HOD or admin, for the menu badge. */
export function usePendingCorrectionCount(enabled: boolean) {
  return useQuery({
    queryKey: ['corrections', 'pending-count'],
    queryFn: async () => unwrap(await api.GET('/v1/corrections/pending-count')).count,
    enabled,
    refetchInterval: 60_000,
  });
}

const DECIDED_LABEL = { approved: 'Approved', rejected: 'Turned down', withdrawn: 'Withdrawn' } as const;
const DECIDED_COLOR = { approved: 'teal', rejected: 'red', withdrawn: 'gray' } as const;

/** Correction requests as cards: who, which class, what they ask and why, and the answer or the buttons to give one. */
export function CorrectionList({ items, showSession = true }: { items: Correction[]; showSession?: boolean }) {
  const [rejecting, setRejecting] = useState<Correction | null>(null);
  const approve = useApiMutation(
    async (c: Correction) => unwrap(await api.POST('/v1/corrections/{id}/approve', { params: { path: { id: c.id } }, body: {} })),
    {
      invalidate: [['corrections'], ['session'], ['sessions'], ['reports']],
      success: (c) => `${c.student.fullName} is now marked ${c.requestedStatus}. They've been told.`,
    },
  );

  return (
    <>
      <Stack gap="sm">
        {items.map((c) => (
          <Card key={c.id} withBorder padding="md">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
              <Stack gap={6} style={{ flex: 1, minWidth: 260 }}>
                <div>
                  <Text fw={600}>
                    {c.student.fullName}
                    <Text span size="sm" c="dimmed" fw={400}>
                      {' '}
                      · {c.student.rollNo ? `Roll ${c.student.rollNo}, ` : ''}
                      {c.student.unitPath.at(-1)}
                    </Text>
                  </Text>
                  {showSession && (
                    <Text size="sm" c="dimmed">
                      <Text span component={Link} to={`/sessions/${c.session.id}`} size="sm" c="indigo">
                        {c.session.subject.code} {c.session.subject.name}
                      </Text>{' '}
                      · {KIND_LABELS[c.session.kind] ?? c.session.kind} · {formatDateTime(c.session.startedAt)} · {c.session.teacher}
                      {c.session.status === 'cancelled' && ' · cancelled'}
                    </Text>
                  )}
                </div>
                <Group gap={6}>
                  <StatusBadge status={c.previousStatus} />
                  <IconArrowRight size={14} />
                  <StatusBadge status={c.requestedStatus} />
                  {c.status === 'pending' && c.currentStatus !== c.previousStatus && (
                    <Text size="xs" c="orange">
                      Marked {c.currentStatus} since they asked
                    </Text>
                  )}
                </Group>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  “{c.reason}”
                </Text>
                <Text size="xs" c="dimmed">
                  Asked {formatAgo(c.createdAt)}
                </Text>
              </Stack>

              {c.status === 'pending' ? (
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    color="teal"
                    leftSection={<IconCheck size={14} />}
                    loading={approve.isPending && approve.variables?.id === c.id}
                    onClick={() => approve.mutate(c)}
                  >
                    Approve
                  </Button>
                  <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => setRejecting(c)}>
                    Turn down
                  </Button>
                </Group>
              ) : (
                <Stack gap={4} align="flex-end" maw={320}>
                  <Badge color={DECIDED_COLOR[c.status]} variant="light">
                    {DECIDED_LABEL[c.status]}
                  </Badge>
                  <Text size="xs" c="dimmed" ta="right">
                    {c.status === 'withdrawn' && !c.reviewer ? 'By the student' : (c.reviewer?.fullName ?? '')}
                    {c.reviewedAt && ` · ${formatAgo(c.reviewedAt)}`}
                  </Text>
                  {c.reviewNote && (
                    <Text size="sm" ta="right">
                      {c.reviewNote}
                    </Text>
                  )}
                </Stack>
              )}
            </Group>
          </Card>
        ))}
      </Stack>
      <RejectModal correction={rejecting} onClose={() => setRejecting(null)} />
    </>
  );
}

function RejectModal({ correction, onClose }: { correction: Correction | null; onClose: () => void }) {
  const form = useForm({
    initialValues: { note: '' },
    validate: { note: (v) => (v.trim().length >= 3 ? null : 'Tell the student why (at least 3 characters)') },
  });
  useEffect(() => {
    if (correction) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correction]);
  const reject = useApiMutation(
    async (note: string) =>
      unwrap(await api.POST('/v1/corrections/{id}/reject', { params: { path: { id: correction!.id } }, body: { note } })),
    { invalidate: [['corrections']], success: 'Turned down. The student has been told why.' },
  );

  return (
    <Modal opened={!!correction} onClose={onClose} title="Turn down this request?">
      {correction && (
        <form onSubmit={form.onSubmit((v) => reject.mutate(v.note.trim(), { onSuccess: onClose }))}>
          <Stack>
            <Text size="sm">
              <b>{correction.student.fullName}</b> stays marked {correction.currentStatus} and can't ask again for this class. They
              see your reply in the app.
            </Text>
            <TextInput
              label="Reply to the student"
              placeholder="e.g. You left before the QR code was shown"
              data-autofocus
              {...form.getInputProps('note')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" color="red" loading={reject.isPending}>
                Turn down
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
