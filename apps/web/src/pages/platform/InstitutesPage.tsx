import { Badge, Button, Group, Modal, Stack, Table, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api/client';
import { fetchAllPages } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Institute } from '../../api/types';
import { EmptyHint, PageHeader, QueryState, showTemporaryPassword } from '../../components/common';
import { formatDate } from '../../lib/format';

/** For the platform owner: onboard client institutes and suspend/restore them. */
export function InstitutesPage() {
  const [creating, setCreating] = useState(false);
  const institutes = useQuery({
    queryKey: ['institutes'],
    queryFn: () =>
      fetchAllPages<Institute>(async (page) =>
        unwrap(await api.GET('/v1/platform/institutes', { params: { query: { page, pageSize: 100 } } })),
      ),
  });
  const setStatus = useApiMutation(
    async (v: { id: string; status: 'active' | 'suspended' }) =>
      unwrap(await api.PATCH('/v1/platform/institutes/{id}', { params: { path: { id: v.id } }, body: { status: v.status } })),
    { invalidate: [['institutes']], success: (i) => `${i.name} is now ${i.status}` },
  );

  const confirmStatus = (i: Institute) => {
    const suspend = i.status === 'active';
    modals.openConfirmModal({
      title: `${suspend ? 'Suspend' : 'Restore'} ${i.name}?`,
      children: (
        <Text size="sm">
          {suspend
            ? 'Everyone at this institute is signed out immediately and cannot sign in until it is restored. No data is deleted.'
            : 'Everyone at this institute can sign in again.'}
        </Text>
      ),
      labels: { confirm: suspend ? 'Suspend' : 'Restore', cancel: 'Cancel' },
      confirmProps: { color: suspend ? 'red' : 'teal' },
      onConfirm: () => setStatus.mutate({ id: i.id, status: suspend ? 'suspended' : 'active' }),
    });
  };

  return (
    <>
      <PageHeader
        title="Institutes"
        description="Each institute is a separate customer with its own data. Its admin sets up everything else."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Onboard institute
          </Button>
        }
      />
      <QueryState query={institutes}>
        {institutes.data?.length === 0 ? (
          <EmptyHint>No institutes yet.</EmptyHint>
        ) : (
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Code</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Since</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th w={1} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {institutes.data?.map((i) => (
                <Table.Tr key={i.id}>
                  <Table.Td fw={600}>{i.code}</Table.Td>
                  <Table.Td>{i.name}</Table.Td>
                  <Table.Td c="dimmed">{formatDate(i.createdAt)}</Table.Td>
                  <Table.Td>
                    <Badge color={i.status === 'active' ? 'teal' : 'red'} variant="light">
                      {i.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Button size="xs" variant="subtle" color={i.status === 'active' ? 'red' : 'teal'} onClick={() => confirmStatus(i)}>
                      {i.status === 'active' ? 'Suspend' : 'Restore'}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </QueryState>
      <OnboardModal opened={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function OnboardModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const form = useForm({
    initialValues: { code: '', name: '', adminUsername: 'admin', adminName: '', adminEmail: '' },
    validate: {
      code: (v) => (/^[A-Za-z0-9-]{2,20}$/.test(v.trim()) ? null : '2–20 letters, digits or hyphens'),
      name: (v) => (v.trim().length >= 2 ? null : 'Required'),
      adminUsername: (v) => (/^[a-zA-Z0-9._@-]{3,64}$/.test(v.trim()) ? null : '3–64 letters, digits or . _ @ -'),
      adminName: (v) => (v.trim() ? null : 'Required'),
    },
  });
  const create = useApiMutation(
    async (v: typeof form.values) =>
      unwrap(
        await api.POST('/v1/platform/institutes', {
          body: {
            code: v.code.trim(),
            name: v.name.trim(),
            admin: { username: v.adminUsername.trim(), fullName: v.adminName.trim(), email: v.adminEmail.trim() || undefined },
          },
        }),
      ),
    { invalidate: [['institutes']] },
  );
  return (
    <Modal opened={opened} onClose={onClose} title="Onboard an institute" size="lg">
      <form
        onSubmit={form.onSubmit((v) =>
          create.mutate(v, {
            onSuccess: (res) => {
              onClose();
              form.reset();
              if (res.temporaryPassword) {
                showTemporaryPassword(`${res.admin.fullName} (institute code ${res.institute.code}, username ${res.admin.username})`, res.temporaryPassword);
              }
            },
          }),
        )}
      >
        <Stack>
          <Group grow align="flex-start">
            <TextInput label="Institute code" description="Typed at every sign-in, keep it short" placeholder="e.g. VJTI" {...form.getInputProps('code')} />
            <TextInput label="Name" placeholder="Full institute name" {...form.getInputProps('name')} />
          </Group>
          <Text fw={500} size="sm" mt="xs">
            First administrator
          </Text>
          <Group grow>
            <TextInput label="Username" {...form.getInputProps('adminUsername')} />
            <TextInput label="Full name" {...form.getInputProps('adminName')} />
          </Group>
          <TextInput label="Email (optional)" {...form.getInputProps('adminEmail')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create institute
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
