import { Alert, Badge, Card, Group, Stack, Table, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { useMe } from '../../auth/AuthContext';
import { PageHeader } from '../../components/common';
import { ROLE_LABELS } from '../../lib/format';

export function ProfilePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="My profile" />
      <Stack maw={640}>
        {me.user.role === 'student' && (
          <Alert icon={<IconDeviceMobile />} color="indigo" title="Marking attendance">
            Use the QR Attendance app on your phone and scan the code your teacher shows in class.
          </Alert>
        )}
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
