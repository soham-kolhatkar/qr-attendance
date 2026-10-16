import { ActionIcon, Box, Center, Group, Loader, Progress, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconMaximize } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { api, errorMessage, unwrap } from '../../api/client';
import type { Session } from '../../api/types';
import { measureClockOffset } from '../../lib/clock';
import { formatCountdown } from '../../lib/format';
import { useLiveSession } from '../../lib/live';
import { canGenerateLocally, createQrGenerator, stepAt } from '../../lib/qr';

const TICK_MS = 100;
const CLOCK_RESYNC_MS = 2 * 60_000;

/**
 * What the projector shows: a full-screen QR code that changes every few seconds, a
 * bar showing when it changes next, and the live headcount. Once it has the session
 * secret it needs no network to keep the QR rotating.
 */
export function ProjectorPage() {
  const { id } = useParams() as { id: string };
  const queryClient = useQueryClient();
  const offset = useRef(0);

  const session = useQuery({
    queryKey: ['session', id],
    queryFn: async () => unwrap(await api.GET('/v1/sessions/{id}', { params: { path: { id } } })),
  });
  const config = useQuery({
    queryKey: ['session', id, 'qr-config'],
    queryFn: async () => unwrap(await api.GET('/v1/sessions/{id}/qr-config', { params: { path: { id } } })),
    retry: 3,
    staleTime: Infinity,
  });

  useLiveSession(id, {
    onSnapshot: (s) => queryClient.setQueryData(['session', id], s),
    onEvent: (e) =>
      queryClient.setQueryData<Session>(['session', id], (s) =>
        !s ? s : e.type === 'marked' ? { ...s, counts: e.counts } : { ...s, status: e.status, closesAt: e.closesAt },
      ),
  });

  // Keep this screen's clock aligned with the server's.
  useEffect(() => {
    let stop = false;
    const sync = () =>
      measureClockOffset()
        .then((o) => {
          if (!stop) offset.current = o;
        })
        .catch(() => undefined); // keep the last known offset while offline
    void sync();
    const timer = setInterval(sync, CLOCK_RESYNC_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  // Keep the laptop from sleeping while the code is up.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    };
    acquire();
    const onVisible = () => document.visibilityState === 'visible' && acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, []);

  const qr = useRotatingQr(id, config.data, offset);
  const s = session.data;
  const now = Date.now() + offset.current;
  const closed = !!s && (s.status !== 'open' || new Date(s.closesAt).getTime() <= now);

  if (config.isError && !closed) {
    return (
      <Center h="100vh" p="xl">
        <Stack align="center">
          <Title order={2}>Cannot show the QR code</Title>
          <Text c="dimmed">{errorMessage(config.error)}</Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box h="100vh" bg="white" c="dark.9" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Group justify="space-between" px="xl" py="md" wrap="nowrap">
        <div>
          <Title order={2} c="dark.9">
            {s ? `${s.offering.subject.code} · ${s.offering.subject.name}` : ''}
          </Title>
          <Text c="gray.7" size="lg">
            Open the QR Attendance app and scan
          </Text>
        </div>
        <Group gap="xl" wrap="nowrap">
          {s && (
            <div style={{ textAlign: 'right' }}>
              <Text fz={56} fw={800} lh={1} c="teal.8">
                {s.counts.present}
                <Text span fz={28} c="gray.6" fw={600}>
                  {' '}
                  / {s.counts.total}
                </Text>
              </Text>
              <Text c="gray.7">present</Text>
            </div>
          )}
          <Tooltip label="Full screen (F)">
            <ActionIcon variant="subtle" color="gray" size="xl" onClick={() => void document.documentElement.requestFullscreen?.()} aria-label="Full screen">
              <IconMaximize />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Center style={{ flex: 1, minHeight: 0 }} px="xl">
        {closed ? (
          <Stack align="center" gap="xs">
            <Title order={1} fz={56} c="dark.9">
              {s?.status === 'cancelled' ? 'Session cancelled' : 'Attendance closed'}
            </Title>
            {s && s.status !== 'cancelled' && (
              <Text fz={28} c="gray.7">
                {s.counts.present} of {s.counts.total} present
              </Text>
            )}
          </Stack>
        ) : qr.svg ? (
          <Box
            data-testid="projector-qr"
            data-payload={qr.payload}
            style={{ height: '100%', aspectRatio: '1 / 1', maxWidth: '100%' }}
            dangerouslySetInnerHTML={{ __html: qr.svg }}
          />
        ) : (
          <Loader size="xl" />
        )}
      </Center>

      {!closed && config.data && (
        <Stack px="xl" pb="lg" pt="sm" gap={6}>
          <Progress value={qr.remaining * 100} size="lg" color="indigo" transitionDuration={TICK_MS} aria-label="Time until the code changes" />
          <Group justify="space-between">
            <Text c="gray.7">Code changes every {config.data.rotationSeconds} seconds — photos of it stop working.</Text>
            {s && <Text c="gray.7">Closes in {formatCountdown(new Date(s.closesAt).getTime() - now)}</Text>}
          </Group>
        </Stack>
      )}
    </Box>
  );
}

/**
 * Re-renders the QR whenever the step changes. Generates codes locally from the
 * secret (works offline); on plain-HTTP pages without WebCrypto, asks the API instead.
 */
function useRotatingQr(
  sessionId: string,
  config: { secret: string; rotationSeconds: number } | undefined,
  offset: React.RefObject<number>,
) {
  const [state, setState] = useState({ svg: '', payload: '', remaining: 1 });

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    let lastStep = -1;
    let generate: ((step: number) => Promise<string>) | null = null;
    const ready = canGenerateLocally()
      ? createQrGenerator(sessionId, config.secret).then((g) => {
          generate = g;
        })
      : Promise.resolve();

    const render = async (payload: string) => {
      const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      if (!cancelled) setState((s) => ({ ...s, svg, payload }));
    };

    const tick = async () => {
      await ready;
      const nowMs = Date.now() + offset.current;
      const periodMs = config.rotationSeconds * 1000;
      const step = stepAt(nowMs, config.rotationSeconds);
      const remaining = 1 - (nowMs % periodMs) / periodMs;
      setState((s) => (Math.abs(s.remaining - remaining) > 0.01 ? { ...s, remaining } : s));
      if (step === lastStep) return;
      lastStep = step;
      try {
        if (generate) await render(await generate(step));
        else {
          const current = unwrap(await api.GET('/v1/sessions/{id}/qr', { params: { path: { id: sessionId } } }));
          await render(current.payload);
        }
      } catch {
        lastStep = -1; // try again on the next tick
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') void document.documentElement.requestFullscreen?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [sessionId, config, offset]);

  return state;
}
