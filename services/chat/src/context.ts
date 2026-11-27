import { fail, lookupInternal, type Logger, type Snowflake } from '@talkie/core';
import { writeOutbox, type Database, type Executor } from '@talkie/db';
import type { OutboxRelay } from '@talkie/bus';
import type { installAuth } from '@talkie/auth-kit';
import type { DeviceKey, Receipts, SystemEvent, WireMessage, WireReaction } from '@talkie/contracts';

export interface ChatEnv {
  INTERNAL_TOKEN: string;
  USERS_URL: string;
  AUTH_URL: string;
  MEDIA_PUBLIC_URL: string;
  MEDIA_URL: string;
}

export interface Context {
  db: Database;
  ids: Snowflake;
  relay: OutboxRelay;
  guards: ReturnType<typeof installAuth>;
  env: ChatEnv;
  devices: DeviceDirectory;
  users: UsersClient;
  media: MediaClient;
}

// ───────── Other services ─────────

export interface Relationship {
  userId: string;
  blocked: boolean;
  canAddToGroup: boolean;
}

export interface UsersClient {
  relationships(userId: string, otherIds: string[]): Promise<Relationship[]>;
}

export interface MediaClient {
  /** The subset of `mediaIds` that are finished uploads owned by `ownerId` for one of `purposes`. */
  verify(ownerId: string, mediaIds: string[], purposes: string[]): Promise<string[]>;
  /** Deletes files nothing refers to any more. Best effort: failures are retried by the media sweep. */
  release(mediaIds: string[]): Promise<void>;
}

export const mediaClient = (env: ChatEnv, log: Logger): MediaClient => ({
  verify: async (ownerId, mediaIds, purposes) =>
    mediaIds.length ? (await lookupInternal<{ valid: string[] }>(env.INTERNAL_TOKEN, log, 'media.verify', `${env.MEDIA_URL}/internal/media/verify`, { ownerId, mediaIds, purposes })).valid : [],
  release: async (mediaIds) => {
    if (!mediaIds.length) return;
    await lookupInternal(env.INTERNAL_TOKEN, log, 'media.release', `${env.MEDIA_URL}/internal/media/release`, { mediaIds }, false).catch(() => {});
  },
});

export const usersClient = (env: ChatEnv, log: Logger): UsersClient => ({
  relationships: async (userId, otherIds) =>
    (await lookupInternal<{ relationships: Relationship[] }>(env.INTERNAL_TOKEN, log, 'users.relationships', `${env.USERS_URL}/internal/relationships`, { userId, otherIds })).relationships,
});

/**
 * Active device public keys per user, cached briefly and dropped as soon as a `device.linked` / `device.revoked`
 * event arrives for that user.
 */
export interface DeviceDirectory {
  forUsers(userIds: string[], fresh?: boolean): Promise<DeviceKey[]>;
  forget(userId: string): void;
}

export async function messageRecipients(ctx: Context, conversationId: string, fresh = false): Promise<DeviceKey[]> {
  const members = await activeMemberIds(ctx.db, conversationId);
  if (!members.length) return [];
  const [devices, backups] = await Promise.all([
    ctx.devices.forUsers(members, fresh),
    ctx.db.query<DeviceKey>(`SELECT user_id AS userId, recipient_id AS deviceId, identity_key AS identityKey FROM history_backups WHERE user_id IN (${members.map(() => '?').join(',')})`, members),
  ]);
  return [...devices, ...backups];
}

export function deviceDirectory(env: ChatEnv, log: Logger): DeviceDirectory {
  const cache = new Map<string, { at: number; devices: DeviceKey[] }>();
  const TTL = 30_000;
  return {
    async forUsers(userIds, fresh = false) {
      const unique = [...new Set(userIds)];
      const now = Date.now();
      const missing = unique.filter((id) => fresh || (cache.get(id)?.at ?? 0) + TTL < now);
      for (let offset = 0; offset < missing.length; offset += 1000) {
        const batch = missing.slice(offset, offset + 1000);
        const { devices } = await lookupInternal<{ devices: DeviceKey[] }>(env.INTERNAL_TOKEN, log, 'auth.device-keys', `${env.AUTH_URL}/internal/device-keys`, { userIds: batch });
        for (const id of batch) cache.set(id, { at: now, devices: [] });
        for (const device of devices) cache.get(device.userId)?.devices.push(device);
      }
      return unique.flatMap((id) => cache.get(id)?.devices ?? []);
    },
    forget(userId) {
      cache.delete(userId);
    },
  };
}

// ───────── Membership ─────────

export interface Membership {
  conversation_id: string;
  kind: 'direct' | 'group';
  user_id: string;
  role: 'member' | 'admin' | 'owner';
  joined_at: Date;
  left_at: Date | null;
  last_read_message_id: string;
  last_delivered_message_id: string;
  cleared_before_message_id: string;
  disappearing_seconds: number | null;
}

/** The caller's membership row; `active` requires that they have not left. Unknown and foreign conversations are 404. */
export async function membership(db: Executor, conversationId: string, userId: string, active = true): Promise<Membership> {
  const row = await db.one<Membership>(
    `SELECT cm.conversation_id, c.kind, cm.user_id, cm.role, cm.joined_at, cm.left_at, cm.last_read_message_id,
            cm.last_delivered_message_id, cm.cleared_before_message_id, c.disappearing_seconds
     FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.conversation_id = ? AND cm.user_id = ?`,
    [conversationId, userId],
  );
  if (!row) fail('not_found', 'Conversation not found.');
  if (active && row!.left_at) fail('forbidden', 'You are no longer a member of this group.');
  return row!;
}

export async function activeMemberIds(db: Executor, conversationId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL', [conversationId]);
  return rows.map((row) => row.user_id);
}

export const isAdmin = (member: Membership) => member.role === 'admin' || member.role === 'owner';

// ───────── Events ─────────

export type ChatEventType = 'message.sent' | 'message.updated' | 'conversation.updated' | 'receipt.updated' | 'status.updated';

/** Writes an event to the outbox inside the caller's transaction. `recipients` are the users to notify live. */
export async function emit(
  tx: Executor,
  ctx: Pick<Context, 'ids'>,
  type: ChatEventType,
  conversationId: string,
  recipients: string[],
  payload: Record<string, unknown> = {},
): Promise<void> {
  await writeOutbox(tx, { id: ctx.ids.next(), type, key: conversationId, payload: { conversationId, recipients, ...payload } });
}

/** A server-written line such as "Nahin added Rafi". Returns its id. */
export async function systemMessage(tx: Executor, ctx: Pick<Context, 'ids'>, conversationId: string, actor: { userId: string; deviceId: string }, event: SystemEvent): Promise<string> {
  const id = ctx.ids.next();
  await tx.run(
    `INSERT INTO messages (id, conversation_id, sender_id, sender_device_id, kind, system_event, client_message_id)
     VALUES (?, ?, ?, ?, 'system', ?, ?)`,
    [id, conversationId, actor.userId, actor.deviceId, JSON.stringify(event), `sys${id}`.slice(0, 26).padEnd(26, '0')],
  );
  return id;
}

// ───────── Messages on the wire ─────────

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_device_id: string;
  kind: WireMessage['kind'];
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  sealed_key: Buffer | null;
  wrap_device_id: string | null;
  system_event: string | SystemEvent | null;
  reply_to_id: string | null;
  forwarded_count: number;
  edited_at: Date | null;
  deleted_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

export const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.sender_id, m.sender_device_id, m.kind, m.ciphertext, m.nonce, k.sealed_key, k.wrap_device_id,
  m.system_event, m.reply_to_id, m.forwarded_count, m.edited_at, m.deleted_at, m.expires_at, m.created_at`;

function systemEvent(value: MessageRow['system_event']): SystemEvent | null {
  try {
    // MariaDB returns JSON text and MySQL can return an already decoded object.
    const event = typeof value === 'string' ? JSON.parse(value) as SystemEvent | null : value;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

/** Adds reactions and the viewer's stars to message rows. */
export async function toWire(db: Executor, rows: MessageRow[], viewerId: string): Promise<WireMessage[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => '?').join(',');
  const polls = rows.filter((row) => row.kind === 'poll').map((row) => row.id);
  const votes = polls.length
    ? await db.query<{ message_id: string; user_id: string; option_index: number }>(
        `SELECT message_id, user_id, option_index FROM poll_votes WHERE message_id IN (${polls.map(() => '?').join(',')}) ORDER BY voted_at`,
        polls,
      )
    : [];
  const [reactions, stars] = await Promise.all([
    db.query<{ message_id: string; user_id: string; emoji: string }>(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${marks}) ORDER BY created_at`, ids),
    db.query<{ message_id: string }>(`SELECT message_id FROM message_stars WHERE user_id = ? AND message_id IN (${marks})`, [viewerId, ...ids]),
  ]);
  const starred = new Set(stars.map((row) => row.message_id));
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const reaction of reactions) {
    const emojis = byMessage.get(reaction.message_id) ?? new Map<string, string[]>();
    emojis.set(reaction.emoji, [...(emojis.get(reaction.emoji) ?? []), reaction.user_id]);
    byMessage.set(reaction.message_id, emojis);
  }
  return rows.map((row) => {
    const wireReactions: WireReaction[] = [...(byMessage.get(row.id)?.entries() ?? [])].map(([emoji, userIds]) => ({ emoji, userIds }));
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderDeviceId: row.sender_device_id,
      kind: row.kind,
      ciphertext: row.ciphertext ? row.ciphertext.toString('base64url') : null,
      nonce: row.nonce ? row.nonce.toString('base64url') : null,
      sealedKey: row.sealed_key ? row.sealed_key.toString('base64url') : null,
      ...(row.wrap_device_id ? { keySenderDeviceId: row.wrap_device_id } : {}),
      systemEvent: systemEvent(row.system_event),
      replyToId: row.reply_to_id,
      forwardedCount: row.forwarded_count,
      editedAt: row.edited_at?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      reactions: wireReactions,
      starred: starred.has(row.id),
      ...(row.kind === 'poll'
        ? {
            pollVotes: [...new Set(votes.filter((v) => v.message_id === row.id).map((v) => v.option_index))].sort().map((option) => ({
              option,
              userIds: votes.filter((v) => v.message_id === row.id && v.option_index === option).map((v) => v.user_id),
            })),
          }
        : {}),
    };
  });
}

/**
 * The ticks for messages the viewer sent: what every other active member has received and read.
 * In direct chats the read mark is hidden when either person turned read receipts off.
 */
export async function receiptsFor(db: Executor, conversationId: string, viewerId: string, kind: 'direct' | 'group'): Promise<Receipts> {
  const others = await db.query<{ user_id: string; last_read_message_id: string; last_delivered_message_id: string; read_receipts: number | null }>(
    `SELECT cm.user_id, cm.last_read_message_id, cm.last_delivered_message_id, f.read_receipts
     FROM conversation_members cm LEFT JOIN user_flags f ON f.user_id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.user_id <> ? AND cm.left_at IS NULL`,
    [conversationId, viewerId],
  );
  if (!others.length) return { delivered: '0', read: '0' };
  const min = (values: string[]) => values.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
  const delivered = min(others.map((row) => row.last_delivered_message_id));
  let read = min(others.map((row) => row.last_read_message_id));
  if (kind === 'direct') {
    const mine = await db.one<{ read_receipts: number }>('SELECT read_receipts FROM user_flags WHERE user_id = ?', [viewerId]);
    const peerOff = others[0]!.read_receipts !== null && Number(others[0]!.read_receipts) === 0;
    const meOff = mine !== undefined && Number(mine.read_receipts) === 0;
    if (peerOff || meOff) read = '0';
  }
  return { delivered: BigInt(delivered) > BigInt(read) ? delivered : read, read };
}

export const decode = (value: string): Buffer => Buffer.from(value, 'base64url');
