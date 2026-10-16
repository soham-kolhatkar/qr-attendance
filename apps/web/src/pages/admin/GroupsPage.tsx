import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconDots, IconPencil, IconPlus, IconSearch, IconTrash, IconUsers } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { fetchAllPages, useGroups, useStructure } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Group as GroupDto, Student } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { confirmDelete, EmptyHint, PageHeader, QueryState, UnitSelect } from '../../components/common';
import { openFormModal } from '../../components/FormModal';

export function GroupsPage() {
  const me = useMe();
  const structure = useStructure();
  const [unitId, setUnitId] = useState<string | null>(null);
  const groups = useGroups(unitId);
  const [membersOf, setMembersOf] = useState<GroupDto | null>(null);
  const refresh = [['groups'], ['students']];

  const create = useApiMutation(
    async (v: { name: string; kind: string; unitId: string | null }) =>
      unwrap(await api.POST('/v1/groups/', { body: { name: v.name, kind: v.kind || undefined, unitId: v.unitId } })),
    { invalidate: refresh, success: (g) => `Created ${g.name}` },
  );
  const update = useApiMutation(
    async (v: { id: string; name: string; kind: string }) =>
      unwrap(await api.PATCH('/v1/groups/{id}', { params: { path: { id: v.id } }, body: { name: v.name, kind: v.kind } })),
    { invalidate: refresh, success: 'Saved' },
  );
  const remove = useApiMutation(
    async (id: string) => unwrap(await api.DELETE('/v1/groups/{id}', { params: { path: { id } } })),
    { invalidate: refresh, success: 'Group deleted' },
  );

  const openCreate = () => {
    if (!unitId && me.user.role !== 'admin') return;
    const where = unitId ? structure.pathNames(unitId).join(' › ') : 'the whole institute';
    openFormModal({
      title: `New group in ${where}`,
      fields: [
        { name: 'name', label: 'Name', placeholder: 'e.g. A1, ML Elective' },
        { name: 'kind', label: 'Kind', initial: 'batch', description: 'e.g. batch, elective, tutorial' },
      ],
      submitLabel: 'Create',
      onSubmit: (v) => create.mutateAsync({ name: v.name!, kind: v.kind!, unitId }),
    });
  };

  return (
    <>
      <PageHeader
        title="Batches & groups"
        description="Lab batches, electives and other sets of students. A group belongs to a class (e.g. batch A1 in SY Div A) and can only contain students from that class."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={openCreate} disabled={!unitId && me.user.role !== 'admin'}>
            New group
          </Button>
        }
      />
      <UnitSelect
        label="Class"
        placeholder="All classes"
        value={unitId}
        onChange={setUnitId}
        maw={480}
        mb="md"
        description={!unitId && me.user.role !== 'admin' ? 'Choose a class to create a group in it' : undefined}
      />
      <QueryState query={groups}>
        {groups.data?.length === 0 ? (
          <EmptyHint>No groups here yet.</EmptyHint>
        ) : (
          <Table.ScrollContainer minWidth={600}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Class</Table.Th>
                  <Table.Th ta="right">Students</Table.Th>
                  <Table.Th w={1} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.data?.map((g) => (
                  <Table.Tr key={g.id}>
                    <Table.Td fw={500}>{g.name}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="gray">
                        {g.kind}
                      </Badge>
                    </Table.Td>
                    <Table.Td c="dimmed">{g.unitPath.length ? g.unitPath.join(' › ') : 'Whole institute'}</Table.Td>
                    <Table.Td ta="right">{g.memberCount}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button size="xs" variant="light" leftSection={<IconUsers size={14} />} onClick={() => setMembersOf(g)}>
                          Members
                        </Button>
                        <Menu position="bottom-end">
                          <Menu.Target>
                            <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${g.name}`}>
                              <IconDots size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={() =>
                                openFormModal({
                                  title: `Edit ${g.name}`,
                                  fields: [
                                    { name: 'name', label: 'Name', initial: g.name },
                                    { name: 'kind', label: 'Kind', initial: g.kind },
                                  ],
                                  onSubmit: (v) => update.mutateAsync({ id: g.id, name: v.name!, kind: v.kind! }),
                                })
                              }
                            >
                              Edit
                            </Menu.Item>
                            <Menu.Item
                              color="red"
                              leftSection={<IconTrash size={14} />}
                              onClick={() => confirmDelete(`group "${g.name}"`, () => remove.mutate(g.id))}
                            >
                              Delete
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </QueryState>
      <MembersDrawer group={membersOf} onClose={() => setMembersOf(null)} />
    </>
  );
}

/** Tick the students of the group's class who belong to the group. */
function MembersDrawer({ group, onClose }: { group: GroupDto | null; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = useQuery({
    queryKey: ['students', 'in-unit', group?.unitId ?? 'all'],
    enabled: !!group,
    queryFn: () =>
      fetchAllPages<Student>(async (page) =>
        unwrap(
          await api.GET('/v1/students/', {
            params: { query: { unitId: group?.unitId ?? undefined, status: 'active', page, pageSize: 100 } },
          }),
        ),
      ),
  });
  const members = useQuery({
    queryKey: ['groups', group?.id, 'members'],
    enabled: !!group,
    queryFn: async () => unwrap(await api.GET('/v1/groups/{id}/members', { params: { path: { id: group!.id } } })),
  });

  useEffect(() => {
    if (members.data) setSelected(new Set(members.data.map((m) => m.id)));
  }, [members.data]);

  const save = useApiMutation(
    async () => {
      const current = new Set(members.data?.map((m) => m.id));
      const add = [...selected].filter((id) => !current.has(id));
      const remove = [...current].filter((id) => !selected.has(id));
      if (add.length + remove.length === 0) return { memberCount: current.size };
      return unwrap(
        await api.POST('/v1/groups/{id}/members', { params: { path: { id: group!.id } }, body: { add, remove } }),
      );
    },
    { invalidate: [['groups'], ['students']], success: (r) => `${group?.name} now has ${r.memberCount} students` },
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (candidates.data ?? []).filter(
      (s) => !q || s.fullName.toLowerCase().includes(q) || s.username.includes(q) || s.rollNo?.toLowerCase().includes(q),
    );
  }, [candidates.data, search]);

  return (
    <Drawer opened={!!group} onClose={onClose} position="right" size="md" title={group ? `Members of ${group.name}` : ''}>
      {group && (
        <Stack h="calc(100vh - 100px)" gap="sm">
          <Text size="sm" c="dimmed">
            Students of {group.unitPath.length ? group.unitPath.join(' › ') : 'the institute'}. Tick who belongs to {group.name}.
          </Text>
          <TextInput
            placeholder="Search by name, roll no. or username"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
          <Group justify="space-between">
            <Text size="sm">{selected.size} selected</Text>
            <Group gap="xs">
              <Button size="xs" variant="subtle" onClick={() => setSelected(new Set([...selected, ...visible.map((s) => s.id)]))}>
                Select shown
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                onClick={() => setSelected(new Set([...selected].filter((id) => !visible.some((s) => s.id === id))))}
              >
                Clear shown
              </Button>
            </Group>
          </Group>
          <QueryState query={candidates}>
            <ScrollArea flex={1}>
              <Stack gap={6}>
                {visible.map((s) => (
                  <Checkbox
                    key={s.id}
                    checked={selected.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.currentTarget.checked) next.add(s.id);
                      else next.delete(s.id);
                      setSelected(next);
                    }}
                    label={
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm" c="dimmed" w={36}>
                          {s.rollNo ?? '—'}
                        </Text>
                        <Text size="sm">{s.fullName}</Text>
                        <Text size="xs" c="dimmed">
                          {s.unitPath.at(-1)}
                        </Text>
                      </Group>
                    }
                  />
                ))}
                {visible.length === 0 && <EmptyHint>No students found.</EmptyHint>}
              </Stack>
            </ScrollArea>
          </QueryState>
          <Button onClick={() => save.mutate(undefined, { onSuccess: onClose })} loading={save.isPending}>
            Save members
          </Button>
        </Stack>
      )}
    </Drawer>
  );
}
