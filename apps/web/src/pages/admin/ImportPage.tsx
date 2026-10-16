import {
  Alert,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  List,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDownload, IconFileSpreadsheet, IconUpload } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, checkedFetch, errorMessage } from '../../api/client';
import type { ImportReport } from '../../api/types';
import { PageHeader } from '../../components/common';
import { downloadCsv, downloadFromApi } from '../../lib/download';

type Kind = 'students' | 'staff';

export function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import from Excel"
        description="Add or update many people at once. Every upload is checked first and nothing is saved until you confirm. If any row has a problem, nothing is saved."
      />
      <Tabs defaultValue="students" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="students">Students</Tabs.Tab>
          <Tabs.Tab value="staff">Teachers & staff</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="students">
          <ImportFlow kind="students" />
        </Tabs.Panel>
        <Tabs.Panel value="staff">
          <ImportFlow kind="staff" />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function ImportFlow({ kind }: { kind: Kind }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noun = kind === 'students' ? 'students' : 'staff accounts';

  const send = async (dryRun: boolean): Promise<ImportReport> => {
    const body = new FormData();
    body.append('file', file!);
    const query = new URLSearchParams({ dryRun: String(dryRun), createMissing: String(createMissing) });
    const res = await checkedFetch(`/v1/imports/${kind}?${query}`, { method: 'POST', body });
    return (await res.json()) as ImportReport;
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'commit');
    setError(null);
    try {
      const report = await send(dryRun);
      if (dryRun) setPreview(report);
      else {
        setResult(report);
        setPreview(null);
        await queryClient.invalidateQueries();
      }
    } catch (err) {
      // A failed commit returns the full report as details.
      if (err instanceof ApiError && err.code === 'IMPORT_HAS_ERRORS') setPreview(err.details as ImportReport);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  if (result) return <ImportDone kind={kind} report={result} onAgain={reset} />;

  return (
    <Stack gap="lg" maw={960}>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder padding="lg">
          <Text fw={600}>1. Get the template</Text>
          <Text size="sm" c="dimmed" mb="md">
            Its columns follow your institute’s structure. Instructions are on the second sheet. Your own sheet works too
            if the column names match.
          </Text>
          <Button
            variant="light"
            leftSection={<IconDownload size={16} />}
            onClick={() => downloadFromApi(`/v1/imports/${kind}/template`, `${kind}-import-template.xlsx`).catch((e) => setError(errorMessage(e)))}
          >
            Download template
          </Button>
        </Card>
        <Card withBorder padding="lg">
          <Text fw={600}>2. Upload and check</Text>
          <Stack gap="sm" mt="xs">
            <FileInput
              placeholder="Choose .xlsx or .csv"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              leftSection={<IconFileSpreadsheet size={16} />}
              value={file}
              onChange={(f) => {
                setFile(f);
                setPreview(null);
                setError(null);
              }}
              clearable
            />
            <Switch
              checked={createMissing}
              onChange={(e) => {
                setCreateMissing(e.currentTarget.checked);
                setPreview(null);
              }}
              label="Create classes and batches that don't exist yet"
              description="The preview lists every one it would create, so you can spot typos"
            />
            <Button leftSection={<IconUpload size={16} />} disabled={!file} loading={busy === 'preview'} onClick={() => run(true)}>
              Check file
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>

      {error && !preview && (
        <Alert color="red" icon={<IconAlertTriangle />}>
          {error}
        </Alert>
      )}
      {preview && (
        <PreviewReport
          report={preview}
          noun={noun}
          committing={busy === 'commit'}
          onCommit={() => run(false)}
        />
      )}
    </Stack>
  );
}

function PreviewReport({
  report,
  noun,
  committing,
  onCommit,
}: {
  report: ImportReport;
  noun: string;
  committing: boolean;
  onCommit: () => void;
}) {
  const { summary } = report;
  const changes = summary.create + summary.update;
  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb="sm">
        3. Review
      </Text>
      <SimpleGrid cols={{ base: 2, sm: 5 }} mb="md">
        <Figure label="Rows" value={summary.rows} />
        <Figure label="New" value={summary.create} color="teal" />
        <Figure label="Updated" value={summary.update} color="indigo" />
        <Figure label="No change" value={summary.unchanged} color="gray" />
        <Figure label="Problems" value={summary.errors} color={summary.errors ? 'red' : 'gray'} />
      </SimpleGrid>
      <Stack gap="md">
        {report.warnings.map((w) => (
          <Alert key={w} color="yellow" icon={<IconAlertTriangle />} py="xs">
            {w}
          </Alert>
        ))}
        {report.newUnits.length > 0 && (
          <div>
            <Text size="sm" fw={500}>
              {report.newUnits.length} new classes will be created — check for spelling mistakes:
            </Text>
            <ScrollArea.Autosize mah={180}>
              <List size="sm" mt={4}>
                {report.newUnits.map((u) => (
                  <List.Item key={u}>{u}</List.Item>
                ))}
              </List>
            </ScrollArea.Autosize>
          </div>
        )}
        {report.newGroups.length > 0 && (
          <div>
            <Text size="sm" fw={500}>
              {report.newGroups.length} new batches / groups will be created:
            </Text>
            <Group gap={6} mt={4}>
              {report.newGroups.slice(0, 60).map((g) => (
                <Badge key={g} variant="light" size="sm">
                  {g}
                </Badge>
              ))}
              {report.newGroups.length > 60 && <Text size="xs">and {report.newGroups.length - 60} more</Text>}
            </Group>
          </div>
        )}
        {report.errors.length > 0 && (
          <div>
            <Text size="sm" fw={500} c="red">
              Fix these rows in your file and upload it again:
            </Text>
            <ScrollArea.Autosize mah={320} mt={4}>
              <Table striped verticalSpacing={4} fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={70}>Row</Table.Th>
                    <Table.Th w={140}>Column</Table.Th>
                    <Table.Th>Problem</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {report.errors.map((e, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{e.row}</Table.Td>
                      <Table.Td>{e.column ?? '—'}</Table.Td>
                      <Table.Td>{e.message}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
            {summary.errors > report.errors.length && (
              <Text size="xs" c="dimmed">
                Showing the first {report.errors.length} of {summary.errors} problems.
              </Text>
            )}
          </div>
        )}
        <Group>
          <Button
            color="teal"
            leftSection={<IconCheck size={16} />}
            disabled={summary.errors > 0 || changes === 0}
            loading={committing}
            onClick={onCommit}
          >
            {changes === 0 ? 'Nothing to import' : `Import ${changes} ${noun}`}
          </Button>
          {summary.errors > 0 && (
            <Text size="sm" c="dimmed">
              Import is disabled until every problem is fixed.
            </Text>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function ImportDone({ kind, report, onAgain }: { kind: Kind; report: ImportReport; onAgain: () => void }) {
  const creds = report.credentials ?? [];
  const saveCredentials = () =>
    downloadCsv(
      `${kind}-temporary-passwords-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Username', 'Full name', 'Temporary password'],
      creds.map((c) => [c.username, c.fullName, c.temporaryPassword]),
    );
  return (
    <Card withBorder padding="lg" maw={960}>
      <Group mb="md">
        <ThemeIcon color="teal" radius="xl" size="lg">
          <IconCheck />
        </ThemeIcon>
        <div>
          <Text fw={600}>Import complete</Text>
          <Text size="sm" c="dimmed">
            {report.summary.create} created, {report.summary.update} updated, {report.summary.unchanged} unchanged.
          </Text>
        </div>
      </Group>
      {creds.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle />} mb="md" title="Save the temporary passwords now">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              {creds.length} new accounts were created. Their temporary passwords are shown only on this screen. Download
              them, hand them out, and keep the file private. Everyone chooses their own password at first sign-in.
            </Text>
            <Button size="xs" leftSection={<IconDownload size={14} />} onClick={saveCredentials}>
              Download passwords (CSV)
            </Button>
          </Stack>
        </Alert>
      )}
      <Button variant="light" onClick={onAgain}>
        Import another file
      </Button>
    </Card>
  );
}

function Figure({ label, value, color = 'dark' }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text fz={24} fw={700} c={color === 'dark' ? undefined : color}>
        {value.toLocaleString()}
      </Text>
    </div>
  );
}
