import { useQueryClient } from '@tanstack/react-query';
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, errorCode, errorMessage, unwrap } from '@/api/client';
import { attendanceQueryKey } from '@/api/queries';
import type { ScanResult } from '@/api/types';
import { useMe } from '@/auth/AuthContext';
import { formatTime } from '@/lib/format';
import { phoneQueryKey, signScan, usePhoneState } from '@/phone/phone';
import { Button, Centered, Icon, type IconName, Loading, Screen, Text } from '@/ui/components';
import { radius, space, useColors } from '@/ui/theme';

type ScanState =
  | { kind: 'scanning' }
  | { kind: 'checking' }
  | { kind: 'done'; result: ScanResult }
  | { kind: 'failed'; code: string | null; message: string };

/** Headings for the server's refusals; the server's message explains the detail. */
const FAILURE_TITLES: Record<string, string> = {
  QR_INVALID: "That code didn't work",
  QR_EXPIRED: 'That code has expired',
  SESSION_CLOSED: 'Attendance is closed',
  SESSION_CANCELLED: 'Class cancelled',
  NOT_IN_SESSION: "You're not on this class list",
  MARKED_BY_FACULTY: 'Already marked by your teacher',
  DEVICE_PENDING: 'This phone is waiting for approval',
  DEVICE_REVOKED: 'This phone is no longer linked',
  DEVICE_NOT_LINKED: 'This phone is no longer linked',
  DEVICE_SIGNATURE_INVALID: "Couldn't verify this phone",
};

const ATTENDANCE_CODE = /^QA1\./;

export default function ScanScreen() {
  const me = useMe();
  const phone = usePhoneState(me.user.id);
  const queryClient = useQueryClient();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<ScanState>({ kind: 'scanning' });
  const [hint, setHint] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const busy = useRef(false);
  /** Codes already refused, so frames still showing them aren't sent again. */
  const refused = useRef(new Set<string>());
  const insets = useSafeAreaInsets();

  const device = phone.data?.kind === 'linked' ? phone.data.device : null;

  const onScanned = async ({ data }: BarcodeScanningResult) => {
    if (busy.current || !device || refused.current.has(data)) return;
    if (!ATTENDANCE_CODE.test(data)) {
      setHint("That's not an attendance code. Point at the code on the class screen.");
      return;
    }
    busy.current = true;
    setHint(null);
    setState({ kind: 'checking' });
    try {
      const proof = await signScan(me.user.id, device.id, data);
      const result = unwrap(await api().POST('/v1/attendance/scan', { body: { qr: data, device: proof } }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setState({ kind: 'done', result });
      void queryClient.invalidateQueries({ queryKey: attendanceQueryKey });
    } catch (err) {
      const code = errorCode(err);
      refused.current.add(data);
      if (code === 'QR_EXPIRED') {
        // The screen moved on while this was sent: just read the new code.
        setHint('That code had just changed — hold steady on the current one.');
        setState({ kind: 'scanning' });
        busy.current = false;
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setState({ kind: 'failed', code, message: errorMessage(err) });
      if (code === 'DEVICE_REVOKED' || code === 'DEVICE_NOT_LINKED' || code === 'DEVICE_PENDING') {
        void queryClient.invalidateQueries({ queryKey: phoneQueryKey(me.user.id) });
      }
    }
  };

  const scanAgain = () => {
    setState({ kind: 'scanning' });
    busy.current = false;
  };

  if (!permission) return <Loading />;
  if (!permission.granted) {
    return (
      <Screen fixed contentStyle={{ padding: 0 }}>
        <Centered>
          <Icon name="camera-outline" size={56} />
          <Text variant="title" align="center">
            Allow the camera
          </Text>
          <Text dim align="center">
            The app needs your camera to read the QR code your teacher shows. It's only used while this screen is open.
          </Text>
          {permission.canAskAgain ? (
            <Button title="Allow camera" onPress={() => void requestPermission()} />
          ) : (
            <Button title="Open settings" icon="cog-outline" onPress={() => void Linking.openSettings()} />
          )}
          <Button title="Back" variant="ghost" onPress={() => router.back()} />
        </Centered>
      </Screen>
    );
  }

  if (state.kind === 'done') return <Success result={state.result} />;
  if (state.kind === 'failed') return <Failure code={state.code} message={state.message} onRetry={scanAgain} />;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        zoom={zoomed ? 0.4 : 0}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={state.kind === 'scanning' ? onScanned : undefined}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl }]}>
        <View style={styles.topBar}>
          <RoundButton icon="close" label="Close" onPress={() => router.back()} />
          <RoundButton icon={zoomed ? 'magnify-minus-outline' : 'magnify-plus-outline'} label={zoomed ? 'Zoom out' : 'Zoom in'} onPress={() => setZoomed((z) => !z)} />
        </View>
        <View style={styles.frame} />
        <View style={styles.bottom}>
          {state.kind === 'checking' ? (
            <View style={styles.pill}>
              <ActivityIndicator color="#fff" />
              <Text color="#fff" variant="label">
                Marking you present…
              </Text>
            </View>
          ) : (
            <View style={styles.pill}>
              <Text color="#fff" variant="label" align="center">
                {hint ?? 'Point at the QR code on the class screen'}
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={12} style={styles.round}>
      <Icon name={icon} size={26} color="#fff" />
    </Pressable>
  );
}

function Success({ result }: { result: ScanResult }) {
  const colors = useColors();
  return (
    <Screen fixed contentStyle={{ justifyContent: 'center' }}>
      <View style={{ alignItems: 'center', gap: space.lg }}>
        <View style={{ backgroundColor: colors.successSoft, borderRadius: radius.pill, padding: space.xl }}>
          <Icon name="check-bold" size={72} color={colors.success} />
        </View>
        <Text variant="title" align="center">
          {result.alreadyMarked ? 'Already marked present' : "You're marked present"}
        </Text>
        <View style={{ alignItems: 'center', gap: space.xs }}>
          <Text variant="heading" align="center">
            {result.session.subject.name}
          </Text>
          <Text dim align="center">
            {result.session.subject.code} · {result.alreadyMarked ? 'marked at' : 'at'} {formatTime(result.markedAt)}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: space.xxl }}>
        <Button title="Done" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

function Failure({ code, message, onRetry }: { code: string | null; message: string; onRetry: () => void }) {
  const colors = useColors();
  const phoneProblem = code?.startsWith('DEVICE_');
  return (
    <Screen fixed contentStyle={{ justifyContent: 'center' }}>
      <View style={{ alignItems: 'center', gap: space.lg }}>
        <View style={{ backgroundColor: colors.dangerSoft, borderRadius: radius.pill, padding: space.xl }}>
          <Icon name="close-thick" size={72} color={colors.danger} />
        </View>
        <Text variant="title" align="center">
          {(code && FAILURE_TITLES[code]) ?? "Couldn't mark you present"}
        </Text>
        <Text dim align="center">
          {message}
        </Text>
      </View>
      <View style={{ marginTop: space.xxl, gap: space.md }}>
        {!phoneProblem && <Button title="Scan again" icon="qrcode-scan" onPress={onRetry} />}
        <Button title="Done" variant="secondary" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', alignItems: 'center' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: space.lg },
  round: { backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: radius.pill, padding: space.sm },
  frame: { width: 260, height: 260, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  bottom: { paddingHorizontal: space.xl, alignSelf: 'stretch', alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
});
