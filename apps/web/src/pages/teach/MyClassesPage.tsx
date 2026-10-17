import {
  Alert,
  Button,
  Card,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconBroadcast, IconPlayerPlay, IconTable } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, api, errorMessage, unwrap } from '../../api/client';
import { fetchAllPages, useAttendanceSettings, useGroups, useStructure, useTerms } from '../../api/hooks';
import type { Offering } from '../../api/types';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { AudienceBadges, useDefaultTermId } from '../admin/OfferingsPage';

type Kind = 'lecture' | 'lab' | 'tutorial' | 'other';

export function MyClassesPage() {
  const terms = useTerms();
  const defaultTerm = useDefaultTermId();
  const [termId, setTermId] = useState<string | null>(null);
  const [starting, setStarting] = useState<Offering | null>(null);
  useEffect(() => {
    if (termId === null && defaultTerm) setTermId(defaultTerm);
  }, [defaultTerm, termId]);

  const offerings = useQuery({
    queryKey: ['offerings', 'mine', termId],
    queryFn: () =>
      fetchAllPages<Offering>(async (page) =>
        unwrap(
          await api.GET('/v1/offerings/', { params: { query: { mine: 'true', termId: termId ?? undefined, page, pageSize: 100 } } }),
        ),
      ),
  });
  const open = useQuery({
    queryKey: ['sessions', 'mine', 'open'],
    queryFn: async () => unwrap(await api.GET('/v1/sessions/', { params: { query: { mine: 'true', status: 'open', pageSize: 1 } } })),
    refetchInterval: 30_000,
  });
  const running = open.data?.items[0];

  return (
    <>
      <PageHeader
        title="My classes"
        description="Start attendance for a class, then show the QR code on the projector. Students scan it with their phone."
        actions={
          <Select
            data={(terms.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            value={termId}
            onChange={setTermId}
            placeholder="All terms"
            clearable
            w={240}
            aria-label="Term"
          />
        }
      />
      {running && (
        <Alert color="teal" icon={<IconBroadcast />} mb="lg" title={`Attendance running: ${running.offering.subject.code} ${running.offering.subject.name}`}>
          <Group justify="space-between">
            <Text size="sm">
              {running.counts.present} of {running.counts.total} present so far.
            </Text>
            <Button component={Link} to={`/sessions/${running.id}`} size="xs" color="teal">
              Open session
            </Button>
          </Group>
        </Alert>
      )}
      <QueryState query={offerings}>
        {offerings.data?.length === 0 ? (
          <EmptyHint>You have no classes in this term. Your admin or HOD assigns them under Offerings.</EmptyHint>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {offerings.data?.map((o) => (
              <Card key={o.id} withBorder padding="lg">
                <Stack gap="xs" h="100%">
                  <div>
                    <Text fw={700}>{o.subject.code}</Text>
                    <Text size="sm">{o.subject.name}</Text>
                  </div>
                  <AudienceBadges offering={o} />
                  <Text size="xs" c="dimmed" mt="auto">
                    {o.term.name}
                    {o.faculty.length > 1 && ` · with ${o.faculty.length - 1} other teacher${o.faculty.length > 2 ? 's' : ''}`}
                  </Text>
                  <Group gap="xs" grow>
                    <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => setStarting(o)} disabled={!!running}>
                      Take attendance
                    </Button>
                    <Button component={Link} to={`/reports/offerings/${o.id}`} variant="light" leftSection={<IconTable size={16} />}>
                      Register
                    </Button>
                  </Group>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
        )}
      </QueryState>
      <StartSessionModal offering={starting} onClose={() => setStarting(null)} />
    </>
  );
}

function StartSessionModal({ offering, onClose }: { offering: Offering | null; onClose: () => void }) {
  const navigate = useNavigate();
  const settings = useAttendanceSettings();
  const structure = useStructure();
  const groups = useGroups();
  const [error, setError] = useState<{ message: string; sessionId?: string } | null>(null);

  const form = useForm({
    initialValues: { kind: 'lecture' as Kind, topic: '', scanMinutes: 10 as number | string, only: [] as string[] },
  });
  useEffect(() => {
    if (offering) {
      form.setValues({ kind: 'lecture', topic: '', scanMinutes: settings.data?.defaultScanMinutes ?? 10, only: [] });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offering]);

  // "Only for": smaller classes or batches inside this offering's audience.
  const narrowOptions = useMemo(() => {
    if (!offering) return [];
    const audienceUnits = offering.audience.units.map((u) => u.id);
    const within = (unitId: string | null) => !!unitId && structure.pathIds(unitId).some((id) => audienceUnits.includes(id));
    const units = structure.options
      .filter((o) => within(o.value))
      .map((o) => ({ value: `u:${o.value}`, label: `Class: ${o.path.slice(-2).join(' › ')}` }));
    const batchIds = new Set(offering.audience.groups.map((g) => g.id));
    const batches = (groups.data ?? [])
      .filter((g) => batchIds.has(g.id) || within(g.unitId))
      .map((g) => ({ value: `g:${g.id}`, label: `Batch: ${g.name} (${g.unitPath.at(-1) ?? 'institute'})` }));
    return [...batches, ...units];
  }, [offering, structure, groups.data]);

  const start = useMutation({
    meta: { quiet: true },
    mutationFn: async (v: typeof form.values) => {
      const unitIds = v.only.filter((x) => x.startsWith('u:')).map((x) => x.slice(2));
      const groupIds = v.only.filter((x) => x.startsWith('g:')).map((x) => x.slice(2));
      return unwrap(
        await api.POST('/v1/sessions/', {
          body: {
            offeringId: offering!.id,
            kind: v.kind,
            topic: v.topic.trim() || undefined,
            scanMinutes: Number(v.scanMinutes) || undefined,
            audience: v.only.length ? { unitIds, groupIds } : undefined,
          },
        }),
      );
    },
    onSuccess: (session) => navigate(`/sessions/${session.id}`),
    onError: (err) =>
      setError({
        message: errorMessage(err),
        sessionId:
          err instanceof ApiError && err.code === 'SESSION_ALREADY_OPEN' ? (err.details as { sessionId?: string })?.sessionId : undefined,
      }),
  });

  return (
    <Modal opened={!!offering} onClose={onClose} title={offering ? `Take attendance — ${offering.subject.code}` : ''} size="lg">
      {offering && (
        <form onSubmit={form.onSubmit((v) => start.mutate(v))}>
          <Stack>
            <Group gap="xs">
              <Text size="sm">{offering.subject.name}</Text>
              <AudienceBadges offering={offering} />
            </Group>
            {error && (
              <Alert color="red">
                <Group justify="space-between">
                  <Text size="sm">{error.message}</Text>
                  {error.sessionId && (
                    <Button component={Link} to={`/sessions/${error.sessionId}`} size="xs" variant="light" color="red">
                      Go to it
                    </Button>
                  )}
                </Group>
              </Alert>
            )}
            <SegmentedControl
              data={[
                { value: 'lecture', label: 'Lecture' },
                { value: 'lab', label: 'Lab' },
                { value: 'tutorial', label: 'Tutorial' },
                { value: 'other', label: 'Other' },
              ]}
              {...form.getInputProps('kind')}
            />
            <TextInput label="Topic (optional)" placeholder="e.g. Linked lists" {...form.getInputProps('topic')} />
            {narrowOptions.length > 0 && (
              <MultiSelect
                label="Only for (optional)"
                description="Leave empty for the whole class, or pick e.g. one lab batch"
                data={narrowOptions}
                searchable
                {...form.getInputProps('only')}
              />
            )}
            <NumberInput label="Scanning stays open for (minutes)" min={1} max={240} {...form.getInputProps('scanMinutes')} />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={start.isPending} leftSection={<IconPlayerPlay size={16} />}>
                Start
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
