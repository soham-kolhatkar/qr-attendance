import {
  Badge,
  Button,
  Divider,
  Drawer,
  Group,
  Modal,
  Pagination,
  PasswordInput,
  SegmentedControl,
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
import { useStructure } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { ManagedUser } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { EmptyHint, PageHeader, QueryState, showTemporaryPassword, UnitSelect } from '../../components/common';
import { formatDateTime, ROLE_LABELS } from '../../lib/format';

type StaffRole = 'faculty' | 'hod' | 'admin';
const PAGE_SIZE = 50;
const ROLE_OPTIONS = [
  { value: 'faculty', label: 'Faculty' },
  { value: 'hod', label: 'HOD' },
  { value: 'admin', label: 'Admin' },
];

export function StaffPage() {
  const structure = useStructure();
  const [role, setRole] = useState<StaffRole>('faculty');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => setPage(1), [role, q]);

  const staff = useQuery({
    queryKey: ['users', { role, q, page }],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await api.GET('/v1/users/', { params: { query: { role, q: q || undefined, page, pageSize: PAGE_SIZE } } })),
  });

  return (
    <>
      <PageHeader
        title="Staff"
        description="Teachers, HODs and admins. A HOD manages the department they are assigned to."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Add staff
          </Button>
        }
      />
      <Group mb="md" wrap="wrap">
        <SegmentedControl data={ROLE_OPTIONS} value={role} onChange={(v) => setRole(v as StaffRole)} />
        <TextInput
          placeholder="Search name, username or email"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          flex={1}
          miw={220}
        />
      </Group>
      <QueryState query={staff}>
        {staff.data?.items.length === 0 ? (
          <EmptyHint>No {ROLE_LABELS[role]?.toLowerCase()} accounts yet.</EmptyHint>
        ) : (
          <>
            <Table.ScrollContainer minWidth={700}>
              <Table highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Username</Table.Th>
                    <Table.Th>Department</Table.Th>
                    <Table.Th>Designation</Table.Th>
                    <Table.Th>Last sign-in</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {staff.data?.items.map((u) => (
                    <Table.Tr key={u.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(u)}>
                      <Table.Td fw={500}>{u.fullName}</Table.Td>
                      <Table.Td c="dimmed">{u.username}</Table.Td>
                      <Table.Td>{u.unitId ? structure.pathNames(u.unitId).join(' › ') : '—'}</Table.Td>
                      <Table.Td>{u.designation ?? '—'}</Table.Td>
                      <Table.Td c="dimmed">{formatDateTime(u.lastLoginAt)}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={u.status === 'active' ? 'teal' : 'gray'}>
                          {u.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {staff.data?.total} accounts
              </Text>
              <Pagination total={Math.ceil((staff.data?.total ?? 0) / PAGE_SIZE)} value={page} onChange={setPage} size="sm" />
            </Group>
          </>
        )}
      </QueryState>
      <CreateStaffModal opened={creating} onClose={() => setCreating(false)} defaultRole={role} />
      <StaffDrawer user={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function CreateStaffModal({ opened, onClose, defaultRole }: { opened: boolean; onClose: () => void; defaultRole: StaffRole }) {
  const form = useForm({
    initialValues: {
      role: defaultRole as string,
      username: '',
      fullName: '',
      email: '',
      phone: '',
      designation: '',
      unitId: null as string | null,
      password: '',
    },
    validate: {
      username: (v) => (/^[a-zA-Z0-9._@-]{3,64}$/.test(v.trim()) ? null : '3–64 letters, digits or . _ @ -'),
      fullName: (v) => (v.trim() ? null : 'Required'),
      unitId: (v, values) => (values.role === 'hod' && !v ? 'A HOD needs the department they manage' : null),
      password: (v) => (v === '' || v.length >= 8 ? null : 'At least 8 characters, or leave empty'),
    },
  });
  useEffect(() => {
    if (opened) form.setFieldValue('role', defaultRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const create = useApiMutation(
    async (v: typeof form.values) =>
      unwrap(
        await api.POST('/v1/users/', {
          body: {
            role: v.role as StaffRole,
            username: v.username.trim(),
            fullName: v.fullName.trim(),
            email: v.email.trim() || undefined,
            phone: v.phone.trim() || undefined,
            designation: v.designation.trim() || undefined,
            unitId: v.unitId ?? undefined,
            password: v.password || undefined,
          },
        }),
      ),
    { invalidate: [['users'], ['overview']] },
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Add staff member" size="lg">
      <form
        onSubmit={form.onSubmit((v) =>
          create.mutate(v, {
            onSuccess: (res) => {
              onClose();
              form.reset();
              if (res.temporaryPassword) showTemporaryPassword(res.user.fullName, res.temporaryPassword);
            },
          }),
        )}
      >
        <Stack>
          <SegmentedControl data={ROLE_OPTIONS} {...form.getInputProps('role')} />
          <Group grow>
            <TextInput label="Username" description="Employee ID or email" {...form.getInputProps('username')} />
            <TextInput label="Full name" {...form.getInputProps('fullName')} />
          </Group>
          <Group grow>
            <TextInput label="Email" {...form.getInputProps('email')} />
            <TextInput label="Phone" {...form.getInputProps('phone')} />
          </Group>
          <Group grow align="flex-start">
            <UnitSelect
              label="Department"
              description={form.values.role === 'hod' ? 'The part of the institute this HOD manages' : 'Optional'}
              maxDepth={1}
              {...form.getInputProps('unitId')}
            />
            <TextInput label="Designation" placeholder="e.g. Assistant Professor" {...form.getInputProps('designation')} />
          </Group>
          <PasswordInput
            label="Password (optional)"
            description="Leave empty to create a temporary password that is shown once"
            {...form.getInputProps('password')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function StaffDrawer({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const me = useMe();
  const isSelf = user?.id === me.user.id;
  const form = useForm({
    initialValues: { fullName: '', email: '', phone: '', role: 'faculty', unitId: null as string | null, designation: '' },
    validate: { unitId: (v, values) => (values.role === 'hod' && !v ? 'A HOD needs the department they manage' : null) },
  });
  useEffect(() => {
    if (user) {
      form.setValues({
        fullName: user.fullName,
        email: user.email ?? '',
        phone: user.phone ?? '',
        role: user.role,
        unitId: user.unitId,
        designation: user.designation ?? '',
      });
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const refresh = [['users'], ['overview']];
  const save = useApiMutation(
    async (v: typeof form.values) =>
      unwrap(
        await api.PATCH('/v1/users/{id}', {
          params: { path: { id: user!.id } },
          body: {
            fullName: v.fullName.trim(),
            email: v.email.trim() || null,
            phone: v.phone.trim() || null,
            ...(isSelf ? {} : { role: v.role as StaffRole }),
            unitId: v.unitId,
            designation: v.designation.trim() || null,
          },
        }),
      ),
    { invalidate: refresh, success: 'Saved' },
  );
  const setStatus = useApiMutation(
    async (status: 'active' | 'disabled') =>
      unwrap(await api.PATCH('/v1/users/{id}', { params: { path: { id: user!.id } }, body: { status } })),
    { invalidate: refresh, success: (u) => (u.status === 'active' ? 'Account enabled' : 'Account disabled') },
  );
  const resetPassword = useApiMutation(
    async () => unwrap(await api.POST('/v1/users/{id}/reset-password', { params: { path: { id: user!.id } } })),
  );

  return (
    <Drawer opened={!!user} onClose={onClose} position="right" size="md" title={user?.fullName}>
      {user && (
        <form onSubmit={form.onSubmit((v) => save.mutate(v, { onSuccess: onClose }))}>
          <Stack>
            <Text size="sm" c="dimmed">
              Username <b>{user.username}</b>
            </Text>
            <TextInput label="Full name" {...form.getInputProps('fullName')} />
            <Group grow>
              <TextInput label="Email" {...form.getInputProps('email')} />
              <TextInput label="Phone" {...form.getInputProps('phone')} />
            </Group>
            <Select
              label="Role"
              data={ROLE_OPTIONS}
              disabled={isSelf}
              description={isSelf ? 'You cannot change your own role' : undefined}
              {...form.getInputProps('role')}
            />
            <UnitSelect label="Department" maxDepth={1} {...form.getInputProps('unitId')} />
            <TextInput label="Designation" {...form.getInputProps('designation')} />
            <Button type="submit" loading={save.isPending} disabled={!form.isDirty()}>
              Save changes
            </Button>
            <Divider label="Account" labelPosition="left" />
            <Group>
              <Button
                variant="light"
                leftSection={<IconRefresh size={16} />}
                loading={resetPassword.isPending}
                onClick={() => resetPassword.mutate(undefined, { onSuccess: (r) => showTemporaryPassword(user.fullName, r.temporaryPassword) })}
              >
                Reset password
              </Button>
              {!isSelf &&
                (user.status === 'active' ? (
                  <Button variant="light" color="red" leftSection={<IconLock size={16} />} onClick={() => setStatus.mutate('disabled', { onSuccess: onClose })}>
                    Disable account
                  </Button>
                ) : (
                  <Button variant="light" color="teal" leftSection={<IconLockOpen size={16} />} onClick={() => setStatus.mutate('active', { onSuccess: onClose })}>
                    Enable account
                  </Button>
                ))}
            </Group>
          </Stack>
        </form>
      )}
    </Drawer>
  );
}
