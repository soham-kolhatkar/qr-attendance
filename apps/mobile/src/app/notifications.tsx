import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { api, errorMessage, unwrap } from '@/api/client';
import { formatWhen } from '@/lib/format';
import { notificationsQueryKey, unreadQueryKey } from '@/notifications/push';
import { Banner, Card, Icon, type IconName, Screen, Text } from '@/ui/components';
import { radius, space, useColors } from '@/ui/theme';

const ICONS: Record<string, IconName> = {
  'attendance.changed': 'pencil-outline',
  'correction.approved': 'check-circle-outline',
  'correction.rejected': 'close-circle-outline',
  'attendance.low': 'alert-outline',
};

export default function NotificationsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...notificationsQueryKey, 'list'],
    queryFn: async () => unwrap(await api().GET('/v1/notifications/', { params: { query: { limit: 50 } } })),
  });

  // Seen now: mark them read (they stay highlighted until the next visit).
  const unread = list.data?.unread ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    void api()
      .POST('/v1/notifications/read', { body: {} })
      .then(unwrap)
      .then(({ unread: left }) => queryClient.setQueryData(unreadQueryKey, left))
      .catch(() => undefined);
  }, [unread, queryClient]);

  const tone = (kind: string) =>
    kind === 'correction.approved' ? colors.success : kind === 'correction.rejected' || kind === 'attendance.low' ? colors.danger : colors.info;

  return (
    <Screen refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Icon name="arrow-left" size={26} />
        </Pressable>
        <Text variant="title">Notifications</Text>
      </View>

      {list.isError && <Banner tone="danger" title="Couldn't load notifications">{errorMessage(list.error)}</Banner>}
      {list.isPending && (
        <Text dim align="center">
          Loading…
        </Text>
      )}
      {list.data?.items.length === 0 && (
        <Card>
          <Text variant="heading">Nothing yet</Text>
          <Text dim>When a teacher changes your attendance, answers a correction request, or your attendance drops below the minimum, you'll hear about it here.</Text>
        </Card>
      )}
      {list.data?.items.map((n) => (
        <Card key={n.id} style={n.read ? undefined : { borderColor: colors.primary, backgroundColor: colors.infoSoft }}>
          <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <View style={{ padding: space.xs, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted }}>
              <Icon name={ICONS[n.kind] ?? 'bell-outline'} size={20} color={tone(n.kind)} />
            </View>
            <View style={{ flex: 1, gap: space.xs }}>
              <Text variant="label">{n.title}</Text>
              <Text variant="caption">{n.body}</Text>
              <Text variant="caption" dim>
                {formatWhen(n.createdAt)}
              </Text>
            </View>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
