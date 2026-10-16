import { Button, Card, Group, NumberInput, Stack, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useEffect } from 'react';
import { api, unwrap } from '../../api/client';
import { useAttendanceSettings } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { AttendanceSettings } from '../../api/types';
import { PageHeader, QueryState } from '../../components/common';

export function SettingsPage() {
  const settings = useAttendanceSettings();
  const form = useForm<AttendanceSettings>({
    initialValues: { qrRotationSeconds: 5, qrGraceSeconds: 10, defaultScanMinutes: 10 },
  });
  useEffect(() => {
    if (settings.data) {
      form.setValues(settings.data);
      form.resetDirty(settings.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  const save = useApiMutation(async (v: AttendanceSettings) => unwrap(await api.PATCH('/v1/settings/attendance', { body: v })), {
    invalidate: [['settings']],
    success: 'Settings saved. They apply to sessions started from now on.',
  });
  const v = form.values;

  return (
    <>
      <PageHeader title="Settings" />
      <QueryState query={settings}>
        <Card withBorder padding="lg" maw={640}>
          <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
            <Stack>
              <div>
                <Text fw={600}>Attendance</Text>
                <Text size="sm" c="dimmed">
                  These apply to sessions started after you save.
                </Text>
              </div>
              <NumberInput
                label="QR code changes every (seconds)"
                description="Shorter makes shared screenshots useless sooner."
                min={3}
                max={30}
                {...form.getInputProps('qrRotationSeconds')}
              />
              <NumberInput
                label="Extra seconds a code still works after it changes"
                description="Covers slow mobile data. Longer is kinder to weak networks but gives a forwarded screenshot more time."
                min={2}
                max={60}
                {...form.getInputProps('qrGraceSeconds')}
              />
              <NumberInput
                label="Scanning stays open for (minutes)"
                description="After this, the session closes by itself. Teachers can close it early or extend it."
                min={1}
                max={240}
                {...form.getInputProps('defaultScanMinutes')}
              />
              <Text size="sm" c="dimmed">
                With these values a forwarded screenshot stops working at most{' '}
                <b>{Number(v.qrRotationSeconds) + Number(v.qrGraceSeconds)} seconds</b> after it was taken.
              </Text>
              <Group>
                <Button type="submit" loading={save.isPending} disabled={!form.isDirty()}>
                  Save
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      </QueryState>
    </>
  );
}
