import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, View } from 'react-native';
import { api, errorMessage, unwrap } from '@/api/client';
import { attendanceQueryKey } from '@/api/queries';
import type { MyAttendance } from '@/api/types';
import { useMe } from '@/auth/AuthContext';
import { formatWhen, KIND_LABELS } from '@/lib/format';
import { useUnreadCount } from '@/notifications/push';
import { Banner, Button, Card, Icon, ProgressBar, Screen, Text } from '@/ui/components';
import { type Colors, radius, space, useColors } from '@/ui/theme';

/** Green at or above the institute's minimum, orange within 15 points of it, red below that. */
function percentColor(colors: Colors, percentage: number | null, minimum: number) {
  if (percentage === null) return colors.textDim;
  if (percentage >= minimum) return colors.success;
  return percentage >= minimum - 15 ? colors.warning : colors.danger;
}

export default function HomeScreen() {
  const me = useMe();
  const colors = useColors();
  const attendance = useQuery({
    queryKey: attendanceQueryKey,
    queryFn: async () => unwrap(await api().GET('/v1/attendance/mine')),
  });
  const data = attendance.data;
  const firstName = me.user.fullName.split(' ')[0];
  const unread = useUnreadCount();

  return (
    <Screen refreshControl={<RefreshControl refreshing={attendance.isRefetching} onRefresh={() => void attendance.refetch()} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Text variant="title">Hi, {firstName}</Text>
          {me.student && (
            <Text dim numberOfLines={1}>
              {me.student.unitPath.join(' › ')}
              {me.student.rollNo ? ` · Roll ${me.student.rollNo}` : ''}
            </Text>
          )}
        </View>
        <Pressable
          onPress={() => router.push('/notifications')}
          accessibilityRole="button"
          accessibilityLabel={`Notifications${unread.data ? `, ${unread.data} new` : ''}`}
          hitSlop={8}
          style={{ padding: space.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted }}
        >
          <Icon name={unread.data ? 'bell-badge-outline' : 'bell-outline'} size={26} />
          {!!unread.data && (
            <View
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                minWidth: 18,
                height: 18,
                paddingHorizontal: 4,
                borderRadius: 9,
                backgroundColor: colors.danger,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontSize: 11, lineHeight: 14, fontWeight: '700' }}>{unread.data > 9 ? '9+' : unread.data}</Text>
            </View>
          )}
        </Pressable>
        <Pressable
          onPress={() => router.push('/account')}
          accessibilityRole="button"
          accessibilityLabel="Account"
          hitSlop={8}
          style={{ padding: space.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted }}
        >
          <Icon name="account-outline" size={26} />
        </Pressable>
      </View>

      <Button title="Scan attendance QR" icon="qrcode-scan" size="lg" onPress={() => router.push('/scan')} />

      {attendance.isError && <Banner tone="danger" title="Couldn't load your attendance">{errorMessage(attendance.error)}</Banner>}
      {attendance.isPending && (
        <Text dim align="center">
          Loading your attendance…
        </Text>
      )}
      {data && <Summary data={data} />}
    </Screen>
  );
}

function Summary({ data }: { data: MyAttendance }) {
  const colors = useColors();
  if (!data.term) {
    return (
      <Card>
        <Text variant="heading">No classes yet</Text>
        <Text dim>Your attendance will appear here after your first class.</Text>
      </Card>
    );
  }
  const overall = data.overall;
  return (
    <>
      <Card>
        <Text variant="caption" dim>
          {data.term.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
          <Text style={{ fontSize: 44, lineHeight: 50, fontWeight: '700' }} color={percentColor(colors, overall.percentage, data.minimumPercent)}>
            {overall.percentage === null ? '—' : `${Math.round(overall.percentage)}%`}
          </Text>
          <Text dim>overall</Text>
        </View>
        <Text dim>
          Present in {overall.present} of {overall.total - overall.excused} classes
          {overall.excused > 0 ? ` (${overall.excused} excused)` : ''}. Your institute's minimum is {data.minimumPercent}%.
        </Text>
      </Card>

      {data.subjects.length > 0 && (
        <Card>
          <Text variant="heading">Subjects</Text>
          {data.subjects.map((s) => (
            <View key={s.offeringId} style={{ gap: space.xs }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
                  {s.subject.name}
                </Text>
                <Text variant="label" color={percentColor(colors, s.percentage, data.minimumPercent)}>
                  {s.percentage === null ? '—' : `${Math.round(s.percentage)}%`}
                </Text>
              </View>
              <ProgressBar value={s.percentage ?? 0} color={percentColor(colors, s.percentage, data.minimumPercent)} />
              <Text variant="caption" dim>
                {s.subject.code} · {s.present}/{s.total - s.excused} present
              </Text>
            </View>
          ))}
        </Card>
      )}

      {data.recent.length > 0 && (
        <Card>
          <Text variant="heading">Recent classes</Text>
          {data.correctionWindowDays > 0 && data.recent.some((r) => r.canRequest.length > 0) && (
            <Text variant="caption" dim>
              Marked wrongly? Tap the class to ask for a correction (up to {data.correctionWindowDays} day
              {data.correctionWindowDays === 1 ? '' : 's'} after it).
            </Text>
          )}
          {data.recent.map((r) => {
            const tappable = r.canRequest.length > 0 || !!r.correction;
            const note = r.correction ? CORRECTION_NOTE[r.correction.status] : null;
            return (
              <Pressable
                key={r.sessionId}
                disabled={!tappable}
                onPress={() => router.push({ pathname: '/correction', params: { sessionId: r.sessionId } })}
                accessibilityRole={tappable ? 'button' : undefined}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: pressed ? 0.6 : 1 })}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="label" numberOfLines={1}>
                    {r.subject.name}
                  </Text>
                  <Text variant="caption" dim numberOfLines={1}>
                    {KIND_LABELS[r.kind] ?? 'Class'} · {formatWhen(r.startedAt)}
                    {r.topic ? ` · ${r.topic}` : ''}
                  </Text>
                  {note && (
                    <Text variant="caption" color={note.color(colors)} numberOfLines={1}>
                      {note.label}
                    </Text>
                  )}
                </View>
                <StatusChip status={r.status} open={r.open} />
                {tappable && <Icon name="chevron-right" size={20} color={colors.textDim} />}
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );
}

const CORRECTION_NOTE: Record<string, { label: string; color: (c: Colors) => string }> = {
  pending: { label: 'Correction asked · waiting for your teacher', color: (c) => c.info },
  approved: { label: 'Corrected', color: (c) => c.success },
  rejected: { label: 'Correction turned down', color: (c) => c.danger },
  withdrawn: { label: 'Request withdrawn', color: (c) => c.textDim },
};

function StatusChip({ status, open }: { status: 'present' | 'absent' | 'excused'; open: boolean }) {
  const colors = useColors();
  const pending = open && status === 'absent';
  const look = pending
    ? { label: 'Not marked yet', fg: colors.textDim, bg: colors.surfaceMuted }
    : {
        present: { label: 'Present', fg: colors.success, bg: colors.successSoft },
        absent: { label: 'Absent', fg: colors.danger, bg: colors.dangerSoft },
        excused: { label: 'Excused', fg: colors.warning, bg: colors.warningSoft },
      }[status];
  return (
    <View style={{ backgroundColor: look.bg, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 }}>
      <Text variant="caption" color={look.fg} style={{ fontWeight: '600' }}>
        {look.label}
      </Text>
    </View>
  );
}
