import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { api, unwrap } from '@/api/client';

const TOKEN_KEY = 'qra.pushToken';
/** Must match the channel the server names in its messages (ANDROID_CHANNEL_ID). */
const CHANNEL_ID = 'attendance';

export const notificationsQueryKey = ['notifications'];
export const unreadQueryKey = ['notifications', 'unread'];

// Notifications that arrive while the app is open still show at the top of the screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

async function sendToken(token: string) {
  unwrap(await api().POST('/v1/notifications/push-tokens', { body: { token, platform: 'android' } }));
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/**
 * Asks to show notifications (Android 13 and later ask the student once) and tells the
 * server where to push. Does nothing when the student says no, or when this build has
 * no Firebase set-up (then notifications still appear in the app's list).
 */
async function registerForPush(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // A channel must exist before Android shows the permission prompt.
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Attendance',
    description: 'Changes to your attendance, answers to your requests, and reminders',
    importance: Notifications.AndroidImportance.HIGH,
  });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') return;
  let token: string;
  try {
    token = (await Notifications.getDevicePushTokenAsync()).data as string;
  } catch {
    return; // no Firebase in this build
  }
  await sendToken(token);
}

/** On sign-out: this phone stops getting the student's notifications. */
export async function unregisterPush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return;
  await api()
    .POST('/v1/notifications/push-tokens/remove', { body: { token } })
    .catch(() => undefined);
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/**
 * For the signed-in student: registers for push, refreshes what's on screen when a
 * notification arrives, and opens the notification list when one is tapped.
 */
export function usePushNotifications(enabled: boolean) {
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!enabled) return;
    void registerForPush().catch(() => undefined);
    // Firebase occasionally replaces the phone's address.
    const tokenChanged = Notifications.addPushTokenListener((t) => void sendToken(t.data as string).catch(() => undefined));
    const received = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
    });
    return () => {
      tokenChanged.remove();
      received.remove();
    };
  }, [enabled, queryClient]);

  useEffect(() => {
    if (!enabled || !response) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    void queryClient.invalidateQueries({ queryKey: ['attendance'] });
    router.push('/notifications');
  }, [enabled, response, queryClient]);
}

/** Notifications not read yet, for the bell on the home screen. */
export function useUnreadCount() {
  return useQuery({
    queryKey: unreadQueryKey,
    queryFn: async () => unwrap(await api().GET('/v1/notifications/unread-count')).count,
    refetchInterval: 60_000,
  });
}
