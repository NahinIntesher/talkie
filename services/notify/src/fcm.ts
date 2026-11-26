import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { configPath, type Logger } from '@talkie/core';

/** A Firebase service account (Firebase console → Project settings → Service accounts → Generate new private key). */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered to the app with the notification (all values are strings in FCM). */
  data: Record<string, string>;
  /** Android notification channel: `messages` or `calls`. */
  channel: 'messages' | 'calls';
  /** Notifications with the same tag replace each other (one per chat). */
  tag?: string;
  /** Calls ring at once and expire quickly; messages may wait for a sleeping phone. */
  urgent?: boolean;
  ttlSeconds?: number;
  /** Web: the page a click on the notification opens. */
  link?: string;
}

export type SendResult = 'sent' | 'invalid_token' | 'failed';

/** Reads FIREBASE_SERVICE_ACCOUNT (the JSON itself, or base64 of it) or FIREBASE_SERVICE_ACCOUNT_FILE. */
export function loadServiceAccount(env: { FIREBASE_SERVICE_ACCOUNT?: string; FIREBASE_SERVICE_ACCOUNT_FILE?: string }): ServiceAccount | null {
  let raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw && env.FIREBASE_SERVICE_ACCOUNT_FILE) raw = readFileSync(configPath(env.FIREBASE_SERVICE_ACCOUNT_FILE), 'utf8');
  if (!raw) return null;
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const account = JSON.parse(raw) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key) throw new Error('The Firebase service account JSON is incomplete');
  return account;
}

/** Firebase Cloud Messaging (HTTP v1 API) with a cached OAuth access token. */
export function createFcm(account: ServiceAccount, log: Logger) {
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    pending ??= (async () => {
      try {
        const key = await importPKCS8(account.private_key, 'RS256');
        const now = Math.floor(Date.now() / 1000);
        const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
          .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
          .setIssuer(account.client_email)
          .setAudience(tokenUri)
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(key);
        const response = await fetch(tokenUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
        const body = (await response.json()) as { access_token: string; expires_in: number };
        cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        return body.access_token;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  return {
    projectId: account.project_id,
    async send(deviceToken: string, message: PushMessage): Promise<SendResult> {
      const payload = {
        message: {
          token: deviceToken,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: {
            priority: message.urgent ? 'HIGH' : 'NORMAL',
            ttl: `${message.ttlSeconds ?? 86_400}s`,
            ...(message.tag ? { collapse_key: message.tag } : {}),
            notification: {
              channel_id: message.channel,
              ...(message.tag ? { tag: message.tag } : {}),
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
              default_sound: true,
            },
          },
          webpush: {
            headers: { Urgency: message.urgent ? 'high' : 'normal', TTL: String(message.ttlSeconds ?? 86_400) },
            notification: { icon: '/icon.svg', ...(message.tag ? { tag: message.tag, renotify: true } : {}), ...(message.urgent ? { requireInteraction: true } : {}) },
            ...(message.link ? { fcm_options: { link: message.link } } : {}),
          },
        },
      };
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return 'sent';
        const error = (await response.json().catch(() => ({}))) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
        const code = error.error?.details?.find((d) => d.errorCode)?.errorCode ?? error.error?.status;
        // The app was uninstalled or the token rotated: forget it.
        if (code === 'UNREGISTERED' || response.status === 404) return 'invalid_token';
        if (response.status === 401) cached = null;
        log.warn({ status: response.status, code }, 'push not delivered');
        return 'failed';
      } catch (error) {
        log.warn({ err: error }, 'push not delivered');
        return 'failed';
      }
    },
  };
}

export type Fcm = ReturnType<typeof createFcm>;
