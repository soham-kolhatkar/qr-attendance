import {
  Alert,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Select,
  type SelectProps,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconAlertCircle, IconCheck, IconCopy } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { useStructure } from '../api/hooks';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="wrap" gap="sm">
      <div>
        <Title order={2}>{title}</Title>
        {description && (
          <Text c="dimmed" size="sm" mt={4} maw={720}>
            {description}
          </Text>
        )}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/** Loading spinner / error box / content, for a query's states. */
export function QueryState({
  query,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: ReactNode;
}) {
  if (query.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (query.isError) {
    return (
      <Alert color="red" icon={<IconAlertCircle />} title="Could not load">
        <Stack gap="xs" align="flex-start">
          <Text size="sm">{errorMessage(query.error)}</Text>
          <Button size="xs" variant="light" color="red" onClick={() => query.refetch()}>
            Try again
          </Button>
        </Stack>
      </Alert>
    );
  }
  return <>{children}</>;
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <Text c="dimmed" ta="center" py="xl" size="sm">
      {children}
    </Text>
  );
}

/** Pick a unit (class) from the institute structure, shown as its full path. */
export function UnitSelect({
  maxDepth,
  ...props
}: Omit<SelectProps, 'data'> & { maxDepth?: number }) {
  const structure = useStructure();
  const data = structure.options
    .filter((o) => maxDepth === undefined || o.depth <= maxDepth)
    .map((o) => ({ value: o.value, label: o.label }));
  return <Select searchable clearable nothingFoundMessage="No match" {...props} data={data} />;
}

export function confirmDelete(what: string, onConfirm: () => unknown) {
  modals.openConfirmModal({
    title: `Delete ${what}?`,
    children: <Text size="sm">This cannot be undone.</Text>,
    labels: { confirm: 'Delete', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}

/** Shows a one-time temporary password with a copy button. */
export function showTemporaryPassword(name: string, password: string) {
  modals.open({
    title: 'Temporary password',
    children: (
      <Stack>
        <Text size="sm">
          Give this password to <b>{name}</b>. It is shown only once; they will be asked to choose their own
          password when they sign in.
        </Text>
        <Group>
          <Code fz="lg" px="md" py={6}>
            {password}
          </Code>
          <CopyButton value={password}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" onClick={copy} leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Button onClick={() => modals.closeAll()}>Done</Button>
      </Stack>
    ),
  });
}
