import { lookupInternal, type Logger, type Snowflake } from '@talkie/core';
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

/** What the meet service asks other services. Display names are cached for a few minutes. */
export function services(env: MeetEnv, log: Logger) {
  const names = new Map<string, { at: number; name: string }>();
  return {
    conversation: (conversationId: string) =>
      lookupInternal<{ memberIds: string[]; kind: 'direct' | 'group' }>(env.INTERNAL_TOKEN, log, 'chat.members', `${env.CHAT_URL}/internal/conversations/${conversationId}/members`),
    relationships: async (userId: string, otherIds: string[]) =>
      (await lookupInternal<{ relationships: Array<{ userId: string; blocked: boolean }> }>(env.INTERNAL_TOKEN, log, 'users.relationships', `${env.USERS_URL}/internal/relationships`, { userId, otherIds })).relationships,
    devices: async (userIds: string[]) => (await lookupInternal<{ devices: DeviceKey[] }>(env.INTERNAL_TOKEN, log, 'auth.device-keys', `${env.AUTH_URL}/internal/device-keys`, { userIds })).devices,
    async displayName(userId: string) {
      const hit = names.get(userId);
      if (hit && Date.now() - hit.at < 300_000) return hit.name;
      const { profile } = await lookupInternal<{ profile: { displayName: string } }>(env.INTERNAL_TOKEN, log, 'users.profile', `${env.USERS_URL}/internal/profiles/${userId}`);
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
