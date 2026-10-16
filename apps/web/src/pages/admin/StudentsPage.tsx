import {
  Badge,
  Button,
  Divider,
  Drawer,
  Group,
  Modal,
  MultiSelect,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { IconLock, IconLockOpen, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useGroups, useStructure } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Student } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { EmptyHint, PageHeader, QueryState, showTemporaryPassword, UnitSelect } from '../../components/common';

const PAGE_SIZE = 50;

/** Groups a student in `unitId` may join: those anchored at that unit or above it. */
function useGroupOptionsFor(unitId: string | null) {
  const structure = useStructure();
  const groups = useGroups();
  if (!unitId) return [];
  const ancestors = new Set(structure.pathIds(unitId));
  return (groups.data ?? [])
    .filter((g) => g.unitId === null || ancestors.has(g.unitId))
    .map((g) => ({ value: g.id, label: `${g.name} (${g.kind})` }));
}

export function StudentsPage() {
  const me = useMe();
  const canEdit = me.user.role === 'admin';
  const [unitId, setUnitId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>('active');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Student | null>(null);
  const [creating, setCreating] = useState(false);
  const groups = useGroups(unitId);

  useEffect(() => setPage(1), [unitId, groupId, status, q]);

  const students = useQuery({
    queryKey: ['students', { unitId, groupId, status, q, page }],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/students/', {
          params: {
            query: {
              unitId: unitId ?? undefined,
              groupId: groupId ?? undefined,
              status: (status as 'active' | 'disabled' | null) ?? undefined,
              q: q || undefined,
              page,
              pageSize: PAGE_SIZE,
            },
          },
        }),
      ),
  });

  return (
    <>
      <PageHeader
        title="Students"
        description={canEdit ? 'Add students one by one here, or many at once from Excel under Import.' : 'Students in your department.'}
        actions={
          canEdit && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              Add student
            </Button>
          )
        }
      />
      <Group mb="md" align="flex-end" wrap="wrap">
        <UnitSelect label="Class" placeholder="All classes" value={unitId} onChange={(v) => { setUnitId(v); setGroupId(null); }} w={320} />
        <Select
          label="Batch / group"
          placeholder="Any"
          clearable
          searchable
          data={(groups.data ?? []).map((g) => ({ value: g.id, label: `${g.name} — ${g.unitPath.at(-1) ?? 'institute'}` }))}
          value={groupId}
          onChange={setGroupId}
          w={220}
        />
        <Select
          label="Status"
          data={[
            { value: 'active', label: 'Active' },
            { value: 'disabled', label: 'Disabled' },
          ]}
          clearable
          placeholder="Any"
          value={status}
          onChange={setStatus}
          w={130}
        />
        <TextInput
          label="Search"
          placeholder="Name, roll no. or username"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          flex={1}
          miw={200}
        />
      </Group>

      <QueryState query={students}>
        {students.data && students.data.items.length === 0 ? (
          <EmptyHint>No students match.</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={760}>
              <Table highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={70}>Roll</Table.Th>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Username</Table.Th>
                    <Table.Th>Class</Table.Th>
                    <Table.Th>Groups</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {students.data?.items.map((s) => (
                    <Table.Tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(s)}>
                      <Table.Td>{s.rollNo ?? '—'}</Table.Td>
                      <Table.Td fw={500}>{s.fullName}</Table.Td>
                      <Table.Td c="dimmed">{s.username}</Table.Td>
                      <Table.Td>{s.unitPath.join(' › ')}</Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {s.groups.map((g) => (
                            <Badge key={g.id} size="sm" variant="light">
                              {g.name}
                            </Badge>
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color={s.status === 'active' ? 'teal' : 'gray'} variant="light">
                          {s.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {students.data?.total.toLocaleString()} students
              </Text>
              <Pagination total={Math.ceil((students.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>

      {canEdit && <CreateStudentModal opened={creating} onClose={() => setCreating(false)} defaultUnitId={unitId} />}
      <StudentDrawer student={editing} canEdit={canEdit} onClose={() => setEditing(null)} />
    </>
  );
}

function CreateStudentModal({ opened, onClose, defaultUnitId }: { opened: boolean; onClose: () => void; defaultUnitId: string | null }) {
  const form = useForm({
    initialValues: { username: '', fullName: '', email: '', phone: '', rollNo: '', unitId: defaultUnitId, groupIds: [] as string[] },
    validate: {
      username: (v) => (/^[a-zA-Z0-9._@-]{3,64}$/.test(v.trim()) ? null : '3–64 letters, digits or . _ @ -'),
      fullName: (v) => (v.trim() ? null : 'Required'),
      unitId: (v) => (v ? null : 'Choose the class'),
    },
  });
  useEffect(() => {
    if (opened) form.setValues({ unitId: defaultUnitId, groupIds: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  const groupOptions = useGroupOptionsFor(form.values.unitId);

  const create = useApiMutation(
    async (v: typeof form.values) =>
      unwrap(
        await api.POST('/v1/students/', {
          body: {
            username: v.username.trim(),
            fullName: v.fullName.trim(),
            email: v.email.trim() || undefined,
            phone: v.phone.trim() || undefined,
            rollNo: v.rollNo.trim() || undefined,
            unitId: v.unitId!,
            groupIds: v.groupIds,
          },
        }),
      ),
    { invalidate: [['students'], ['structure'], ['groups'], ['overview']] },
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Add student" size="lg">
      <form
        onSubmit={form.onSubmit((v) =>
          create.mutate(v, {
            onSuccess: (res) => {
              onClose();
              form.reset();
              if (res.temporaryPassword) showTemporaryPassword(res.student.fullName, res.temporaryPassword);
            },
          }),
        )}
      >
        <Stack>
          <Group grow>
            <TextInput label="Username" description="Usually the enrollment number" {...form.getInputProps('username')} />
            <TextInput label="Roll no." {...form.getInputProps('rollNo')} />
          </Group>
          <TextInput label="Full name" {...form.getInputProps('fullName')} />
          <Group grow>
            <TextInput label="Email" {...form.getInputProps('email')} />
            <TextInput label="Phone" {...form.getInputProps('phone')} />
          </Group>
          <UnitSelect label="Class" {...form.getInputProps('unitId')} onChange={(v) => form.setValues({ unitId: v, groupIds: [] })} />
          <MultiSelect label="Batches / groups" data={groupOptions} disabled={!form.values.unitId} {...form.getInputProps('groupIds')} />
          <Text size="xs" c="dimmed">
            A temporary password is created and shown once. The student chooses their own at first sign-in.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add student
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function StudentDrawer({ student, canEdit, onClose }: { student: Student | null; canEdit: boolean; onClose: () => void }) {
  const form = useForm({
    initialValues: { fullName: '', email: '', phone: '', rollNo: '', unitId: null as string | null, groupIds: [] as string[] },
  });
  useEffect(() => {
    if (student) {
      form.setValues({
        fullName: student.fullName,
        email: student.email ?? '',
        phone: student.phone ?? '',
        rollNo: student.rollNo ?? '',
        unitId: student.unitId,
        groupIds: student.groups.map((g) => g.id),
      });
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);
  const groupOptions = useGroupOptionsFor(form.values.unitId);
  const refresh = [['students'], ['groups'], ['structure']];

  const save = useApiMutation(
    async (v: typeof form.values) => {
      const id = student!.id;
      if (v.fullName !== student!.fullName || v.email !== (student!.email ?? '') || v.phone !== (student!.phone ?? '')) {
        unwrap(
          await api.PATCH('/v1/users/{id}', {
            params: { path: { id } },
            body: { fullName: v.fullName.trim(), email: v.email.trim() || null, phone: v.phone.trim() || null },
          }),
        );
      }
      return unwrap(
        await api.PATCH('/v1/students/{id}', {
          params: { path: { id } },
          body: { unitId: v.unitId ?? undefined, rollNo: v.rollNo.trim() || null, groupIds: v.groupIds },
        }),
      );
    },
    { invalidate: refresh, success: 'Student saved' },
  );
  const setStatus = useApiMutation(
    async (status: 'active' | 'disabled') =>
      unwrap(await api.PATCH('/v1/users/{id}', { params: { path: { id: student!.id } }, body: { status } })),
    { invalidate: refresh, success: (u) => (u.status === 'active' ? 'Account enabled' : 'Account disabled') },
  );
  const resetPassword = useApiMutation(
    async () => unwrap(await api.POST('/v1/users/{id}/reset-password', { params: { path: { id: student!.id } } })),
  );

  return (
    <Drawer opened={!!student} onClose={onClose} position="right" size="md" title={student?.fullName}>
      {student && (
        <form onSubmit={form.onSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
          <Stack>
            <Text size="sm" c="dimmed">
              Username <b>{student.username}</b>
            </Text>
            <TextInput label="Full name" readOnly={!canEdit} {...form.getInputProps('fullName')} />
            <Group grow>
              <TextInput label="Email" readOnly={!canEdit} {...form.getInputProps('email')} />
              <TextInput label="Phone" readOnly={!canEdit} {...form.getInputProps('phone')} />
            </Group>
            <Group grow align="flex-start">
              <UnitSelect
                label="Class"
                clearable={false}
                readOnly={!canEdit}
                {...form.getInputProps('unitId')}
                onChange={(v) => {
                  // Batches of the old class don't apply in the new one.
                  const allowed = new Set(groupOptions.map((g) => g.value));
                  form.setValues({ unitId: v, groupIds: form.values.groupIds.filter((g) => allowed.has(g)) });
                }}
              />
              <TextInput label="Roll no." readOnly={!canEdit} maw={120} {...form.getInputProps('rollNo')} />
            </Group>
            <MultiSelect label="Batches / groups" data={groupOptions} readOnly={!canEdit} {...form.getInputProps('groupIds')} />
            {canEdit && (
              <>
                <Button type="submit" loading={save.isPending} disabled={!form.isDirty()}>
                  Save changes
                </Button>
                <Divider label="Account" labelPosition="left" />
                <Group>
                  <Button
                    variant="light"
                    leftSection={<IconRefresh size={16} />}
                    loading={resetPassword.isPending}
                    onClick={() =>
                      resetPassword.mutate(undefined, {
                        onSuccess: (r) => showTemporaryPassword(student.fullName, r.temporaryPassword),
                      })
                    }
                  >
                    Reset password
                  </Button>
                  {student.status === 'active' ? (
                    <Button variant="light" color="red" leftSection={<IconLock size={16} />} loading={setStatus.isPending} onClick={() => setStatus.mutate('disabled', { onSuccess: onClose })}>
                      Disable account
                    </Button>
                  ) : (
                    <Button variant="light" color="teal" leftSection={<IconLockOpen size={16} />} loading={setStatus.isPending} onClick={() => setStatus.mutate('active', { onSuccess: onClose })}>
                      Enable account
                    </Button>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  Disabling signs the student out everywhere and removes them from future class lists.
                </Text>
              </>
            )}
          </Stack>
        </form>
      )}
    </Drawer>
  );
}
