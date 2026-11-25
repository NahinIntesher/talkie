import { AppError, type Snowflake } from '@talkie/core';
import { writeOutbox, type Database, type Executor } from '@talkie/db';
import type { OutboxRelay } from '@talkie/bus';
import type { installAuth } from '@talkie/auth-kit';
import type { DeviceKey } from '@talkie/contracts';
import type { LiveKit } from './livekit.ts';

export interface MeetEnv {
  INTERNAL_TOKEN: string;
  USERS_URL: string;
  AUTH_URL: string;
  CHAT_URL: string;
}

export interface Context {
  db: Database;
  ids: Snowflake;
  relay: OutboxRelay;
  guards: ReturnType<typeof installAuth>;
  lk: LiveKit;
  env: MeetEnv;
  services: Services;
}

async function internal<T>(env: MeetEnv, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AppError('unavailable', 'Talkie is busy right now. Please try again in a moment.');
  }
  if (response.status === 404) throw new AppError('not_found', 'Not found.');
  if (!response.ok) throw new AppError('unavailable', 'Talkie is busy right now. Please try again in a moment.');
  return (await response.json()) as T;
}

/** What the meet service asks other services. Display names are cached for a few minutes. */
export function services(env: MeetEnv) {
  const names = new Map<string, { at: number; name: string }>();
  return {
    conversation: (conversationId: string) =>
      internal<{ memberIds: string[]; kind: 'direct' | 'group' }>(env, `${env.CHAT_URL}/internal/conversations/${conversationId}/members`),
    relationships: async (userId: string, otherIds: string[]) =>
      (await internal<{ relationships: Array<{ userId: string; blocked: boolean }> }>(env, `${env.USERS_URL}/internal/relationships`, { userId, otherIds })).relationships,
    devices: async (userIds: string[]) => (await internal<{ devices: DeviceKey[] }>(env, `${env.AUTH_URL}/internal/device-keys`, { userIds })).devices,
    async displayName(userId: string) {
      const hit = names.get(userId);
      if (hit && Date.now() - hit.at < 300_000) return hit.name;
      const { profile } = await internal<{ profile: { displayName: string } }>(env, `${env.USERS_URL}/internal/profiles/${userId}`);
      names.set(userId, { at: Date.now(), name: profile.displayName });
      return profile.displayName;
    },
  };
}
export type Services = ReturnType<typeof services>;

export type MeetEventType = 'call.ringing' | 'call.updated' | 'call.ended' | 'meeting.updated' | 'meeting.admission' | 'meeting.signal';

export async function emit(tx: Executor, ctx: Pick<Context, 'ids'>, type: MeetEventType, key: string, recipients: string[], payload: Record<string, unknown>) {
  await writeOutbox(tx, { id: ctx.ids.next(), type, key, payload: { recipients: [...new Set(recipients)], ...payload } });
}

export const decode = (value: string) => Buffer.from(value, 'base64url');
