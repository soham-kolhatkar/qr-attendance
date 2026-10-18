import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Menu,
  Modal,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconBook,
  IconCheck,
  IconCopy,
  IconDots,
  IconKey,
  IconPlus,
  IconSend,
  IconWebhook,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { API_URL, api, unwrap } from '../../api/client';
import { useApiMutation } from '../../api/mutations';
import type { ApiKey, ApiScope, WebhookEndpoint, WebhookEvent } from '../../api/types';
import { EmptyHint, PageHeader, QueryState } from '../../components/common';
import { formatAgo, formatDate, formatDateTime } from '../../lib/format';
import { DeliveriesDrawer } from './WebhookDeliveries';

export const DOCS_URL = `${API_URL}/docs/integration`;

const SCOPES: { value: ApiScope; label: string; description: string }[] = [
  { value: 'attendance:read', label: 'Read attendance', description: 'Sessions, marks, the change feeds and reports' },
  { value: 'students:read', label: 'Read students', description: 'List and look up students' },
  { value: 'students:write', label: 'Update students', description: 'Create and update students, also in bulk' },
  { value: 'academic:read', label: 'Read classes and subjects', description: 'Structure, batches, terms, subjects, offerings' },
  { value: 'staff:read', label: 'Read staff', description: 'The staff directory' },
  { value: 'staff:write', label: 'Update staff', description: 'Create and update faculty and HODs in bulk (never admins)' },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.value, s.label])) as Record<ApiScope, string>;

const EVENTS: { value: WebhookEvent; label: string; description: string }[] = [
  { value: 'attendance.recorded', label: 'Attendance recorded', description: 'A student scans, or a mark is changed by hand' },
  { value: 'session.closed', label: 'Session closed', description: 'Scanning ends, with every student’s mark' },
  { value: 'session.started', label: 'Session started', description: 'A teacher starts taking attendance' },
  { value: 'session.cancelled', label: 'Session cancelled', description: 'A session no longer counts' },
];

/** Connecting the institute's own systems: API keys for them to call us, webhooks for us to call them. */
export function IntegrationsPage() {
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect your own systems, such as your ERP: they read attendance and keep students and staff in step with an API key, and hear about attendance as it happens through webhooks."
        actions={
          <Button component="a" href={DOCS_URL} target="_blank" rel="noreferrer" variant="light" leftSection={<IconBook size={16} />}>
            Developer docs
          </Button>
        }
      />
      <Tabs defaultValue="keys" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="keys" leftSection={<IconKey size={16} />}>
            API keys
          </Tabs.Tab>
          <Tabs.Tab value="webhooks" leftSection={<IconWebhook size={16} />}>
            Webhooks
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="keys">
          <ApiKeys />
        </Tabs.Panel>
        <Tabs.Panel value="webhooks">
          <Webhooks />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeys() {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; apiKey: ApiKey } | null>(null);
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: async () => unwrap(await api.GET('/v1/api-keys/')) });
  const revoke = useApiMutation(
    async (k: ApiKey) => unwrap(await api.POST('/v1/api-keys/{id}/revoke', { params: { path: { id: k.id } } })),
    { invalidate: [['api-keys']], success: (k) => `“${k.name}” no longer works.` },
  );
  const confirmRevoke = (k: ApiKey) =>
    modals.openConfirmModal({
      title: `Revoke “${k.name}”?`,
      children: <Text size="sm">Anything using this key stops working straight away. This can’t be undone; you can create a new key.</Text>,
      labels: { confirm: 'Revoke', cancel: 'Keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => revoke.mutate(k),
    });

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Text size="sm" c="dimmed" maw={680}>
          A key lets one of your systems use the API with the permissions you tick. It acts on your behalf: it stops working if you
          stop being an admin, and what it changes shows in Activity under its name. Give each system its own key.
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
          Create API key
        </Button>
      </Group>
      <QueryState query={keys}>
        {keys.data?.length === 0 ? (
          <EmptyHint>No API keys yet.</EmptyHint>
        ) : (
          <Table.ScrollContainer minWidth={820}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Can</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Last used</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {keys.data?.map((k) => (
                  <Table.Tr key={k.id} opacity={k.status === 'active' ? 1 : 0.6}>
                    <Table.Td>
                      <Text fw={500} size="sm">
                        {k.name}
                      </Text>
                      <Code fz="xs">{k.prefix}_…</Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {k.scopes.map((s) => (
                          <Badge key={s} size="sm" variant="light" color={s.endsWith(':write') ? 'orange' : 'indigo'}>
                            {SCOPE_LABEL[s] ?? s}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatDate(k.createdAt)}</Text>
                      <Text size="xs" c="dimmed">
                        by {k.createdBy.fullName}
                        {k.expiresAt && ` · expires ${formatDate(k.expiresAt)}`}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{k.lastUsedAt ? formatAgo(k.lastUsedAt) : 'Never'}</Text>
                      {k.lastUsedIp && (
                        <Text size="xs" c="dimmed">
                          from {k.lastUsedIp}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      {k.status === 'active' ? (
                        <Button size="xs" variant="subtle" color="red" onClick={() => confirmRevoke(k)}>
                          Revoke
                        </Button>
                      ) : (
                        <Badge color="gray" variant="light">
                          {k.status === 'revoked' ? 'Revoked' : 'Expired'}
                        </Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </QueryState>
      <CreateKeyModal
        opened={creating}
        onClose={() => setCreating(false)}
        onCreated={(result) => {
          setCreating(false);
          setCreated(result);
        }}
      />
      <ShowOnce
        opened={!!created}
        onClose={() => setCreated(null)}
        title="Your new API key"
        value={created?.key ?? ''}
        what="key"
        hint={
          <>
            Put it in <b>{created?.apiKey.name}</b>’s settings. Requests send it as <Code>Authorization: Bearer {'<key>'}</Code>.
          </>
        }
      />
    </Stack>
  );
}

function CreateKeyModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (r: { key: string; apiKey: ApiKey }) => void;
}) {
  const form = useForm<{ name: string; scopes: ApiScope[]; expiresOn: string }>({
    initialValues: { name: '', scopes: ['attendance:read'], expiresOn: '' },
    validate: {
      name: (v) => (v.trim().length >= 2 ? null : 'Say what will use it, e.g. "ERP sync"'),
      scopes: (v) => (v.length > 0 ? null : 'Tick at least one'),
    },
  });
  const create = useApiMutation(
    async (v: typeof form.values) =>
      unwrap(
        await api.POST('/v1/api-keys/', {
          body: {
            name: v.name.trim(),
            scopes: v.scopes,
            expiresAt: v.expiresOn ? new Date(`${v.expiresOn}T23:59:59`).toISOString() : undefined,
          },
        }),
      ),
    { invalidate: [['api-keys']] },
  );
  const close = () => {
    form.reset();
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title="Create an API key" size="lg">
      <form onSubmit={form.onSubmit((v) => create.mutate(v, { onSuccess: (r) => (form.reset(), onCreated(r)) }))}>
        <Stack>
          <TextInput label="Name" description="What will use it" placeholder="e.g. ERP sync" data-autofocus {...form.getInputProps('name')} />
          <Checkbox.Group label="It can" {...form.getInputProps('scopes')}>
            <Stack gap="xs" mt="xs">
              {SCOPES.map((s) => (
                <Checkbox key={s.value} value={s.value} label={s.label} description={s.description} />
              ))}
            </Stack>
          </Checkbox.Group>
          <TextInput label="Expires on" description="Optional. Leave empty for a key that works until revoked." type="date" w={220} {...form.getInputProps('expiresOn')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create key
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** A secret shown this once, with a copy button. */
function ShowOnce({
  opened,
  onClose,
  title,
  value,
  what,
  hint,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  value: string;
  what: string;
  hint: React.ReactNode;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" closeOnClickOutside={false}>
      <Stack>
        <Alert color="orange" icon={<IconAlertTriangle />} p="sm">
          Copy it now. For safety this {what} is {what === 'key' ? 'never shown again' : 'only shown to admins'}; treat it like a password.
        </Alert>
        <Group wrap="nowrap" gap="xs">
          <Code block style={{ flex: 1, wordBreak: 'break-all' }} data-testid="secret-value">
            {value}
          </Code>
          <CopyButton value={value}>
            {({ copied, copy }) => (
              <Button variant="light" color={copied ? 'teal' : undefined} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Text size="sm">{hint}</Text>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function Webhooks() {
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  const [secret, setSecret] = useState<{ value: string; title: string } | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookEndpoint | null>(null);
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: async () => unwrap(await api.GET('/v1/webhooks/')), refetchInterval: 30_000 });

  const toggle = useApiMutation(
    async (e: WebhookEndpoint) => unwrap(await api.PATCH('/v1/webhooks/{id}', { params: { path: { id: e.id } }, body: { enabled: !e.enabled } })),
    { invalidate: [['webhooks']], success: (e) => (e.enabled ? 'Switched on' : 'Switched off') },
  );
  const test = useApiMutation(async (e: WebhookEndpoint) => unwrap(await api.POST('/v1/webhooks/{id}/test', { params: { path: { id: e.id } } })), {
    invalidate: [['webhooks']],
  });
  const remove = useApiMutation(
    async (e: WebhookEndpoint) => unwrap(await api.DELETE('/v1/webhooks/{id}', { params: { path: { id: e.id } } })),
    { invalidate: [['webhooks']], success: 'Webhook deleted' },
  );
  const reveal = async (e: WebhookEndpoint) => {
    const { secret: value } = unwrap(await api.GET('/v1/webhooks/{id}/secret', { params: { path: { id: e.id } } }));
    setSecret({ value, title: 'Signing secret' });
  };
  const rotate = (e: WebhookEndpoint) =>
    modals.openConfirmModal({
      title: 'Replace the signing secret?',
      children: <Text size="sm">Deliveries are signed with the new secret straight away; the receiving system must switch to it.</Text>,
      labels: { confirm: 'Replace', cancel: 'Cancel' },
      onConfirm: async () => {
        const { secret: value } = unwrap(await api.POST('/v1/webhooks/{id}/rotate-secret', { params: { path: { id: e.id } } }));
        setSecret({ value, title: 'New signing secret' });
      },
    });
  const confirmDelete = (e: WebhookEndpoint) =>
    modals.openConfirmModal({
      title: 'Delete this webhook?',
      children: <Text size="sm">Nothing more is sent to {e.url}, and its delivery history is deleted.</Text>,
      labels: { confirm: 'Delete', cancel: 'Keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(e),
    });

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Text size="sm" c="dimmed" maw={680}>
          A webhook sends an event to your system’s address the moment something happens, signed so your system can tell it came
          from us. Failed deliveries are retried for about a day; a webhook that keeps failing is switched off and you’re told.
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
          Add webhook
        </Button>
      </Group>
      <QueryState query={hooks}>
        {hooks.data?.length === 0 && <EmptyHint>No webhooks yet.</EmptyHint>}
        {hooks.data?.map((e) => (
          <Card key={e.id} withBorder padding="md">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={6} style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text fw={600} truncate>
                    {e.url}
                  </Text>
                  {e.enabled ? (
                    e.failingSince ? (
                      <Tooltip label={`Deliveries have been failing since ${formatDateTime(e.failingSince)}`}>
                        <Badge color="orange" variant="light">
                          Failing
                        </Badge>
                      </Tooltip>
                    ) : (
                      <Badge color="teal" variant="light">
                        On
                      </Badge>
                    )
                  ) : (
                    <Badge color="gray" variant="light">
                      Off
                    </Badge>
                  )}
                </Group>
                {e.description && (
                  <Text size="sm" c="dimmed">
                    {e.description}
                  </Text>
                )}
                <Group gap={4}>
                  {e.events.map((ev) => (
                    <Badge key={ev} size="sm" variant="outline">
                      {ev}
                    </Badge>
                  ))}
                </Group>
                {!e.enabled && e.disabledReason && (
                  <Text size="sm" c="orange">
                    {e.disabledReason}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  Past day: {e.lastDay.succeeded} delivered, {e.lastDay.failed} failed, {e.lastDay.pending} waiting
                  {e.lastSuccessAt ? ` · last delivered ${formatAgo(e.lastSuccessAt)}` : ''} ·{' '}
                  <Anchor size="xs" component="button" onClick={() => setDeliveries(e)}>
                    Deliveries
                  </Anchor>
                </Text>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconSend size={14} />}
                  disabled={!e.enabled}
                  loading={test.isPending && test.variables?.id === e.id}
                  onClick={() => test.mutate(e)}
                >
                  Send test
                </Button>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button size="xs" variant="default" px={8} aria-label="More">
                      <IconDots size={16} />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setEditing(e)}>Edit</Menu.Item>
                    <Menu.Item onClick={() => toggle.mutate(e)}>{e.enabled ? 'Switch off' : 'Switch on'}</Menu.Item>
                    <Menu.Item onClick={() => void reveal(e)}>Show signing secret</Menu.Item>
                    <Menu.Item onClick={() => rotate(e)}>Replace signing secret</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" onClick={() => confirmDelete(e)}>
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>
            {test.data && test.variables?.id === e.id && (
              <Alert mt="sm" p="xs" color={test.data.ok ? 'teal' : 'red'} withCloseButton onClose={() => test.reset()}>
                <Text size="sm">
                  {test.data.ok
                    ? `Test delivered: your system answered ${test.data.responseStatus}.`
                    : `Test failed: ${test.data.error ?? 'no answer'}. Your system must answer with a 2xx status within 10 seconds.`}
                </Text>
              </Alert>
            )}
          </Card>
        ))}
      </QueryState>
      <WebhookModal
        endpoint={editing}
        onClose={() => setEditing(null)}
        onCreated={(value) => {
          setEditing(null);
          setSecret({ value, title: 'Webhook added: its signing secret' });
        }}
      />
      <ShowOnce
        opened={!!secret}
        onClose={() => setSecret(null)}
        title={secret?.title ?? ''}
        value={secret?.value ?? ''}
        what="secret"
        hint={
          <>
            Your system checks each delivery’s <Code>QRA-Signature</Code> header with it; the{' '}
            <Anchor href={DOCS_URL} target="_blank" rel="noreferrer">
              developer docs
            </Anchor>{' '}
            show how.
          </>
        }
      />
      <DeliveriesDrawer endpoint={deliveries} onClose={() => setDeliveries(null)} />
    </Stack>
  );
}

function WebhookModal({
  endpoint,
  onClose,
  onCreated,
}: {
  endpoint: WebhookEndpoint | 'new' | null;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const editing = endpoint && endpoint !== 'new' ? endpoint : null;
  const form = useForm<{ url: string; description: string; events: WebhookEvent[] }>({
    initialValues: { url: '', description: '', events: ['attendance.recorded', 'session.closed'] },
    validate: {
      url: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'Enter the full address, starting with https://'),
      events: (v) => (v.length > 0 ? null : 'Tick at least one'),
    },
  });
  useEffect(() => {
    if (editing) form.setValues({ url: editing.url, description: editing.description ?? '', events: editing.events });
    else if (endpoint === 'new') form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);
  const save = useApiMutation(
    async (v: typeof form.values) => {
      const body = { url: v.url.trim(), description: v.description.trim() || undefined, events: v.events };
      if (editing) {
        unwrap(await api.PATCH('/v1/webhooks/{id}', { params: { path: { id: editing.id } }, body: { ...body, description: body.description ?? null } }));
        return null;
      }
      return unwrap(await api.POST('/v1/webhooks/', { body })).secret;
    },
    { invalidate: [['webhooks']], success: editing ? 'Saved' : undefined },
  );
  return (
    <Modal opened={!!endpoint} onClose={onClose} title={editing ? 'Edit webhook' : 'Add a webhook'} size="lg">
      <form onSubmit={form.onSubmit((v) => save.mutate(v, { onSuccess: (secret) => (secret ? onCreated(secret) : onClose()) }))}>
        <Stack>
          <TextInput label="Address" description="Your system’s HTTPS address that receives the events" placeholder="https://erp.example.edu/hooks/attendance" data-autofocus {...form.getInputProps('url')} />
          <TextInput label="Description" placeholder="Optional, e.g. ERP attendance sync" {...form.getInputProps('description')} />
          <Checkbox.Group label="Send" {...form.getInputProps('events')}>
            <Stack gap="xs" mt="xs">
              {EVENTS.map((ev) => (
                <Checkbox key={ev.value} value={ev.value} label={ev.label} description={ev.description} />
              ))}
            </Stack>
          </Checkbox.Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {editing ? 'Save' : 'Add webhook'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
