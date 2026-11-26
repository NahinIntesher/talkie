import { z } from 'zod';
import { createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus, startOutboxRelay } from '@talkie/bus';
import { createVerifier, installAuth } from '@talkie/auth-kit';
import { activeMemberIds, deviceDirectory, emit, mediaClient, systemMessage, usersClient, type Context } from './context.ts';
import { registerStatusRoutes } from './status.ts';
import { registerConversationRoutes } from './conversations.ts';
import { registerMessageRoutes } from './messages.ts';
import { registerHistoryRoutes } from './history.ts';
import { registerAdminRoutes } from './admin.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4103),
  DB_NAME: z.string().default('talkie_chat'),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  AUTH_URL: z.url().default('http://127.0.0.1:4101'),
  MEDIA_PUBLIC_URL: z.string().default('/api/media'),
  MEDIA_URL: z.url().default('http://127.0.0.1:4105'),
});

const db = connectDatabase(env, env.DB_NAME);
// Encrypted messages are small, but a large group fan-out carries one sealed key per device.
const service = await createService({ name: 'chat', env, ready: () => db.ping(), rateLimitPerMinute: 600, bodyLimit: 4 * 1024 * 1024 });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);
const bus = createBus(env, service.log, 'chat');
const relay = startOutboxRelay(db, bus, service.log);
const ctx: Context = { db, ids, relay, guards, env, devices: deviceDirectory(env), users: usersClient(env), media: mediaClient(env) };

registerConversationRoutes(service.app, ctx);
registerMessageRoutes(service.app, ctx);
registerHistoryRoutes(service.app, ctx);
registerStatusRoutes(service.app, ctx);
registerAdminRoutes(service.app, ctx);

// Device lists change when someone signs in or out somewhere: drop the cached keys at once.
bus.subscribe('chat-devices', ['device.linked', 'device.revoked'], async (event) => {
  ctx.devices.forget(String((event.payload as { userId: string }).userId));
});

// Read-receipt preference lives in the users service; keep a local copy for the ticks.
bus.subscribe('chat-flags', ['privacy.updated'], async (event) => {
  const { userId, readReceipts } = event.payload as { userId: string; readReceipts?: boolean };
  if (readReceipts === undefined) return;
  await db.run('INSERT INTO user_flags (user_id, read_receipts) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_receipts = VALUES(read_receipts)', [userId, readReceipts ? 1 : 0]);
});

// Every call leaves a line in its chat ("Missed voice call", "Video call · 12:04").
bus.subscribe('chat-calls', ['call.ended'], async (event) => {
  const call = event.payload as { callId: string; conversationId: string | null; initiatorId: string; media: 'audio' | 'video'; outcome: string; durationSeconds: number; joinedIds: string[] };
  const conversationId = call.conversationId;
  if (!conversationId) return;
  const handled = await db.tx(async (tx) => {
    const first = await tx.run('INSERT IGNORE INTO processed_events (consumer_group, event_id) VALUES (?, ?)', ['chat-calls', event.id]);
    if (!first.affectedRows) return false;
    if (!(await tx.one('SELECT 1 FROM conversations WHERE id = ?', [conversationId]))) return false;
    const messageId = await systemMessage(tx, ctx, conversationId, { userId: call.initiatorId, deviceId: '0' }, {
      type: 'call',
      actorId: call.initiatorId,
      call: { callId: call.callId, media: call.media, outcome: call.outcome, durationSeconds: call.durationSeconds, joinedIds: call.joinedIds },
    });
    await tx.run('UPDATE messages SET kind = "call" WHERE id = ?', [messageId]);
    await emit(tx, ctx, 'message.sent', conversationId, await activeMemberIds(tx, conversationId), { messageId, senderId: call.initiatorId, kind: 'call' });
    return true;
  });
  if (handled) relay.kick();
});

// Disappearing messages: remove expired ones every minute and tell the members' devices.
const sweep = setInterval(async () => {
  try {
    const expired = await db.query<{ id: string; conversation_id: string }>('SELECT id, conversation_id FROM messages WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP(3) LIMIT 500');
    const files: string[] = [];
    for (const row of expired)
      await db.tx(async (tx) => {
        files.push(...(await tx.query<{ media_id: string }>('SELECT media_id FROM message_attachments WHERE message_id = ?', [row.id])).map((a) => a.media_id));
        await tx.run('DELETE FROM messages WHERE id = ?', [row.id]);
        await emit(tx, ctx, 'message.updated', row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: row.id, change: 'expired' });
      });
    if (expired.length) relay.kick();
    await ctx.media.release(files);
    // Status updates older than 24 hours.
    const statuses = await db.query<{ id: string; media_id: string | null }>('SELECT id, media_id FROM statuses WHERE expires_at < CURRENT_TIMESTAMP(3) LIMIT 500');
    if (statuses.length) {
      await db.run(`DELETE FROM statuses WHERE id IN (${statuses.map(() => '?').join(',')})`, statuses.map((s) => s.id));
      await ctx.media.release(statuses.map((s) => s.media_id).filter((id): id is string => !!id));
    }
  } catch (error) {
    service.log.error({ err: error }, 'expiry sweep failed');
  }
}, 60_000);
sweep.unref();

service.onShutdown(async () => {
  clearInterval(sweep);
  relay.stop();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
