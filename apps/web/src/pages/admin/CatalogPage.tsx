import { ActionIcon, Button, Group, Modal, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useStructure, useSubjects, useTerms } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Subject, Term } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { confirmDelete, EmptyHint, PageHeader, QueryState, UnitSelect } from '../../components/common';
import { formatDate } from '../../lib/format';

export function CatalogPage() {
  return (
    <>
      <PageHeader title="Terms & subjects" description="Semesters and the subjects taught. Offerings link a subject to a class and its teachers for one term." />
      <Tabs defaultValue="subjects">
        <Tabs.List mb="md">
          <Tabs.Tab value="subjects">Subjects</Tabs.Tab>
          <Tabs.Tab value="terms">Terms</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="subjects">
          <SubjectsTab />
        </Tabs.Panel>
        <Tabs.Panel value="terms">
          <TermsTab />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function TermsTab() {
  const me = useMe();
  const canEdit = me.user.role === 'admin';
  const terms = useTerms();
  const [editing, setEditing] = useState<Term | 'new' | null>(null);
  const remove = useApiMutation(async (id: string) => unwrap(await api.DELETE('/v1/terms/{id}', { params: { path: { id } } })), {
    invalidate: [['terms'], ['overview']],
    success: 'Term deleted',
  });

  return (
    <Stack maw={800}>
      {canEdit && (
        <Group>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            Add term
          </Button>
        </Group>
      )}
      <QueryState query={terms}>
        {terms.data?.length === 0 ? (
          <EmptyHint>No terms yet. Add the current semester, e.g. “2026-27 Odd Semester”.</EmptyHint>
        ) : (
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Starts</Table.Th>
                <Table.Th>Ends</Table.Th>
                {canEdit && <Table.Th w={1} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {terms.data?.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td fw={500}>{t.name}</Table.Td>
                  <Table.Td>{formatDate(t.startsOn)}</Table.Td>
                  <Table.Td>{formatDate(t.endsOn)}</Table.Td>
                  {canEdit && (
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <ActionIcon variant="subtle" color="gray" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                          <IconPencil size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" onClick={() => confirmDelete(`term "${t.name}"`, () => remove.mutate(t.id))} aria-label={`Delete ${t.name}`}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </QueryState>
      <TermModal term={editing} onClose={() => setEditing(null)} />
    </Stack>
  );
}

function TermModal({ term, onClose }: { term: Term | 'new' | null; onClose: () => void }) {
  const existing = term && term !== 'new' ? term : null;
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { name: existing?.name ?? '', startsOn: existing?.startsOn ?? '', endsOn: existing?.endsOn ?? '' },
    validate: {
      name: (v) => (v.trim() ? null : 'Required'),
      startsOn: (v) => (v ? null : 'Required'),
      endsOn: (v, values) => (!v ? 'Required' : v < values.startsOn ? 'Must be after the start' : null),
    },
  });
  const save = useApiMutation(
    async (v: { name: string; startsOn: string; endsOn: string }) =>
      existing
        ? unwrap(await api.PATCH('/v1/terms/{id}', { params: { path: { id: existing.id } }, body: v }))
        : unwrap(await api.POST('/v1/terms/', { body: v })),
    { invalidate: [['terms'], ['overview']], success: 'Term saved' },
  );
  return (
    <Modal opened={!!term} onClose={onClose} title={existing ? 'Edit term' : 'Add term'} key={existing?.id ?? 'new'}>
      <form onSubmit={form.onSubmit((v) => save.mutate({ ...v, name: v.name.trim() }, { onSuccess: onClose }))}>
        <Stack>
          <TextInput label="Name" placeholder="e.g. 2026-27 Odd Semester" key={form.key('name')} {...form.getInputProps('name')} />
          <Group grow>
            <TextInput type="date" label="Starts" key={form.key('startsOn')} {...form.getInputProps('startsOn')} />
            <TextInput type="date" label="Ends" key={form.key('endsOn')} {...form.getInputProps('endsOn')} />
          </Group>
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

function SubjectsTab() {
  const structure = useStructure();
  const subjects = useSubjects();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Subject | 'new' | null>(null);
  const remove = useApiMutation(async (id: string) => unwrap(await api.DELETE('/v1/subjects/{id}', { params: { path: { id } } })), {
    invalidate: [['subjects'], ['overview']],
    success: 'Subject deleted',
  });
  const q = search.trim().toLowerCase();
  const rows = (subjects.data ?? []).filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));

  return (
    <Stack>
      <Group>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
          Add subject
        </Button>
        <TextInput
          placeholder="Search code or name"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={280}
        />
      </Group>
      <QueryState query={subjects}>
        {rows.length === 0 ? (
          <EmptyHint>No subjects{q ? ' match' : ' yet'}.</EmptyHint>
        ) : (
          <Table.ScrollContainer minWidth={600}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={120}>Code</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Department</Table.Th>
                  <Table.Th w={1} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td fw={600}>{s.code}</Table.Td>
                    <Table.Td>{s.name}</Table.Td>
                    <Table.Td c="dimmed">{s.unitId ? structure.pathNames(s.unitId).join(' › ') : '—'}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <ActionIcon variant="subtle" color="gray" onClick={() => setEditing(s)} aria-label={`Edit ${s.code}`}>
                          <IconPencil size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" onClick={() => confirmDelete(`subject ${s.code}`, () => remove.mutate(s.id))} aria-label={`Delete ${s.code}`}>
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
      <SubjectModal subject={editing} onClose={() => setEditing(null)} />
    </Stack>
  );
}

function SubjectModal({ subject, onClose }: { subject: Subject | 'new' | null; onClose: () => void }) {
  const existing = subject && subject !== 'new' ? subject : null;
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { code: existing?.code ?? '', name: existing?.name ?? '', unitId: existing?.unitId ?? (null as string | null) },
    validate: { code: (v) => (v.trim() ? null : 'Required'), name: (v) => (v.trim() ? null : 'Required') },
  });
  const save = useApiMutation(
    async (v: { code: string; name: string; unitId: string | null }) =>
      existing
        ? unwrap(await api.PATCH('/v1/subjects/{id}', { params: { path: { id: existing.id } }, body: v }))
        : unwrap(await api.POST('/v1/subjects/', { body: v })),
    { invalidate: [['subjects'], ['overview']], success: 'Subject saved' },
  );
  return (
    <Modal opened={!!subject} onClose={onClose} title={existing ? `Edit ${existing.code}` : 'Add subject'} key={existing?.id ?? 'new'}>
      <form onSubmit={form.onSubmit((v) => save.mutate({ ...v, code: v.code.trim(), name: v.name.trim() }, { onSuccess: onClose }))}>
        <Stack>
          <Group grow>
            <TextInput label="Code" placeholder="e.g. CS301" key={form.key('code')} {...form.getInputProps('code')} />
          </Group>
          <TextInput label="Name" placeholder="e.g. Data Structures" key={form.key('name')} {...form.getInputProps('name')} />
          <UnitSelect label="Department" description="Which department owns this subject" maxDepth={1} key={form.key('unitId')} {...form.getInputProps('unitId')} />
          <Text size="xs" c="dimmed">
            HODs can manage subjects of their own department.
          </Text>
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
