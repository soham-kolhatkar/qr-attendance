import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import DeviceKey from '../../modules/device-key';
import { api, unwrap } from '../api/client';
import type { Device as LinkedDevice } from '../api/types';

/**
 * One phone per student. The app creates a signing key inside the phone's secure
 * hardware and the server checks the hardware's proof once ("linking"). After that,
 * every scan is signed with that key, so attendance can only be marked from this phone.
 *
 * Kept per student on this phone: the key (in the Android Keystore) and the server's id
 * for it (in secure storage). Signing out keeps both, so signing back in needs no
 * re-linking.
 */

const keyAlias = (userId: string) => `qra.device.${userId}`;
const deviceIdKey = (userId: string) => `qra.device.${userId}`;

/** Hardware-backed linking is available (Android for now; iOS support comes later). */
export const PHONE_SUPPORTED = Platform.OS === 'android' && DeviceKey !== null;

export type PhoneState =
  /** This phone is the student's linked phone: scans work. */
  | { kind: 'linked'; device: LinkedDevice }
  /** This phone is waiting for an admin to approve the switch. */
  | { kind: 'pending'; device: LinkedDevice; active: LinkedDevice | null }
  /** Not linked here. `active` is the phone linked now (another one), if any. */
  | { kind: 'unlinked'; active: LinkedDevice | null }
  | { kind: 'unsupported' };

async function loadPhoneState(userId: string): Promise<PhoneState> {
  if (!PHONE_SUPPORTED) return { kind: 'unsupported' };
  const mine = unwrap(await api().GET('/v1/devices/mine'));
  const localId = await SecureStore.getItemAsync(deviceIdKey(userId));
  const hasKey = localId !== null && (await DeviceKey!.hasKey(keyAlias(userId)));
  if (localId && hasKey) {
    if (mine.active?.id === localId) return { kind: 'linked', device: mine.active };
    if (mine.pending?.id === localId) return { kind: 'pending', device: mine.pending, active: mine.active };
  }
  return { kind: 'unlinked', active: mine.active };
}

export const phoneQueryKey = (userId: string) => ['phone', userId];

export function usePhoneState(userId: string | null) {
  return useQuery({
    queryKey: phoneQueryKey(userId ?? 'none'),
    queryFn: () => loadPhoneState(userId!),
    enabled: userId !== null,
    staleTime: 5 * 60_000,
  });
}

/** "Samsung Galaxy S24", without repeating the brand. */
export function phoneModel(): string | undefined {
  const brand = Device.manufacturer ?? Device.brand ?? '';
  const model = Device.modelName ?? '';
  if (!model) return brand || undefined;
  const capitalised = brand ? brand[0]!.toUpperCase() + brand.slice(1) : '';
  return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${capitalised} ${model}`.trim();
}

/**
 * Links this phone: gets a one-time challenge, creates a hardware key that includes it,
 * and sends the hardware's proof. Resolves to the device ("active", or "pending" when
 * the student already has another phone).
 */
export async function linkThisPhone(userId: string): Promise<LinkedDevice> {
  const { challenge } = unwrap(await api().POST('/v1/devices/challenge'));
  const certificateChain = await DeviceKey!.generateKey(keyAlias(userId), challenge);
  const { device } = unwrap(
    await api().POST('/v1/devices/', {
      body: {
        platform: 'android',
        challenge,
        certificateChain,
        phoneId: Application.getAndroidId(),
        model: phoneModel(),
        osVersion: Device.osVersion ?? undefined,
        appVersion: Application.nativeApplicationVersion ?? undefined,
      },
    }),
  );
  await SecureStore.setItemAsync(deviceIdKey(userId), device.id);
  return device;
}

/** Proof for one scan: this phone's signature over the scanned code. */
export async function signScan(userId: string, deviceId: string, qr: string): Promise<{ id: string; signature: string }> {
  const signature = await DeviceKey!.sign(keyAlias(userId), `QAS1|${deviceId}|${qr}`);
  return { id: deviceId, signature };
}
