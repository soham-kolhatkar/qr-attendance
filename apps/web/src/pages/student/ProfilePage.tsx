import { Alert, Badge, Card, Group, Stack, Table, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api/client';
import { useMe } from '../../auth/AuthContext';
import { PageHeader } from '../../components/common';
import { formatDate, ROLE_LABELS } from '../../lib/format';

export function ProfilePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="My profile" />
      <Stack maw={640}>
        {me.user.role === 'student' && <MyPhone />}
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
