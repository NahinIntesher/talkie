import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, randomToken } from '@talkie/core';
import { caller } from '@talkie/auth-kit';
import { isDuplicate } from '@talkie/db';
import * as contract from '@talkie/contracts';
import {
  activeMemberIds,
  emit,
  isAdmin,
  MESSAGE_COLUMNS,
  membership,
  receiptsFor,
  systemMessage,
  toWire,
  type Context,
  type MessageRow,
} from './context.ts';

interface ConversationRow {
  id: string;
  kind: 'direct' | 'group';
  last_message_id: string | null;
  disappearing_seconds: number | null;
  updated_at: Date;
  role: 'member' | 'admin' | 'owner';
  left_at: Date | null;
  muted_until: Date | null;
  archived_at: Date | null;
  pinned_at: Date | null;
  marked_unread: number;
  peer_id: string | null;
  name: string | null;
  description: string | null;
  avatar_media_id: string | null;
  send_policy: 'all' | 'admins' | null;
  edit_info_policy: 'all' | 'admins' | null;
  add_member_policy: 'all' | 'admins' | null;
  approval_required: number | null;
  member_count: number | null;
}

const SUMMARY_SQL = `
  SELECT c.id, c.kind, c.disappearing_seconds, c.updated_at,
         (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id) AS last_message_id,
         cm.role, cm.left_at, cm.muted_until, cm.archived_at, cm.pinned_at, cm.marked_unread,
         (SELECT o.user_id FROM conversation_members o WHERE o.conversation_id = c.id AND o.user_id <> cm.user_id AND c.kind = 'direct' LIMIT 1) AS peer_id,
         g.name, g.description, g.avatar_media_id, g.send_policy, g.edit_info_policy, g.add_member_policy, g.approval_required,
         (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS member_count
  FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  LEFT JOIN \`groups\` g ON g.conversation_id = c.id`;

export function registerConversationRoutes(app: FastifyInstance, ctx: Context) {
  const { db, guards } = ctx;
  const auth = { preHandler: guards.requireAuth };
  const avatar = (mediaId: string | null) => (mediaId ? `${ctx.env.MEDIA_PUBLIC_URL}/avatars/${mediaId}` : null);

  const summaries = async (userId: string, deviceId: string, rows: ConversationRow[]): Promise<contract.ConversationSummary[]> => {
    if (!rows.length) return [];
    const lastIds = rows.map((row) => row.last_message_id).filter((id): id is string => !!id);
    const lastRows = lastIds.length
      ? await db.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
           WHERE m.id IN (${lastIds.map(() => '?').join(',')})`,
          [deviceId, ...lastIds],
        )
      : [];
    const last = new Map((await toWire(db, lastRows, userId)).map((message) => [message.id, message]));
    const unread = await db.query<{ conversation_id: string; total: number }>(
      `SELECT m.conversation_id, COUNT(*) AS total
       FROM conversation_members cm
       JOIN messages m ON m.conversation_id = cm.conversation_id AND m.id > cm.last_read_message_id
                       AND m.sender_id <> cm.user_id AND m.kind <> 'system' AND m.deleted_at IS NULL
       WHERE cm.user_id = ? AND cm.left_at IS NULL
       GROUP BY m.conversation_id`,
      [userId],
    );
    const unreadBy = new Map(unread.map((row) => [row.conversation_id, Number(row.total)]));
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        kind: row.kind,
        peerId: row.peer_id,
        group:
          row.kind === 'group'
            ? {
                name: row.name ?? '',
                description: row.description ?? '',
                avatarUrl: avatar(row.avatar_media_id),
                memberCount: Number(row.member_count ?? 0),
                sendPolicy: row.send_policy ?? 'all',
                editInfoPolicy: row.edit_info_policy ?? 'admins',
                addMemberPolicy: row.add_member_policy ?? 'admins',
                approvalRequired: Number(row.approval_required) === 1,
              }
            : null,
        role: row.role,
        active: !row.left_at,
        lastMessage: (row.last_message_id && last.get(row.last_message_id)) || null,
        unreadCount: unreadBy.get(row.id) ?? 0,
        mutedUntil: row.muted_until && row.muted_until.getTime() > Date.now() ? row.muted_until.toISOString() : null,
        archived: !!row.archived_at,
        pinned: !!row.pinned_at,
        markedUnread: Number(row.marked_unread) === 1,
        disappearingSeconds: row.disappearing_seconds,
        receipts: await receiptsFor(db, row.id, userId, row.kind),
        updatedAt: (last.get(row.last_message_id ?? '')?.createdAt ?? row.updated_at.toISOString()),
      })),
    );
  };

  const one = async (userId: string, deviceId: string, conversationId: string) => {
    const rows = await db.query<ConversationRow>(`${SUMMARY_SQL} WHERE cm.user_id = ? AND c.id = ?`, [userId, conversationId]);
    if (!rows.length) fail('not_found', 'Conversation not found.');
    return (await summaries(userId, deviceId, rows))[0]!;
  };

  // ───────── List and open ─────────

  app.get('/chat/conversations', auth, async (request) => {
    const me = caller(request);
    const rows = await db.query<ConversationRow>(`${SUMMARY_SQL} WHERE cm.user_id = ?
         AND (cm.deleted_before_message_id = 0 OR EXISTS (SELECT 1 FROM messages d WHERE d.conversation_id = c.id AND d.id >= cm.deleted_before_message_id))
       ORDER BY COALESCE(last_message_id, 0) DESC, c.id DESC LIMIT 500`, [me.userId]);
    return { conversations: await summaries(me.userId, me.deviceId, rows) };
  });

  app.get('/chat/conversations/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    await membership(db, id, me.userId, false);
    const members = await db.query<{ user_id: string; role: contract.MemberInfo['role']; joined_at: Date }>(
      "SELECT user_id, role, joined_at FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL ORDER BY FIELD(role, 'owner', 'admin', 'member'), joined_at",
      [id],
    );
    const pins = await db.query<{ message_id: string }>(
      'SELECT message_id FROM conversation_pins WHERE conversation_id = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3)) ORDER BY pinned_at DESC',
      [id],
    );
    return {
      conversation: await one(me.userId, me.deviceId, id),
      members: members.map((m) => ({ userId: m.user_id, role: m.role, joinedAt: m.joined_at.toISOString() })),
      pinnedMessageIds: pins.map((p) => p.message_id),
    };
  });

  /** Public keys of every active device in the conversation, for encrypting a message. */
  app.get('/chat/conversations/:id/devices', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    await membership(db, id, me.userId);
    return { devices: await ctx.devices.forUsers(await activeMemberIds(db, id)) };
  });

  // ───────── Direct chats ─────────

  app.post('/chat/conversations/direct', auth, async (request) => {
    const me = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.body);
    if (userId === me.userId) fail('bad_request', 'Choose someone else.');
    const [relationship] = await ctx.users.relationships(me.userId, [userId]);
    if (!relationship) fail('not_found', 'This person is not on Talkie.');
    const [low, high] = BigInt(me.userId) < BigInt(userId) ? [me.userId, userId] : [userId, me.userId];
    const existing = await db.one<{ conversation_id: string }>('SELECT conversation_id FROM direct_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
    if (existing) {
      // Starting the chat again brings a deleted chat back to the list.
      await db.run('UPDATE conversation_members SET deleted_before_message_id = 0 WHERE conversation_id = ? AND user_id = ?', [existing.conversation_id, me.userId]);
      return { conversation: await one(me.userId, me.deviceId, existing.conversation_id) };
    }
    if (relationship!.blocked) fail('blocked', 'You cannot message this person.');
    const conversationId = ctx.ids.next();
    try {
      await db.tx(async (tx) => {
        await tx.run("INSERT INTO conversations (id, kind, created_by) VALUES (?, 'direct', ?)", [conversationId, me.userId]);
        await tx.run('INSERT INTO direct_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)', [low, high, conversationId]);
        await tx.run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)', [conversationId, me.userId, conversationId, userId]);
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await db.one<{ conversation_id: string }>('SELECT conversation_id FROM direct_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
      return { conversation: await one(me.userId, me.deviceId, raced!.conversation_id) };
    }
    return { conversation: await one(me.userId, me.deviceId, conversationId) };
  });

  // ───────── Groups ─────────

  /** Splits requested members into those who may be added and those whose privacy or blocks prevent it. */
  const addable = async (actorId: string, userIds: string[]) => {
    const unique = [...new Set(userIds)].filter((id) => id !== actorId);
    if (!unique.length) return { allowed: [] as string[], refused: [] as string[] };
    const relationships = await ctx.users.relationships(actorId, unique);
    const known = new Map(relationships.map((r) => [r.userId, r]));
    const allowed = unique.filter((id) => known.get(id) && !known.get(id)!.blocked && known.get(id)!.canAddToGroup);
    return { allowed, refused: unique.filter((id) => !allowed.includes(id)) };
  };

  app.post('/chat/groups', auth, async (request, reply) => {
    const me = caller(request);
    const input = contract.createGroup.parse(request.body);
    const { allowed, refused } = await addable(me.userId, input.memberIds);
    const conversationId = ctx.ids.next();
    await db.tx(async (tx) => {
      await tx.run("INSERT INTO conversations (id, kind, created_by) VALUES (?, 'group', ?)", [conversationId, me.userId]);
      await tx.run('INSERT INTO `groups` (conversation_id, name, description) VALUES (?, ?, ?)', [conversationId, input.name, input.description]);
      await tx.run("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')", [conversationId, me.userId]);
      for (const userId of allowed)
        await tx.run('INSERT INTO conversation_members (conversation_id, user_id, added_by) VALUES (?, ?, ?)', [conversationId, userId, me.userId]);
      await systemMessage(tx, ctx, conversationId, me, { type: 'group_created', actorId: me.userId, value: input.name });
      if (allowed.length) await systemMessage(tx, ctx, conversationId, me, { type: 'members_added', actorId: me.userId, targetIds: allowed });
      await emit(tx, ctx, 'conversation.updated', conversationId, [me.userId, ...allowed], { change: 'created' });
    });
    ctx.relay.kick();
    reply.status(201);
    return { conversation: await one(me.userId, me.deviceId, conversationId), notAdded: refused };
  });

  const groupRow = async (conversationId: string) => {
    const row = await db.one<{ name: string; edit_info_policy: 'all' | 'admins'; add_member_policy: 'all' | 'admins'; approval_required: number; invite_code: string | null; max_members: number }>(
      'SELECT name, edit_info_policy, add_member_policy, approval_required, invite_code, max_members FROM `groups` WHERE conversation_id = ?',
      [conversationId],
    );
    if (!row) fail('not_found', 'Group not found.');
    return row!;
  };

  app.patch('/chat/groups/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const input = contract.updateGroup.parse(request.body);
    const member = await membership(db, id, me.userId);
    const group = await groupRow(id);
    const changesInfo = input.name !== undefined || input.description !== undefined || input.avatarMediaId !== undefined;
    if (input.avatarMediaId) {
      const valid = await ctx.media.verify(me.userId, [input.avatarMediaId], ['group_avatar']);
      if (!valid.length) fail('bad_request', 'Upload the photo first.');
    }
    const changesSettings = input.sendPolicy !== undefined || input.editInfoPolicy !== undefined || input.addMemberPolicy !== undefined || input.approvalRequired !== undefined;
    if (changesSettings && !isAdmin(member)) fail('forbidden', 'Only group admins can change group settings.');
    if (changesInfo && group.edit_info_policy === 'admins' && !isAdmin(member)) fail('forbidden', 'Only group admins can edit group info.');
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE \`groups\` SET name = COALESCE(?, name), description = COALESCE(?, description), send_policy = COALESCE(?, send_policy),
           edit_info_policy = COALESCE(?, edit_info_policy), add_member_policy = COALESCE(?, add_member_policy),
           approval_required = COALESCE(?, approval_required),
           avatar_media_id = IF(?, ?, avatar_media_id) WHERE conversation_id = ?`,
        [
          input.name ?? null,
          input.description ?? null,
          input.sendPolicy ?? null,
          input.editInfoPolicy ?? null,
          input.addMemberPolicy ?? null,
          input.approvalRequired === undefined ? null : input.approvalRequired ? 1 : 0,
          input.avatarMediaId !== undefined ? 1 : 0,
          input.avatarMediaId ?? null,
          id,
        ],
      );
      if (input.name !== undefined && input.name !== group.name) await systemMessage(tx, ctx, id, me, { type: 'name_changed', actorId: me.userId, value: input.name });
      if (input.description !== undefined) await systemMessage(tx, ctx, id, me, { type: 'description_changed', actorId: me.userId });
      if (changesSettings) await systemMessage(tx, ctx, id, me, { type: 'settings_changed', actorId: me.userId });
      await emit(tx, ctx, 'conversation.updated', id, await activeMemberIds(tx, id), { change: 'group' });
    });
    ctx.relay.kick();
    return { conversation: await one(me.userId, me.deviceId, id) };
  });

  app.post('/chat/groups/:id/members', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { userIds } = z.object({ userIds: z.array(contract.id).min(1).max(256) }).parse(request.body);
    const member = await membership(db, id, me.userId);
    const group = await groupRow(id);
    if (group.add_member_policy === 'admins' && !isAdmin(member)) fail('forbidden', 'Only group admins can add members.');
    const { allowed, refused } = await addable(me.userId, userIds);
    const added = await db.tx(async (tx) => {
      const current = await activeMemberIds(tx, id);
      const fresh = allowed.filter((userId) => !current.includes(userId));
      if (current.length + fresh.length > group.max_members) fail('conflict', `A group can have up to ${group.max_members} members.`);
      for (const userId of fresh)
        await tx.run(
          `INSERT INTO conversation_members (conversation_id, user_id, added_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP(3), added_by = VALUES(added_by),
             cleared_before_message_id = 0`,
          [id, userId, me.userId],
        );
      if (fresh.length) {
        await tx.run(`DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id IN (${fresh.map(() => '?').join(',')})`, [id, ...fresh]);
        await systemMessage(tx, ctx, id, me, { type: 'members_added', actorId: me.userId, targetIds: fresh });
        await emit(tx, ctx, 'conversation.updated', id, [...current, ...fresh], { change: 'members' });
      }
      return fresh;
    });
    ctx.relay.kick();
    return { added, notAdded: refused };
  });

  /** Remove someone (admins) or leave (yourself). The last owner leaving hands ownership to the oldest admin/member. */
  app.delete('/chat/groups/:id/members/:userId', auth, async (request) => {
    const me = caller(request);
    const { id, userId } = z.object({ id: contract.id, userId: contract.id }).parse(request.params);
    const member = await membership(db, id, me.userId);
    if (member.kind !== 'group') fail('bad_request', 'This is not a group.');
    const leaving = userId === me.userId;
    if (!leaving) {
      if (!isAdmin(member)) fail('forbidden', 'Only group admins can remove members.');
      const target = await membership(db, id, userId);
      if (target.role === 'owner') fail('forbidden', 'The group owner cannot be removed.');
    }
    await db.tx(async (tx) => {
      const before = await activeMemberIds(tx, id);
      await tx.run("UPDATE conversation_members SET left_at = CURRENT_TIMESTAMP(3), role = 'member' WHERE conversation_id = ? AND user_id = ?", [id, userId]);
      if (leaving && member.role === 'owner') {
        const heir = await tx.one<{ user_id: string }>(
          "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL ORDER BY FIELD(role, 'admin', 'member'), joined_at LIMIT 1",
          [id],
        );
        if (heir) await tx.run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [id, heir.user_id]);
      }
      await systemMessage(tx, ctx, id, me, leaving ? { type: 'member_left', actorId: me.userId } : { type: 'member_removed', actorId: me.userId, targetIds: [userId] });
      await emit(tx, ctx, 'conversation.updated', id, before, { change: 'members' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  app.put('/chat/groups/:id/members/:userId/role', auth, async (request) => {
    const me = caller(request);
    const { id, userId } = z.object({ id: contract.id, userId: contract.id }).parse(request.params);
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(request.body);
    const member = await membership(db, id, me.userId);
    if (!isAdmin(member)) fail('forbidden', 'Only group admins can change roles.');
    const target = await membership(db, id, userId);
    if (target.role === 'owner') fail('forbidden', 'The group owner’s role cannot be changed.');
    if (target.role === role) return { ok: true };
    await db.tx(async (tx) => {
      await tx.run('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?', [role, id, userId]);
      await systemMessage(tx, ctx, id, me, { type: role === 'admin' ? 'admin_promoted' : 'admin_demoted', actorId: me.userId, targetIds: [userId] });
      await emit(tx, ctx, 'conversation.updated', id, await activeMemberIds(tx, id), { change: 'members' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  // ───────── Invite links ─────────

  app.post('/chat/groups/:id/invite-link', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { reset } = z.object({ reset: z.boolean().default(false) }).parse(request.body ?? {});
    const member = await membership(db, id, me.userId);
    if (!isAdmin(member)) fail('forbidden', 'Only group admins can share the invite link.');
    const group = await groupRow(id);
    let code = group.invite_code;
    if (!code || reset) {
      code = randomToken(16);
      await db.run('UPDATE `groups` SET invite_code = ? WHERE conversation_id = ?', [code, id]);
    }
    return { code };
  });

  app.get('/chat/invites/:code', auth, async (request) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(request.params);
    const group = await db.one<{ conversation_id: string; name: string; description: string; avatar_media_id: string | null; approval_required: number }>(
      'SELECT conversation_id, name, description, avatar_media_id, approval_required FROM `groups` WHERE invite_code = ?',
      [code],
    );
    if (!group) fail('not_found', 'This invite link is no longer valid.');
    const count = await db.one<{ total: number }>('SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL', [group!.conversation_id]);
    return {
      group: { id: group!.conversation_id, name: group!.name, description: group!.description, avatarUrl: avatar(group!.avatar_media_id), memberCount: Number(count?.total ?? 0), approvalRequired: Number(group!.approval_required) === 1 },
    };
  });

  app.post('/chat/invites/:code/join', auth, async (request) => {
    const me = caller(request);
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(request.params);
    const group = await db.one<{ conversation_id: string; approval_required: number; max_members: number }>(
      'SELECT conversation_id, approval_required, max_members FROM `groups` WHERE invite_code = ?',
      [code],
    );
    if (!group) fail('not_found', 'This invite link is no longer valid.');
    const id = group!.conversation_id;
    const existing = await db.one<{ left_at: Date | null }>('SELECT left_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [id, me.userId]);
    if (existing && !existing.left_at) return { status: 'joined', conversationId: id };
    if (Number(group!.approval_required) === 1) {
      await db.tx(async (tx) => {
        await tx.run('INSERT IGNORE INTO group_join_requests (conversation_id, user_id) VALUES (?, ?)', [id, me.userId]);
        const admins = await tx.query<{ user_id: string }>("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL AND role IN ('admin','owner')", [id]);
        await emit(tx, ctx, 'conversation.updated', id, admins.map((a) => a.user_id), { change: 'join_requests' });
      });
      ctx.relay.kick();
      return { status: 'requested', conversationId: id };
    }
    await db.tx(async (tx) => {
      const current = await activeMemberIds(tx, id);
      if (current.length >= group!.max_members) fail('conflict', 'This group is full.');
      await tx.run(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP(3), cleared_before_message_id = 0`,
        [id, me.userId],
      );
      await systemMessage(tx, ctx, id, me, { type: 'member_joined', actorId: me.userId });
      await emit(tx, ctx, 'conversation.updated', id, [...current, me.userId], { change: 'members' });
    });
    ctx.relay.kick();
    return { status: 'joined', conversationId: id };
  });

  app.get('/chat/groups/:id/join-requests', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    if (!isAdmin(await membership(db, id, me.userId))) fail('forbidden', 'Only group admins can see join requests.');
    const rows = await db.query<{ user_id: string; created_at: Date }>('SELECT user_id, created_at FROM group_join_requests WHERE conversation_id = ? ORDER BY created_at', [id]);
    return { requests: rows.map((row) => ({ userId: row.user_id, requestedAt: row.created_at.toISOString() })) };
  });

  app.delete('/chat/groups/:id/join-requests/:userId', auth, async (request) => {
    const me = caller(request);
    const { id, userId } = z.object({ id: contract.id, userId: contract.id }).parse(request.params);
    if (!isAdmin(await membership(db, id, me.userId))) fail('forbidden', 'Only group admins can manage join requests.');
    await db.run('DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id = ?', [id, userId]);
    return { ok: true };
  });

  // ───────── Per-user conversation settings ─────────

  app.patch('/chat/conversations/:id/settings', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const input = contract.conversationSettings.parse(request.body);
    await membership(db, id, me.userId, false);
    const sets: string[] = [];
    const values: Array<string | number | Date | null> = [];
    if (input.mutedUntil !== undefined) {
      sets.push('muted_until = ?');
      values.push(input.mutedUntil ? new Date(input.mutedUntil) : null);
    }
    if (input.archived !== undefined) sets.push(input.archived ? 'archived_at = CURRENT_TIMESTAMP(3)' : 'archived_at = NULL');
    if (input.pinned !== undefined) {
      if (input.pinned) {
        const pinned = await db.one<{ total: number }>('SELECT COUNT(*) AS total FROM conversation_members WHERE user_id = ? AND pinned_at IS NOT NULL AND conversation_id <> ?', [me.userId, id]);
        if (Number(pinned?.total ?? 0) >= 3) fail('conflict', 'You can pin up to 3 chats.');
      }
      sets.push(input.pinned ? 'pinned_at = CURRENT_TIMESTAMP(3)' : 'pinned_at = NULL');
    }
    if (input.markedUnread !== undefined) {
      sets.push('marked_unread = ?');
      values.push(input.markedUnread ? 1 : 0);
    }
    await db.tx(async (tx) => {
      await tx.run(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = ? AND user_id = ?`, [...values, id, me.userId]);
      await emit(tx, ctx, 'conversation.updated', id, [me.userId], { change: 'settings' });
    });
    ctx.relay.kick();
    return { conversation: await one(me.userId, me.deviceId, id) };
  });

  app.put('/chat/conversations/:id/disappearing', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { seconds } = z.object({ seconds: z.union([z.literal(null), ...contract.DISAPPEARING_OPTIONS.map((v) => z.literal(v))]) }).parse(request.body);
    const member = await membership(db, id, me.userId);
    if (member.kind === 'group') {
      const group = await groupRow(id);
      if (group.edit_info_policy === 'admins' && !isAdmin(member)) fail('forbidden', 'Only group admins can change this.');
    }
    await db.tx(async (tx) => {
      await tx.run('UPDATE conversations SET disappearing_seconds = ? WHERE id = ?', [seconds, id]);
      await systemMessage(tx, ctx, id, me, { type: 'disappearing_changed', actorId: me.userId, value: seconds });
      await emit(tx, ctx, 'conversation.updated', id, await activeMemberIds(tx, id), { change: 'disappearing' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  /** "Clear chat": hides everything up to now for the caller only. */
  app.post('/chat/conversations/:id/clear', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    await membership(db, id, me.userId, false);
    const latest = await db.one<{ last: string }>('SELECT COALESCE(MAX(id), 0) AS last FROM messages WHERE conversation_id = ?', [id]);
    const last = latest?.last ?? '0';
    await db.run(
      `UPDATE conversation_members SET cleared_before_message_id = ? + 1, last_read_message_id = GREATEST(last_read_message_id, ?)
       WHERE conversation_id = ? AND user_id = ?`,
      [last, last, id, me.userId],
    );
    return { ok: true };
  });

  /** "Delete chat": clears the history for the caller and removes the chat from their list until a new message arrives. */
  app.delete('/chat/conversations/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const member = await membership(db, id, me.userId, false);
    if (member.kind === 'group' && !member.left_at) fail('conflict', 'Exit the group before deleting it.');
    await db.tx(async (tx) => {
      const latest = await tx.one<{ last: string }>('SELECT COALESCE(MAX(id), 0) AS last FROM messages WHERE conversation_id = ?', [id]);
      const last = latest?.last ?? '0';
      await tx.run(
        `UPDATE conversation_members SET cleared_before_message_id = ? + 1, deleted_before_message_id = ? + 1,
           last_read_message_id = GREATEST(last_read_message_id, ?), pinned_at = NULL, archived_at = NULL, marked_unread = 0
         WHERE conversation_id = ? AND user_id = ?`,
        [last, last, last, id, me.userId],
      );
      await emit(tx, ctx, 'conversation.updated', id, [me.userId], { change: 'deleted' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  // ───────── Internal ─────────

  app.get('/internal/conversations/:id/members', { preHandler: guards.requireInternal }, async (request) => {
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const conversation = await db.one<{ kind: 'direct' | 'group' }>('SELECT kind FROM conversations WHERE id = ?', [id]);
    if (!conversation) fail('not_found', 'Conversation not found.');
    return { memberIds: await activeMemberIds(db, id), kind: conversation!.kind };
  });

  /** Everyone who shares an active conversation with the user (who may see their presence). */
  app.get('/internal/users/:userId/peers', { preHandler: guards.requireInternal }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const rows = await db.query<{ user_id: string }>(
      `SELECT DISTINCT o.user_id FROM conversation_members me
       JOIN conversation_members o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id AND o.left_at IS NULL
       WHERE me.user_id = ? AND me.left_at IS NULL LIMIT 5000`,
      [userId],
    );
    return { userIds: rows.map((row) => row.user_id) };
  });
}
