import { Button, Card, Group, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { useEffect } from 'react';
import { api, unwrap } from '../../api/client';
import { useAttendanceSettings } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { AttendanceSettings } from '../../api/types';
import { PageHeader, QueryState } from '../../components/common';

type QrSettings = Pick<AttendanceSettings, 'qrRotationSeconds' | 'qrGraceSeconds' | 'defaultScanMinutes'>;

export function SettingsPage() {
  const settings = useAttendanceSettings();
  const form = useForm<QrSettings>({
    initialValues: { qrRotationSeconds: 5, qrGraceSeconds: 10, defaultScanMinutes: 10 },
  });
  useEffect(() => {
    if (settings.data) {
      const { qrRotationSeconds, qrGraceSeconds, defaultScanMinutes } = settings.data;
      const values = { qrRotationSeconds, qrGraceSeconds, defaultScanMinutes };
      form.setValues(values);
      form.resetDirty(values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  const save = useApiMutation(async (v: QrSettings) => unwrap(await api.PATCH('/v1/settings/attendance', { body: v })), {
    invalidate: [['settings']],
    success: 'Settings saved. They apply to sessions started from now on.',
  });
  const v = form.values;

  return (
    <>
      <PageHeader title="Settings" />
      <QueryState query={settings}>
        <Stack maw={640}>
          <Card withBorder padding="lg">
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
          {settings.data && <PhoneRequirementCard required={settings.data.requireRegisteredPhone} />}
        </Stack>
      </QueryState>
    </>
  );
}

function PhoneRequirementCard({ required }: { required: boolean }) {
  const save = useApiMutation(
    async (requireRegisteredPhone: boolean) =>
      unwrap(await api.PATCH('/v1/settings/attendance', { body: { requireRegisteredPhone } })),
    {
      invalidate: [['settings']],
      success: (s) =>
        s.requireRegisteredPhone ? 'Scans must now come from linked phones.' : 'Students can now scan without a linked phone.',
    },
  );
  const change = (on: boolean) => {
    if (on) return save.mutate(true);
    modals.openConfirmModal({
      title: 'Allow scans without a linked phone?',
      children: (
        <Text size="sm">
          Anyone who knows a student's password could then mark them present from any phone or computer. Only do this
          while students can't use the app, and turn it back on afterwards.
        </Text>
      ),
      labels: { confirm: 'Allow', cancel: 'Keep it on' },
      confirmProps: { color: 'red' },
      onConfirm: () => save.mutate(false),
    });
  };

  return (
    <Card withBorder padding="lg">
      <Stack gap="xs">
        <Text fw={600}>Students' phones</Text>
        <Switch
          checked={required}
          disabled={save.isPending}
          onChange={(e) => change(e.currentTarget.checked)}
          label="Students must scan with their linked phone"
          description="Each student links one phone in the app; scans from any other phone or a copied app are refused. Changes apply straight away."
        />
      </Stack>
    </Card>
  );
}
