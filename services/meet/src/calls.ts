import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from '@talkie/core';
import { caller, type AuthContext } from '@talkie/auth-kit';
import type { Executor } from '@talkie/db';
import * as contract from '@talkie/contracts';
import { decode, emit, type Context } from './context.ts';

interface CallRow {
  id: string;
  conversation_id: string | null;
  initiator_id: string;
  media: 'audio' | 'video';
  state: contract.CallState;
  e2ee: number;
  key_sender_device_id: string | null;
  room_name: string;
  created_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
}

interface ParticipantRow {
  call_id: string;
  user_id: string;
  state: contract.CallParticipantInfo['state'];
  joined_at: Date | null;
  left_at: Date | null;
}

const OPEN: contract.CallState[] = ['ringing', 'active'];

/**
 * Chat calls: one-to-one and group calls from a conversation. The server rings the other members, tracks who
 * joined, ends the call when it is over and writes the call into the chat history.
 */
export function registerCallRoutes(app: FastifyInstance, ctx: Context) {
  const { db, guards, lk } = ctx;
  const auth = { preHandler: guards.requireAuth };

  const participants = (executor: Executor, callId: string) =>
    executor.query<ParticipantRow>('SELECT call_id, user_id, state, joined_at, left_at FROM call_participants WHERE call_id = ? ORDER BY invited_at', [callId]);

  const view = async (call: CallRow, me: AuthContext): Promise<contract.CallInfo> => {
    const [people, key] = await Promise.all([
      participants(db, call.id),
      db.one<{ sealed_key: Buffer }>('SELECT sealed_key FROM call_keys WHERE call_id = ? AND device_id = ?', [call.id, me.deviceId]),
    ]);
    return {
      id: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      media: call.media,
      state: call.state,
      e2ee: Number(call.e2ee) === 1,
      createdAt: call.created_at.toISOString(),
      answeredAt: call.answered_at?.toISOString() ?? null,
      endedAt: call.ended_at?.toISOString() ?? null,
      participants: people.map((p) => ({ userId: p.user_id, state: p.state, joinedAt: p.joined_at?.toISOString() ?? null, leftAt: p.left_at?.toISOString() ?? null })),
      sealedKey: key ? key.sealed_key.toString('base64url') : null,
      keySenderDeviceId: call.key_sender_device_id,
    };
  };

  const load = async (callId: string, me: AuthContext) => {
    const call = await db.one<CallRow>('SELECT * FROM calls WHERE id = ?', [callId]);
    const mine = call && (await db.one('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ?', [callId, me.userId]));
    if (!call || !mine) fail('not_found', 'Call not found.');
    return call!;
  };

  const grant = async (call: CallRow, me: AuthContext): Promise<contract.MediaGrant> => ({
    url: lk.url,
    room: call.room_name,
    token: await lk.token({
      room: call.room_name,
      identity: me.userId,
      name: await ctx.services.displayName(me.userId).catch(() => 'Talkie'),
      metadata: { userId: me.userId, callId: call.id },
      sources: { camera: true, microphone: true, screen: true, data: true },
      ttlSeconds: 4 * 3600,
    }),
  });

  /** Is this person already in another call (ringing or connected)? */
  const busy = async (userId: string, exceptCallId: string) =>
    !!(await db.one(
      `SELECT 1 FROM call_participants p JOIN calls c ON c.id = p.call_id
       WHERE p.user_id = ? AND c.id <> ? AND c.state IN ('ringing','active') AND p.state IN ('joined')
         AND c.created_at > CURRENT_TIMESTAMP(3) - INTERVAL 6 HOUR LIMIT 1`,
      [userId, exceptCallId],
    ));

  /** Ends a call: final state, everyone still connected is marked left, the room is closed, history is written. */
  const finish = async (tx: Executor, call: CallRow, state: contract.CallState) => {
    const updated = await tx.run("UPDATE calls SET state = ?, ended_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND state IN ('ringing','active')", [state, call.id]);
    if (!updated.affectedRows) return false;
    await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND state = 'joined'", [call.id]);
    await tx.run("UPDATE call_participants SET state = 'missed' WHERE call_id = ? AND state IN ('invited','ringing')", [call.id]);
    const people = await participants(tx, call.id);
    const duration = call.answered_at ? Math.round((Date.now() - call.answered_at.getTime()) / 1000) : 0;
    await emit(tx, ctx, 'call.ended', call.id, people.map((p) => p.user_id), {
      callId: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      media: call.media,
      outcome: state,
      durationSeconds: state === 'ended' ? duration : 0,
      joinedIds: people.filter((p) => p.joined_at).map((p) => p.user_id),
    });
    return true;
  };

  const afterCommit = (room?: string) => {
    ctx.relay.kick();
    if (room) void lk.close(room);
  };

  // ───────── Start ─────────

  app.post('/meet/calls', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const input = contract.startCall.parse(request.body);
    if (!lk.configured) fail('unavailable', 'Calls and meetings are not set up on this server yet.');
    const conversation = await ctx.services.conversation(input.conversationId);
    if (!conversation.memberIds.includes(me.userId)) fail('not_found', 'Conversation not found.');
    const others = conversation.memberIds.filter((id) => id !== me.userId);
    if (!others.length) fail('bad_request', 'There is no one to call.');
    if (others.length + 1 > contract.GROUP_CALL_MAX) fail('bad_request', `Group calls can have up to ${contract.GROUP_CALL_MAX} people.`);
    if (conversation.kind === 'direct' && (await ctx.services.relationships(me.userId, others)).some((r) => r.blocked)) fail('blocked', 'You cannot call this person.');
    if (await busy(me.userId, '0')) fail('conflict', 'You are already on a call.');
    // A group call already going on in this chat: join it instead of ringing again.
    const running = await db.one<CallRow>("SELECT * FROM calls WHERE conversation_id = ? AND state = 'active' AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 6 HOUR ORDER BY id DESC LIMIT 1", [input.conversationId]);
    if (running && conversation.kind === 'group') {
      await db.run("INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES (?, ?, 'joined', CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE state = 'joined', joined_at = COALESCE(joined_at, CURRENT_TIMESTAMP(3)), left_at = NULL", [running.id, me.userId]);
      return { call: await view(running, me), grant: await grant(running, me), joinedExisting: true };
    }
    const devices = await ctx.services.devices(conversation.memberIds);
    const allowed = new Set(devices.map((d) => d.deviceId));
    allowed.add(me.deviceId);
    const keys = input.keys.filter((key) => allowed.has(key.deviceId));
    const id = ctx.ids.next();
    const directBusy = conversation.kind === 'direct' && (await busy(others[0]!, id));
    const call = await db.tx(async (tx) => {
      await tx.run('INSERT INTO calls (id, conversation_id, initiator_id, media, state, e2ee, key_sender_device_id, room_name) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', [
        id,
        input.conversationId,
        me.userId,
        input.media,
        'ringing',
        me.deviceId,
        `call-${id}`,
      ]);
      await tx.run("INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES (?, ?, 'joined', CURRENT_TIMESTAMP(3))", [id, me.userId]);
      for (const userId of others) await tx.run("INSERT INTO call_participants (call_id, user_id, state) VALUES (?, ?, 'ringing')", [id, userId]);
      for (const key of keys) await tx.run('INSERT INTO call_keys (call_id, device_id, sealed_key) VALUES (?, ?, ?)', [id, key.deviceId, decode(key.sealedKey)]);
      const row = (await tx.one<CallRow>('SELECT * FROM calls WHERE id = ?', [id]))!;
      if (directBusy) {
        await tx.run("UPDATE call_participants SET state = 'busy' WHERE call_id = ? AND user_id = ?", [id, others[0]!]);
        await finish(tx, row, 'busy');
      } else await emit(tx, ctx, 'call.ringing', id, others, { callId: id, conversationId: input.conversationId, initiatorId: me.userId, media: input.media, group: conversation.kind === 'group' });
      return (await tx.one<CallRow>('SELECT * FROM calls WHERE id = ?', [id]))!;
    });
    afterCommit();
    reply.status(201);
    return { call: await view(call, me), grant: call.state === 'busy' ? null : await grant(call, me) };
  });

  // ───────── Answer, decline, leave ─────────

  app.post('/meet/calls/:id/accept', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const call = await load(id, me);
    if (!OPEN.includes(call.state)) fail('conflict', 'This call has ended.');
    if (await busy(me.userId, id)) fail('conflict', 'Leave your other call first.');
    await db.tx(async (tx) => {
      await tx.run("UPDATE call_participants SET state = 'joined', joined_at = COALESCE(joined_at, CURRENT_TIMESTAMP(3)), left_at = NULL WHERE call_id = ? AND user_id = ?", [id, me.userId]);
      await tx.run("UPDATE calls SET state = 'active', answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND state = 'ringing'", [id]);
      await emit(tx, ctx, 'call.updated', id, (await participants(tx, id)).map((p) => p.user_id), { callId: id, change: 'joined', userId: me.userId });
    });
    afterCommit();
    const fresh = (await db.one<CallRow>('SELECT * FROM calls WHERE id = ?', [id]))!;
    return { call: await view(fresh, me), grant: await grant(fresh, me) };
  });

  app.post('/meet/calls/:id/decline', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const call = await load(id, me);
    if (!OPEN.includes(call.state)) return { ok: true };
    let room: string | undefined;
    await db.tx(async (tx) => {
      await tx.run("UPDATE call_participants SET state = 'declined' WHERE call_id = ? AND user_id = ? AND state IN ('invited','ringing')", [id, me.userId]);
      const people = await participants(tx, id);
      const stillRinging = people.some((p) => p.state === 'ringing' || p.state === 'invited');
      const others = people.filter((p) => p.user_id !== call.initiator_id && p.state === 'joined');
      if (call.state === 'ringing' && !stillRinging && !others.length) {
        await finish(tx, call, 'declined');
        room = call.room_name;
      } else await emit(tx, ctx, 'call.updated', id, people.map((p) => p.user_id), { callId: id, change: 'declined', userId: me.userId });
    });
    afterCommit(room);
    return { ok: true };
  });

  /** Hang up. A one-to-one call ends for both; a group call ends when fewer than two people remain. */
  app.post('/meet/calls/:id/leave', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const call = await load(id, me);
    if (!OPEN.includes(call.state)) return { ok: true };
    let room: string | undefined;
    await db.tx(async (tx) => {
      await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND user_id = ? AND state = 'joined'", [id, me.userId]);
      const people = await participants(tx, id);
      const connected = people.filter((p) => p.state === 'joined');
      const direct = people.length === 2;
      // Rules: the caller hanging up before anyone answers cancels the call (the others see a missed call);
      // a one-to-one call ends when either person hangs up; a group call ends when fewer than two remain.
      const ends = call.state === 'ringing' ? me.userId === call.initiator_id : direct || connected.length < 2;
      if (ends) {
        await finish(tx, call, call.state === 'ringing' ? 'cancelled' : 'ended');
        room = call.room_name;
      } else await emit(tx, ctx, 'call.updated', id, people.map((p) => p.user_id), { callId: id, change: 'left', userId: me.userId });
    });
    afterCommit(room);
    return { ok: true };
  });

  /** Join (or rejoin) an ongoing group call from the chat. */
  app.post('/meet/calls/:id/join', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const call = await db.one<CallRow>('SELECT * FROM calls WHERE id = ?', [id]);
    if (!call || !OPEN.includes(call.state) || !call.conversation_id) fail('not_found', 'This call has ended.');
    const conversation = await ctx.services.conversation(call!.conversation_id!);
    if (!conversation.memberIds.includes(me.userId)) fail('not_found', 'Call not found.');
    if (await busy(me.userId, id)) fail('conflict', 'Leave your other call first.');
    await db.tx(async (tx) => {
      await tx.run(
        "INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES (?, ?, 'joined', CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE state = 'joined', joined_at = COALESCE(joined_at, CURRENT_TIMESTAMP(3)), left_at = NULL",
        [id, me.userId],
      );
      await tx.run("UPDATE calls SET state = 'active', answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND state = 'ringing'", [id]);
      await emit(tx, ctx, 'call.updated', id, (await participants(tx, id)).map((p) => p.user_id), { callId: id, change: 'joined', userId: me.userId });
    });
    afterCommit();
    const fresh = (await db.one<CallRow>('SELECT * FROM calls WHERE id = ?', [id]))!;
    return { call: await view(fresh, me), grant: await grant(fresh, me) };
  });

  /** A device that was linked after the call started asks the caller's devices for the key via a fresh seal. */
  app.put('/meet/calls/:id/keys', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { keys } = z.object({ keys: contract.sealedKeys }).parse(request.body);
    const call = await load(id, me);
    if (call.key_sender_device_id !== me.deviceId) fail('forbidden', 'Only the device that started the call shares its key.');
    for (const key of keys) await db.run('INSERT IGNORE INTO call_keys (call_id, device_id, sealed_key) VALUES (?, ?, ?)', [id, key.deviceId, decode(key.sealedKey)]);
    return { ok: true };
  });

  // ───────── Read ─────────

  app.get('/meet/calls/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    return { call: await view(await load(id, me), me) };
  });

  /** Calls ringing for me right now (an app that just opened shows the incoming call screen). */
  app.get('/meet/calls/incoming', auth, async (request) => {
    const me = caller(request);
    const rows = await db.query<CallRow>(
      `SELECT c.* FROM calls c JOIN call_participants p ON p.call_id = c.id
       WHERE p.user_id = ? AND p.state = 'ringing' AND c.state IN ('ringing','active') AND c.created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE`,
      [me.userId],
    );
    return { calls: await Promise.all(rows.map((row) => view(row, me))) };
  });

  /** Call history (the Calls tab). */
  app.get('/meet/calls', auth, async (request) => {
    const me = caller(request);
    const { before } = z.object({ before: contract.id.optional() }).parse(request.query);
    const rows = await db.query<CallRow>(
      `SELECT c.* FROM call_participants p JOIN calls c ON c.id = p.call_id
       WHERE p.user_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT 50`,
      [me.userId, before ?? '18446744073709551615'],
    );
    return { calls: await Promise.all(rows.map((row) => view(row, me))) };
  });

  /** Ringing ends after 45 seconds; abandoned calls end. Runs on every replica; the conditional updates make it safe. */
  const sweep = async () => {
    const stale = await db.query<CallRow>(
      `SELECT * FROM calls WHERE (state = 'ringing' AND created_at < CURRENT_TIMESTAMP(3) - INTERVAL ${contract.CALL_RING_MS / 1000} SECOND)
         OR (state = 'active' AND created_at < CURRENT_TIMESTAMP(3) - INTERVAL 12 HOUR) LIMIT 200`,
    );
    for (const call of stale) {
      await db.tx(async (tx) => {
        if (call.state === 'ringing') await finish(tx, call, 'missed');
        else await finish(tx, call, 'ended');
      });
      afterCommit(call.room_name);
    }
    // Group calls: people who never answered stop ringing after 45 seconds.
    await db.run(
      `UPDATE call_participants p JOIN calls c ON c.id = p.call_id SET p.state = 'missed'
       WHERE p.state = 'ringing' AND c.state = 'active' AND c.created_at < CURRENT_TIMESTAMP(3) - INTERVAL ${contract.CALL_RING_MS / 1000} SECOND`,
    );
  };

  /**
   * The media room emptied (LiveKit sends this shortly after the last person disconnects, including after a crash or
   * a lost network): the call is over. Without this a call nobody hung up would keep both people "on a call".
   */
  const roomFinished = async (roomName: string) => {
    const call = await db.one<CallRow>("SELECT * FROM calls WHERE room_name = ? AND state IN ('ringing','active')", [roomName]);
    if (!call) return;
    await db.tx((tx) => finish(tx, call, call.state === 'ringing' ? 'missed' : 'ended'));
    afterCommit(call.room_name);
  };

  return { sweep, finish, roomFinished };
}
