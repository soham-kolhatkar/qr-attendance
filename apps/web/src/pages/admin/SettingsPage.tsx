import { Alert, Button, Card, Group, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { useEffect, useState } from 'react';
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
          {settings.data && <MinimumCard value={settings.data.minimumPercent} />}
          {settings.data && <CorrectionsCard settings={settings.data} />}
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

function MinimumCard({ value }: { value: number }) {
  const [minimum, setMinimum] = useState<number | string>(value);
  useEffect(() => setMinimum(value), [value]);
  const save = useApiMutation(
    async (minimumPercent: number) => unwrap(await api.PATCH('/v1/settings/attendance', { body: { minimumPercent } })),
    { invalidate: [['settings'], ['reports']], success: (s) => `Minimum attendance is now ${s.minimumPercent}%.` },
  );
  const valid = typeof minimum === 'number' && minimum >= 1 && minimum <= 100;
  return (
    <Card withBorder padding="lg">
      <Stack gap="xs">
        <Text fw={600}>Minimum attendance</Text>
        <Group align="flex-end">
          <NumberInput
            label="Students below this are listed as defaulters"
            description="Used in reports, downloads and the student app. Changes apply straight away."
            min={1}
            max={100}
            suffix="%"
            value={minimum}
            onChange={setMinimum}
            w={340}
          />
          <Button onClick={() => valid && save.mutate(minimum as number)} disabled={!valid || minimum === value} loading={save.isPending}>
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function CorrectionsCard({ settings }: { settings: AttendanceSettings }) {
  const [days, setDays] = useState<number | string>(settings.correctionWindowDays);
  useEffect(() => setDays(settings.correctionWindowDays), [settings.correctionWindowDays]);
  const channels = useQuery({
    queryKey: ['notifications', 'channels'],
    queryFn: async () => unwrap(await api.GET('/v1/notifications/channels')),
  });
  const save = useApiMutation(
    async (body: Partial<Pick<AttendanceSettings, 'correctionWindowDays' | 'lowAttendanceAlerts' | 'weeklyStaffSummary'>>) =>
      unwrap(await api.PATCH('/v1/settings/attendance', { body })),
    { invalidate: [['settings']], success: 'Saved.' },
  );
  const valid = typeof days === 'number' && days >= 0 && days <= 60;
  const missing = channels.data && [!channels.data.email && 'email', !channels.data.push && 'phone notifications'].filter(Boolean);

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <div>
          <Text fw={600}>Corrections and reminders</Text>
          <Text size="sm" c="dimmed">
            Changes apply straight away.
          </Text>
        </div>
        <Group align="flex-end">
          <NumberInput
            label="Students can ask for a correction for up to (days after the class)"
            description="They ask in the app; the class's teacher, the HOD or an admin answers on the Corrections page. 0 turns requests off."
            min={0}
            max={60}
            value={days}
            onChange={setDays}
            w={420}
          />
          <Button
            onClick={() => valid && save.mutate({ correctionWindowDays: days as number })}
            disabled={!valid || days === settings.correctionWindowDays}
            loading={save.isPending && save.variables?.correctionWindowDays !== undefined}
          >
            Save
          </Button>
        </Group>
        <Switch
          checked={settings.lowAttendanceAlerts}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ lowAttendanceAlerts: e.currentTarget.checked })}
          label="Remind students who are below the minimum"
          description="On their phone and by email, at most once a week, from 5 pm, once they've had 5 classes this term. It says which subjects are low and how many classes it takes to recover."
        />
        <Switch
          checked={settings.weeklyStaffSummary}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ weeklyStaffSummary: e.currentTarget.checked })}
          label="Monday summary for teachers, HODs and admins"
          description="An email listing the students below the minimum in the classes each person sees. Nobody gets one when all their students are above it."
        />
        {missing && missing.length > 0 && (
          <Alert color="gray" icon={<IconInfoCircle />} p="sm">
            <Text size="sm">
              {missing.length === 2 ? 'Email and phone notifications aren’t' : `${missing[0] === 'email' ? 'Email isn’t' : 'Phone notifications aren’t'}`}{' '}
              set up on this server yet, so {missing.length === 2 ? 'these messages only show' : 'those messages only show'} in the
              notifications list (the bell) on the web and in the app.
            </Text>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
