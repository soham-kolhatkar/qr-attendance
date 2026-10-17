import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, errorMessage, unwrap } from '@/api/client';
import { attendanceQueryKey } from '@/api/queries';
import type { MyAttendance } from '@/api/types';
import { formatWhen, KIND_LABELS } from '@/lib/format';
import { Banner, Button, Card, Field, Icon, Screen, Text } from '@/ui/components';
import { radius, space, useColors } from '@/ui/theme';

type Requestable = 'present' | 'excused';

const CHOICES: Record<Requestable, { title: string; hint: string; placeholder: string }> = {
  present: {
    title: 'I was there',
    hint: 'e.g. the app couldn’t read the code',
    placeholder: 'e.g. I was in class but the app couldn’t read the QR code, so I asked the teacher at the end',
  },
  excused: {
    title: 'I had a valid reason to be away',
    hint: 'e.g. illness, a hospital visit, college duty',
    placeholder: 'e.g. I was at the hospital; I’ll bring the certificate to the office',
  },
};

/** Ask for a mark in a recent class to be corrected, or see what happened to the request. */
export default function CorrectionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const colors = useColors();
  const queryClient = useQueryClient();
  const attendance = useQuery<MyAttendance>({ queryKey: attendanceQueryKey, enabled: false });
  const recent = attendance.data?.recent.find((r) => r.sessionId === sessionId);
  const [choice, setChoice] = useState<Requestable | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const done = () => queryClient.invalidateQueries({ queryKey: attendanceQueryKey });
  const send = useMutation({
    mutationFn: async () =>
      unwrap(await api().POST('/v1/corrections/', { body: { sessionId, requestedStatus: picked!, reason: reason.trim() } })),
    onSuccess: async () => {
      await done();
      router.back();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const withdraw = useMutation({
    mutationFn: async (id: string) => unwrap(await api().POST('/v1/corrections/{id}/withdraw', { params: { path: { id } } })),
    onSuccess: () => done(),
    onError: (err) => setError(errorMessage(err)),
  });

  if (!recent) {
    return (
      <Screen>
        <Header />
        <Banner tone="warning" title="Class not found">
          Go back and pull down to refresh your attendance.
        </Banner>
      </Screen>
    );
  }

  const options = recent.canRequest as Requestable[];
  const picked: Requestable | null = choice ?? (options.length === 1 ? options[0]! : null);
  const c = recent.correction;
  const submit = () => {
    setError(null);
    if (!picked) return setError('Choose what happened.');
    if (reason.trim().length < 5) return setError('Say what happened, so your teacher can check.');
    send.mutate();
  };

  return (
    <Screen>
      <Header />
      <Card>
        <Text variant="heading">{recent.subject.name}</Text>
        <Text dim>
          {KIND_LABELS[recent.kind] ?? 'Class'} · {formatWhen(recent.startedAt)}
          {recent.topic ? ` · ${recent.topic}` : ''}
        </Text>
        <Text>
          You're marked <Text style={{ fontWeight: '700' }}>{recent.status}</Text>.
        </Text>
      </Card>

      {c && c.status !== 'withdrawn' && (
        <Card>
          {c.status === 'pending' && (
            <Banner tone="info" icon="timer-sand" title="Waiting for your teacher">
              You asked to be marked {c.requestedStatus}. You'll get a notification when they answer.
            </Banner>
          )}
          {c.status === 'approved' && (
            <Banner tone="success" title="Corrected">
              {`You're now marked ${c.requestedStatus}.${c.reviewNote && c.reviewNote !== 'Marked by hand' ? ` ${c.reviewNote}` : ''}`}
            </Banner>
          )}
          {c.status === 'rejected' && (
            <Banner tone="danger" title="Turned down">
              {c.reviewNote ? `“${c.reviewNote}”` : 'Your teacher kept the mark as it is.'} If you think this is wrong, speak to your teacher.
            </Banner>
          )}
          <View style={{ gap: 2 }}>
            <Text variant="caption" dim>
              What you wrote · {formatWhen(c.createdAt)}
            </Text>
            <Text>{c.reason}</Text>
          </View>
          {c.status === 'pending' && (
            <Button title="Withdraw request" variant="danger" icon="undo" loading={withdraw.isPending} onPress={() => withdraw.mutate(c.id)} />
          )}
        </Card>
      )}

      {options.length > 0 && (
        <>
          <Text variant="heading">Ask for a correction</Text>
          {options.length > 1 &&
            options.map((o) => (
              <Pressable
                key={o}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked === o }}
                onPress={() => setChoice(o)}
                style={{
                  flexDirection: 'row',
                  gap: space.md,
                  alignItems: 'center',
                  padding: space.lg,
                  borderRadius: radius.lg,
                  borderWidth: 2,
                  borderColor: picked === o ? colors.primary : colors.border,
                  backgroundColor: picked === o ? colors.infoSoft : colors.surface,
                }}
              >
                <Icon name={picked === o ? 'radiobox-marked' : 'radiobox-blank'} color={picked === o ? colors.primary : colors.textDim} />
                <View style={{ flex: 1 }}>
                  <Text variant="label">{CHOICES[o].title}</Text>
                  <Text variant="caption" dim>
                    {CHOICES[o].hint}
                  </Text>
                </View>
              </Pressable>
            ))}
          <Field
            label="What happened"
            value={reason}
            onChangeText={setReason}
            multiline
            maxLength={500}
            placeholder={picked ? CHOICES[picked].placeholder : 'Tell your teacher what happened'}
          />
          {error && <Banner tone="danger">{error}</Banner>}
          <Button title="Send to my teacher" icon="send" loading={send.isPending} onPress={submit} />
          <Text variant="caption" dim align="center">
            Your teacher, HOD or admin will check it. Asking for something that didn't happen is treated like a proxy attempt.
          </Text>
        </>
      )}

      {options.length === 0 && !c && (
        <Banner tone="info">
          {recent.open
            ? 'This class is still taking attendance. Scan the QR code instead.'
            : 'This class can’t be corrected in the app any more. Please speak to your teacher.'}
        </Banner>
      )}
      {error && options.length === 0 && <Banner tone="danger">{error}</Banner>}
    </Screen>
  );
}

function Header() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
        <Icon name="arrow-left" size={26} />
      </Pressable>
      <Text variant="title">Correction</Text>
    </View>
  );
}
