import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, fail } from '@talkie/core';
import { caller, type AuthContext } from '@talkie/auth-kit';
import { isDuplicate, type Executor } from '@talkie/db';
import * as contract from '@talkie/contracts';
import {
  activeMemberIds,
  decode,
  emit,
  isAdmin,
  MESSAGE_COLUMNS,
  membership,
  receiptsFor,
  toWire,
  type Context,
  type Membership,
  type MessageRow,
} from './context.ts';

const REACTION_MAX_LENGTH = 16;

export function registerMessageRoutes(app: FastifyInstance, ctx: Context) {
  const { db, guards } = ctx;
  const auth = { preHandler: guards.requireAuth };

  /**
   * The sender must seal the message key for every active device of every member (except the sending device).
   * When the device list changed since the client fetched it, the client gets the current list and re-encrypts.
   */
  const checkKeys = async (conversationId: string, me: AuthContext, keys: Array<{ deviceId: string; sealedKey: string }>) => {
    const devices = await ctx.devices.forUsers(await activeMemberIds(db, conversationId));
    const given = new Set(keys.map((key) => key.deviceId));
    const required = devices.filter((device) => device.deviceId !== me.deviceId);
    if (required.some((device) => !given.has(device.deviceId)))
      throw new AppError('devices_changed', 'Encryption keys changed. Re-encrypting…', { devices });
    const valid = new Set(devices.map((device) => device.deviceId));
    return keys.filter((key) => valid.has(key.deviceId) || key.deviceId === me.deviceId);
  };

  const canSend = async (member: Membership, me: AuthContext) => {
    if (member.kind === 'group') {
      const group = await db.one<{ send_policy: 'all' | 'admins' }>('SELECT send_policy FROM `groups` WHERE conversation_id = ?', [member.conversation_id]);
      if (group?.send_policy === 'admins' && !isAdmin(member)) fail('forbidden', 'Only admins can send messages to this group.');
      return;
    }
    const peers = (await activeMemberIds(db, member.conversation_id)).filter((id) => id !== me.userId);
    const relationships = await ctx.users.relationships(me.userId, peers);
    if (relationships.some((r) => r.blocked)) fail('blocked', 'You cannot message this person.');
  };

  const insertKeys = async (tx: Executor, messageId: string, keys: Array<{ deviceId: string; sealedKey: string }>) => {
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = keys.slice(offset, offset + 500);
      await tx.run(
        `INSERT INTO message_keys (message_id, device_id, sealed_key) VALUES ${batch.map(() => '(?, ?, ?)').join(',')}`,
        batch.flatMap((key) => [messageId, key.deviceId, decode(key.sealedKey)]),
      );
    }
  };

  const loadOne = async (messageId: string, me: AuthContext) => {
    const row = await db.one<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ? WHERE m.id = ?`,
      [me.deviceId, messageId],
    );
    if (!row) fail('not_found', 'Message not found.');
    const member = await membership(db, row!.conversation_id, me.userId, false);
    if (row!.created_at < member.joined_at || (member.left_at && row!.created_at > member.left_at)) fail('not_found', 'Message not found.');
    return { row: row!, member };
  };

  // ───────── History ─────────

  app.get('/chat/conversations/:id/messages', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const query = z
      .object({ before: contract.id.optional(), after: contract.id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    const member = await membership(db, id, me.userId, false);
    const newer = query.after !== undefined;
    const rows = await db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
       WHERE m.conversation_id = ? AND m.id >= ? AND m.created_at >= ? ${member.left_at ? 'AND m.created_at <= ?' : ''}
         AND ${newer ? 'm.id > ?' : 'm.id < ?'}
         AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP(3))
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = ? AND h.message_id = m.id)
       ORDER BY m.id ${newer ? 'ASC' : 'DESC'} LIMIT ${query.limit + 1}`,
      [
        me.deviceId,
        id,
        member.cleared_before_message_id,
        member.joined_at,
        ...(member.left_at ? [member.left_at] : []),
        newer ? query.after! : (query.before ?? '18446744073709551615'),
        me.userId,
      ],
    );
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!newer) page.reverse();
    return { messages: await toWire(db, page, me.userId), hasMore: more, receipts: await receiptsFor(db, id, me.userId, member.kind) };
  });

  app.get('/chat/messages/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { row } = await loadOne(id, me);
    return { message: (await toWire(db, [row], me.userId))[0] };
  });

  /** Who has received and read one of my messages (group "Message info"). */
  app.get('/chat/messages/:id/info', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { row } = await loadOne(id, me);
    if (row.sender_id !== me.userId) fail('forbidden', 'You can only see info for your own messages.');
    const members = await db.query<{ user_id: string; last_read_message_id: string; last_delivered_message_id: string }>(
      'SELECT user_id, last_read_message_id, last_delivered_message_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? AND left_at IS NULL',
      [row.conversation_id, me.userId],
    );
    const reached = (mark: string) => BigInt(mark) >= BigInt(id);
    return {
      readBy: members.filter((m) => reached(m.last_read_message_id)).map((m) => m.user_id),
      deliveredTo: members.filter((m) => !reached(m.last_read_message_id) && reached(m.last_delivered_message_id)).map((m) => m.user_id),
    };
  });

  // ───────── Send ─────────

  app.post('/chat/conversations/:id/messages', { ...auth, bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const input = contract.sendMessage.parse(request.body);
    const earlier = await db.one<{ id: string }>('SELECT id FROM messages WHERE sender_id = ? AND client_message_id = ?', [me.userId, input.clientMessageId]);
    if (earlier) return { message: (await toWire(db, [(await loadOne(earlier.id, me)).row], me.userId))[0] };
    const member = await membership(db, id, me.userId);
    await canSend(member, me);
    const keys = await checkKeys(id, me, input.keys);
    const mediaIds = [...new Set(input.mediaIds)];
    if (mediaIds.length) {
      const valid = await ctx.media.verify(me.userId, mediaIds, ['message']);
      if (valid.length !== mediaIds.length) fail('bad_request', 'A file is still uploading. Try again in a moment.');
    }
    if (input.kind !== 'text' && input.kind !== 'poll' && input.kind !== 'location' && input.kind !== 'contact' && !mediaIds.length)
      fail('bad_request', 'Attach the file to send.');
    if (input.replyToId) {
      const original = await db.one<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id = ?', [input.replyToId]);
      if (original?.conversation_id !== id) fail('bad_request', 'The message you replied to is not in this chat.');
    }
    const messageId = ctx.ids.next();
    try {
      await db.tx(async (tx) => {
        await tx.run(
          `INSERT INTO messages (id, conversation_id, sender_id, sender_device_id, kind, ciphertext, nonce, reply_to_id, forwarded_count, client_message_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            messageId,
            id,
            me.userId,
            me.deviceId,
            input.kind,
            decode(input.ciphertext),
            decode(input.nonce),
            input.replyToId ?? null,
            input.forwardedCount,
            input.clientMessageId,
            member.disappearing_seconds ? new Date(Date.now() + member.disappearing_seconds * 1000) : null,
          ],
        );
        await insertKeys(tx, messageId, keys);
        for (const [ordinal, mediaId] of mediaIds.entries())
          await tx.run('INSERT INTO message_attachments (message_id, ordinal, media_id) VALUES (?, ?, ?)', [messageId, ordinal, mediaId]);
        // Sending means the sender has read everything before it; a new message un-hides the chat for everyone.
        await tx.run(
          'UPDATE conversation_members SET last_read_message_id = ?, last_delivered_message_id = ?, marked_unread = 0 WHERE conversation_id = ? AND user_id = ?',
          [messageId, messageId, id, me.userId],
        );
        await tx.run('UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ? AND archived_at IS NOT NULL AND (muted_until IS NULL OR muted_until < CURRENT_TIMESTAMP(3))', [id]);
        // Push notifications need who muted the chat and the group's name; message content stays end-to-end encrypted.
        const muted = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL AND muted_until > CURRENT_TIMESTAMP(3)',
          [id],
        );
        const group = await tx.one<{ name: string }>('SELECT name FROM `groups` WHERE conversation_id = ?', [id]);
        await emit(tx, ctx, 'message.sent', id, await activeMemberIds(tx, id), {
          messageId,
          senderId: me.userId,
          kind: input.kind,
          mutedBy: muted.map((row) => row.user_id),
          groupName: group?.name ?? null,
        });
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await db.one<{ id: string }>('SELECT id FROM messages WHERE sender_id = ? AND client_message_id = ?', [me.userId, input.clientMessageId]);
      return { message: (await toWire(db, [(await loadOne(raced!.id, me)).row], me.userId))[0] };
    }
    ctx.relay.kick();
    reply.status(201);
    return { message: (await toWire(db, [(await loadOne(messageId, me)).row], me.userId))[0] };
  });

  // ───────── Edit and delete ─────────

  app.patch('/chat/messages/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const input = contract.editMessage.parse(request.body);
    const { row } = await loadOne(id, me);
    if (row.sender_id !== me.userId) fail('forbidden', 'You can only edit your own messages.');
    if (row.kind !== 'text' || row.deleted_at) fail('bad_request', 'This message cannot be edited.');
    if (Date.now() - row.created_at.getTime() > contract.EDIT_WINDOW_MS) fail('forbidden', 'Messages can be edited for 15 minutes after sending.');
    await membership(db, row.conversation_id, me.userId);
    const keys = await checkKeys(row.conversation_id, me, input.keys);
    await db.tx(async (tx) => {
      await tx.run('UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [decode(input.ciphertext), decode(input.nonce), id]);
      await tx.run('DELETE FROM message_keys WHERE message_id = ?', [id]);
      await insertKeys(tx, id, keys);
      await emit(tx, ctx, 'message.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id, change: 'edit' });
    });
    ctx.relay.kick();
    return { message: (await toWire(db, [(await loadOne(id, me)).row], me.userId))[0] };
  });

  app.delete('/chat/messages/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { scope } = z.object({ scope: z.enum(['me', 'everyone']).default('me') }).parse(request.query);
    const { row, member } = await loadOne(id, me);
    if (scope === 'me') {
      await db.run('INSERT IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)', [me.userId, id]);
      return { ok: true };
    }
    if (row.kind === 'system' || row.deleted_at) fail('bad_request', 'This message cannot be deleted for everyone.');
    const own = row.sender_id === me.userId;
    if (own && Date.now() - row.created_at.getTime() > contract.DELETE_FOR_EVERYONE_WINDOW_MS) fail('forbidden', 'Messages can be deleted for everyone within 48 hours.');
    if (!own && !(member.kind === 'group' && isAdmin(member) && !member.left_at)) fail('forbidden', 'You can only delete your own messages for everyone.');
    const files = (await db.query<{ media_id: string }>('SELECT media_id FROM message_attachments WHERE message_id = ?', [id])).map((a) => a.media_id);
    await db.tx(async (tx) => {
      await tx.run('UPDATE messages SET ciphertext = NULL, nonce = NULL, deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]);
      await tx.run('DELETE FROM poll_votes WHERE message_id = ?', [id]);
      await tx.run('DELETE FROM message_keys WHERE message_id = ?', [id]);
      await tx.run('DELETE FROM message_reactions WHERE message_id = ?', [id]);
      await tx.run('DELETE FROM message_attachments WHERE message_id = ?', [id]);
      await tx.run('DELETE FROM conversation_pins WHERE message_id = ?', [id]);
      await emit(tx, ctx, 'message.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id, change: 'delete', by: me.userId });
    });
    ctx.relay.kick();
    await ctx.media.release(files);
    return { ok: true };
  });

  // ───────── Reactions, stars, pins ─────────

  app.put('/chat/messages/:id/reaction', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { emoji } = z.object({ emoji: z.string().min(1).max(REACTION_MAX_LENGTH).nullable() }).parse(request.body);
    const { row } = await loadOne(id, me);
    await membership(db, row.conversation_id, me.userId);
    if (row.deleted_at || row.kind === 'system') fail('bad_request', 'You cannot react to this message.');
    await db.tx(async (tx) => {
      if (emoji) await tx.run('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP(3)', [id, me.userId, emoji]);
      else await tx.run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [id, me.userId]);
      await emit(tx, ctx, 'message.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id, change: 'reaction', by: me.userId, emoji });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  /** Replaces my vote on a poll (empty list = withdraw). Single-choice polls accept one option. */
  app.put('/chat/messages/:id/vote', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { options } = contract.pollVote.parse(request.body);
    const { row } = await loadOne(id, me);
    await membership(db, row.conversation_id, me.userId);
    if (row.kind !== 'poll' || row.deleted_at) fail('bad_request', 'This is not a poll.');
    const unique = [...new Set(options)];
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', [id, me.userId]);
      for (const option of unique) await tx.run('INSERT INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)', [id, me.userId, option]);
      await emit(tx, ctx, 'message.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id, change: 'vote', by: me.userId });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  app.put('/chat/messages/:id/star', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { starred } = z.object({ starred: z.boolean() }).parse(request.body);
    await loadOne(id, me);
    if (starred) await db.run('INSERT IGNORE INTO message_stars (user_id, message_id) VALUES (?, ?)', [me.userId, id]);
    else await db.run('DELETE FROM message_stars WHERE user_id = ? AND message_id = ?', [me.userId, id]);
    return { ok: true };
  });

  app.get('/chat/starred', auth, async (request) => {
    const me = caller(request);
    const rows = await db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM message_stars s JOIN messages m ON m.id = s.message_id
       LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
       WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 200`,
      [me.deviceId, me.userId],
    );
    return { messages: await toWire(db, rows, me.userId) };
  });

  app.put('/chat/messages/:id/pin', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { pinned, seconds } = z
      .object({ pinned: z.boolean(), seconds: z.union([z.literal(86_400), z.literal(604_800), z.literal(2_592_000), z.null()]).default(604_800) })
      .parse(request.body);
    const { row } = await loadOne(id, me);
    const member = await membership(db, row.conversation_id, me.userId);
    if (member.kind === 'group' && !isAdmin(member)) {
      const group = await db.one<{ edit_info_policy: string }>('SELECT edit_info_policy FROM `groups` WHERE conversation_id = ?', [row.conversation_id]);
      if (group?.edit_info_policy === 'admins') fail('forbidden', 'Only group admins can pin messages.');
    }
    if (row.deleted_at || row.kind === 'system') fail('bad_request', 'This message cannot be pinned.');
    await db.tx(async (tx) => {
      if (pinned) {
        await tx.run('DELETE FROM conversation_pins WHERE conversation_id = ? AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP(3)', [row.conversation_id]);
        const count = await tx.one<{ total: number }>('SELECT COUNT(*) AS total FROM conversation_pins WHERE conversation_id = ? AND message_id <> ?', [row.conversation_id, id]);
        if (Number(count?.total ?? 0) >= contract.MAX_PINS) {
          // Like popular messengers: pinning a fourth message replaces the oldest pin.
          await tx.run('DELETE FROM conversation_pins WHERE conversation_id = ? ORDER BY pinned_at ASC LIMIT 1', [row.conversation_id]);
        }
        await tx.run(
          `INSERT INTO conversation_pins (conversation_id, message_id, pinned_by, expires_at) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE pinned_by = VALUES(pinned_by), pinned_at = CURRENT_TIMESTAMP(3), expires_at = VALUES(expires_at)`,
          [row.conversation_id, id, me.userId, seconds ? new Date(Date.now() + seconds * 1000) : null],
        );
      } else await tx.run('DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?', [row.conversation_id, id]);
      await emit(tx, ctx, 'conversation.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { change: 'pins' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  // ───────── Receipts ─────────

  const advance = async (conversationId: string, me: AuthContext, messageId: string, read: boolean) => {
    const member = await membership(db, conversationId, me.userId, false);
    const target = await db.one<{ id: string }>('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId]);
    if (!target) fail('not_found', 'Message not found.');
    const changed = await db.tx(async (tx) => {
      const result = read
        ? await tx.run(
            `UPDATE conversation_members SET last_read_message_id = GREATEST(last_read_message_id, ?),
               last_delivered_message_id = GREATEST(last_delivered_message_id, ?), marked_unread = 0
             WHERE conversation_id = ? AND user_id = ? AND (last_read_message_id < ? OR marked_unread = 1)`,
            [messageId, messageId, conversationId, me.userId, messageId],
          )
        : await tx.run(
            'UPDATE conversation_members SET last_delivered_message_id = GREATEST(last_delivered_message_id, ?) WHERE conversation_id = ? AND user_id = ? AND last_delivered_message_id < ?',
            [messageId, conversationId, me.userId, messageId],
          );
      if (result.affectedRows > 0)
        await emit(tx, ctx, 'receipt.updated', conversationId, await activeMemberIds(tx, conversationId), { userId: me.userId, kind: read ? 'read' : 'delivered', messageId });
      return result.affectedRows > 0;
    });
    if (changed) ctx.relay.kick();
    return member;
  };

  app.post('/chat/conversations/:id/read', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { messageId } = z.object({ messageId: contract.id }).parse(request.body);
    await advance(id, me, messageId, true);
    return { ok: true };
  });

  app.post('/chat/conversations/:id/delivered', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { messageId } = z.object({ messageId: contract.id }).parse(request.body);
    await advance(id, me, messageId, false);
    return { ok: true };
  });

  app.get('/chat/conversations/:id/receipts', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const member = await membership(db, id, me.userId, false);
    return { receipts: await receiptsFor(db, id, me.userId, member.kind) };
  });
}
