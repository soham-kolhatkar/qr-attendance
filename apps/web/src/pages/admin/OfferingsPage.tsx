import { ActionIcon, Badge, Button, Group, Modal, MultiSelect, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconPencil, IconPlus, IconSearch, IconTable, IconTrash, IconUsers } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from '../../api/client';
import { fetchAllPages, useGroups, useStructure, useSubjects, useTeachers, useTerms } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Offering } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { confirmDelete, EmptyHint, PageHeader, QueryState } from '../../components/common';

/** The term running today, else the newest. */
export function useDefaultTermId(): string | null {
  const terms = useTerms();
  const today = new Date().toISOString().slice(0, 10);
  const list = terms.data ?? [];
  return (list.find((t) => t.startsOn <= today && today <= t.endsOn) ?? list[0])?.id ?? null;
}

export function OfferingsPage() {
  const terms = useTerms();
  const defaultTerm = useDefaultTermId();
  const [termId, setTermId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Offering | 'new' | null>(null);
  const [rosterOf, setRosterOf] = useState<Offering | null>(null);
  useEffect(() => {
    if (termId === null && defaultTerm) setTermId(defaultTerm);
  }, [defaultTerm, termId]);

  const offerings = useQuery({
    queryKey: ['offerings', { termId }],
    queryFn: () =>
      fetchAllPages<Offering>(async (page) =>
        unwrap(await api.GET('/v1/offerings/', { params: { query: { termId: termId ?? undefined, page, pageSize: 100 } } })),
      ),
  });
  const remove = useApiMutation(async (id: string) => unwrap(await api.DELETE('/v1/offerings/{id}', { params: { path: { id } } })), {
    invalidate: [['offerings'], ['overview']],
    success: 'Offering deleted',
  });

  const q = search.trim().toLowerCase();
  const rows = (offerings.data ?? []).filter(
    (o) =>
      !q ||
      o.subject.code.toLowerCase().includes(q) ||
      o.subject.name.toLowerCase().includes(q) ||
      o.faculty.some((f) => f.fullName.toLowerCase().includes(q)) ||
      o.audience.units.some((u) => u.path.join(' ').toLowerCase().includes(q)),
  );

  return (
    <>
      <PageHeader
        title="Offerings"
        description="Who teaches which subject to which class or batch this term. Teachers see their offerings under My classes and start attendance from there."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')} disabled={!terms.data?.length}>
            New offering
          </Button>
        }
      />
      <Group mb="md">
        <Select
          label="Term"
          data={(terms.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          value={termId}
          onChange={setTermId}
          w={260}
          placeholder="All terms"
          clearable
        />
        <TextInput
          label="Search"
          placeholder="Subject, teacher or class"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={300}
        />
      </Group>
      {!terms.isPending && !terms.data?.length && <EmptyHint>Add a term under Terms & subjects first.</EmptyHint>}
      <QueryState query={offerings}>
        {rows.length === 0 ? (
          <EmptyHint>No offerings{q ? ' match' : ' in this term yet'}.</EmptyHint>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>Taught to</Table.Th>
                  <Table.Th>Teachers</Table.Th>
                  <Table.Th>Term</Table.Th>
                  <Table.Th w={1} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((o) => (
                  <Table.Tr key={o.id}>
                    <Table.Td>
                      <Text fw={600} size="sm">
                        {o.subject.code}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {o.subject.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <AudienceBadges offering={o} />
                    </Table.Td>
                    <Table.Td>{o.faculty.map((f) => f.fullName).join(', ') || <Text c="red" size="sm">No teacher</Text>}</Table.Td>
                    <Table.Td c="dimmed">{o.term.name}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label="Class list">
                          <ActionIcon variant="subtle" color="gray" onClick={() => setRosterOf(o)} aria-label="Class list">
                            <IconUsers size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Attendance register">
                          <ActionIcon component={Link} to={`/reports/offerings/${o.id}`} variant="subtle" color="gray" aria-label="Attendance register">
                            <IconTable size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon variant="subtle" color="gray" onClick={() => setEditing(o)} aria-label="Edit">
                          <IconPencil size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" onClick={() => confirmDelete(`offering ${o.subject.code}`, () => remove.mutate(o.id))} aria-label="Delete">
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </QueryState>
      <OfferingModal offering={editing} defaultTermId={termId} onClose={() => setEditing(null)} />
      <RosterModal offering={rosterOf} onClose={() => setRosterOf(null)} />
    </>
  );
}

export function AudienceBadges({ offering }: { offering: Pick<Offering, 'audience'> }) {
  return (
    <Group gap={4}>
      {offering.audience.units.map((u) => (
        <Badge key={u.id} variant="light" size="sm" tt="none">
          {u.path.slice(-2).join(' › ')}
        </Badge>
      ))}
      {offering.audience.groups.map((g) => (
        <Badge key={g.id} variant="light" color="grape" size="sm" tt="none">
          {g.unitPath.at(-1) ? `${g.unitPath.at(-1)} · ` : ''}
          {g.name}
        </Badge>
      ))}
    </Group>
  );
}

function OfferingModal({
  offering,
  defaultTermId,
  onClose,
}: {
  offering: Offering | 'new' | null;
  defaultTermId: string | null;
  onClose: () => void;
}) {
  const me = useMe();
  const existing = offering && offering !== 'new' ? offering : null;
  const terms = useTerms();
  const subjects = useSubjects();
  const teachers = useTeachers();
  const structure = useStructure();
  const groups = useGroups();

  const form = useForm({
    initialValues: { termId: '', subjectId: '', facultyIds: [] as string[], unitIds: [] as string[], groupIds: [] as string[] },
    validate: {
      termId: (v) => (v ? null : 'Required'),
      subjectId: (v) => (v ? null : 'Required'),
      unitIds: (v, values) => (v.length + values.groupIds.length > 0 ? null : 'Choose at least one class or batch'),
    },
  });
  useEffect(() => {
    if (!offering) return;
    form.setValues(
      existing
        ? {
            termId: existing.term.id,
            subjectId: existing.subject.id,
            facultyIds: existing.faculty.map((f) => f.id),
            unitIds: existing.audience.units.map((u) => u.id),
            groupIds: existing.audience.groups.map((g) => g.id),
          }
        : { termId: defaultTermId ?? '', subjectId: '', facultyIds: [], unitIds: [], groupIds: [] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offering]);

  // A HOD can only teach to classes inside their department.
  const scopeUnit = me.user.role === 'hod' ? me.staff?.unitId : null;
  const inScope = (unitId: string | null) => !scopeUnit || (!!unitId && structure.pathIds(unitId).includes(scopeUnit));
  const unitOptions = useMemo(
    () => structure.options.filter((o) => inScope(o.value)).map((o) => ({ value: o.value, label: o.label })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure.options, scopeUnit],
  );
  const groupOptions = (groups.data ?? [])
    .filter((g) => inScope(g.unitId))
    .map((g) => ({ value: g.id, label: `${g.name} — ${g.unitPath.join(' › ') || 'institute'}` }));

  const save = useApiMutation(
    async (v: typeof form.values) => {
      const audience = { unitIds: v.unitIds, groupIds: v.groupIds };
      return existing
        ? unwrap(
            await api.PATCH('/v1/offerings/{id}', {
              params: { path: { id: existing.id } },
              body: { facultyIds: v.facultyIds, audience },
            }),
          )
        : unwrap(await api.POST('/v1/offerings/', { body: { termId: v.termId, subjectId: v.subjectId, facultyIds: v.facultyIds, audience } }));
    },
    { invalidate: [['offerings'], ['overview']], success: 'Offering saved' },
  );

  return (
    <Modal opened={!!offering} onClose={onClose} title={existing ? `Edit ${existing.subject.code}` : 'New offering'} size="lg">
      <form onSubmit={form.onSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
        <Stack>
          <Group grow>
            <Select
              label="Term"
              data={(terms.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
              disabled={!!existing}
              {...form.getInputProps('termId')}
            />
            <Select
              label="Subject"
              searchable
              nothingFoundMessage="No subject — add it under Terms & subjects"
              data={(subjects.data ?? []).map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
              disabled={!!existing}
              {...form.getInputProps('subjectId')}
            />
          </Group>
          <MultiSelect
            label="Teachers"
            searchable
            data={(teachers.data ?? []).map((t) => ({ value: t.id, label: `${t.fullName} (${t.username})` }))}
            {...form.getInputProps('facultyIds')}
          />
          <MultiSelect
            label="Whole classes"
            description="Every student in these classes (including the levels below them)"
            searchable
            data={unitOptions}
            {...form.getInputProps('unitIds')}
          />
          <MultiSelect
            label="Batches / groups"
            description="Only the members of these groups, e.g. a lab batch or an elective"
            searchable
            data={groupOptions}
            {...form.getInputProps('groupIds')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RosterModal({ offering, onClose }: { offering: Offering | null; onClose: () => void }) {
  const roster = useQuery({
    queryKey: ['offerings', offering?.id, 'roster'],
    enabled: !!offering,
    queryFn: async () => unwrap(await api.GET('/v1/offerings/{id}/students', { params: { path: { id: offering!.id } } })),
  });
  return (
    <Modal opened={!!offering} onClose={onClose} title={offering ? `${offering.subject.code} — class list` : ''} size="lg">
      <QueryState query={roster}>
        <Text size="sm" c="dimmed" mb="sm">
          {roster.data?.length} active students
        </Text>
        <Table striped verticalSpacing={4} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Roll</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Class</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {roster.data?.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>{s.rollNo ?? '—'}</Table.Td>
                <Table.Td>{s.fullName}</Table.Td>
                <Table.Td c="dimmed">{s.unitPath.join(' › ')}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </QueryState>
    </Modal>
  );
}
