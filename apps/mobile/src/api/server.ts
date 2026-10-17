import * as SecureStore from 'expo-secure-store';

/**
 * Which server the app talks to. One server hosts every institute, so this is normally
 * fixed at build time. Builds made for testing can let the user point the app at
 * another server (e.g. a staging copy) from the sign-in screen.
 */

export const DEFAULT_SERVER = (process.env.EXPO_PUBLIC_API_URL ?? 'https://qr-attendance-s7mq.onrender.com').replace(/\/+$/, '');
export const CAN_CHANGE_SERVER = process.env.EXPO_PUBLIC_ALLOW_SERVER_CHANGE === 'true';

const KEY = 'qra.server';
let current = DEFAULT_SERVER;

export const server = {
  get url() {
    return current;
  },

  /** Loads a server chosen earlier (testing builds only). */
  async load(): Promise<void> {
    if (!CAN_CHANGE_SERVER) return;
    current = (await SecureStore.getItemAsync(KEY)) ?? DEFAULT_SERVER;
  },

  async set(url: string): Promise<void> {
    current = normalizeServerUrl(url) ?? DEFAULT_SERVER;
    if (current === DEFAULT_SERVER) await SecureStore.deleteItemAsync(KEY);
    else await SecureStore.setItemAsync(KEY, current);
  },
};

/** "example.com" → "https://example.com"; null if it isn't a usable address. */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(withScheme) ? withScheme : null;
}

export const displayHost = (url: string) => url.replace(/^https?:\/\//, '');
