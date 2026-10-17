import { importPKCS8, SignJWT } from 'jose';
import type { FirebaseServiceAccount } from '../../config.js';
import { DeliveryError } from './email.js';

export type PushMessage = { title: string; body: string; data: Record<string, string> };

/**
 * Sends one push notification to one phone. Returns "invalid" when the phone's
 * registration is gone (app uninstalled, signed out, data cleared); throws DeliveryError
 * otherwise.
 */
export type PushSender = { send(token: string, message: PushMessage): Promise<'ok' | 'invalid'> };

/** The Android channel the app creates; users can mute it in the phone's settings. */
export const ANDROID_CHANNEL_ID = 'attendance';

/**
 * Firebase Cloud Messaging (HTTP v1), which delivers to Android phones. Signs in with the
 * service account (a short-lived OAuth token, cached) and sends one message per phone.
 */
export function fcmSender(account: FirebaseServiceAccount, fetchFn: typeof fetch = fetch): PushSender {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.clientEmail)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await importPKCS8(account.privateKey, 'RS256'));
    let res: Response;
    try {
      res = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new DeliveryError(`Google sign-in unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new DeliveryError(`Google sign-in failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }

  return {
    async send(token, message) {
      let res: Response;
      try {
        res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: message.data,
              android: { priority: 'high', notification: { channel_id: ANDROID_CHANNEL_ID } },
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new DeliveryError(`Firebase unreachable: ${(err as Error).message}`);
      }
      if (res.ok) return 'ok';
      const text = await res.text();
      if (res.status === 401) cached = null;
      // The app was uninstalled or signed out (UNREGISTERED), the token belongs to another Firebase
      // project (SENDER_ID_MISMATCH), or it's malformed. Only these say the token itself is bad;
      // other 403/404s are a server set-up problem and must not discard everyone's tokens.
      if (/"(UNREGISTERED|SENDER_ID_MISMATCH)"/.test(text) || (res.status === 400 && /registration token/i.test(text))) {
        return 'invalid';
      }
      throw new DeliveryError(`Firebase ${res.status}: ${text.slice(0, 300)}`, res.status === 400);
    },
  };
}
