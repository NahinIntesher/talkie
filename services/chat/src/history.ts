import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { caller, type AuthContext } from '@talkie/auth-kit';
import { fail } from '@talkie/core';
import { id, publicKey } from '@talkie/contracts';
import { writeOutbox } from '@talkie/db';
import type { Context } from './context.ts';

const BATCH_SIZE = 100;
const target = z.object({ deviceId: id, identityKey: publicKey });
const batch = z.object({
  target,
  keys: z.array(z.object({
    messageId: id,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    sealedKey: z.string().regex(/^[A-Za-z0-9_-]{96}$/),
  })).min(1).max(BATCH_SIZE),
});

// Only history visible to the account and already sealed for the authenticated source device.
const ELIGIBLE = `FROM message_keys source
  JOIN messages m ON m.id = source.message_id
  JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
  WHERE source.device_id = ? AND m.ciphertext IS NOT NULL AND m.nonce IS NOT NULL
    AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP(3))
    AND m.id >= cm.cleared_before_message_id AND m.created_at >= cm.joined_at
    AND (cm.left_at IS NULL OR m.created_at <= cm.left_at)
    AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = cm.user_id AND h.message_id = m.id)`;

export function registerHistoryRoutes(app: FastifyInstance, { db, devices, guards, ids, relay }: Context) {
  const auth = { preHandler: guards.requireAuth };

  const verifyDevices = async (me: AuthContext, destination: z.infer<typeof target>) => {
    const owned = await devices.forUsers([me.userId], true);
    if (destination.deviceId === me.deviceId || !owned.some((d) => d.deviceId === me.deviceId) ||
        !owned.some((d) => d.deviceId === destination.deviceId && d.identityKey === destination.identityKey))
      fail('forbidden', 'History can only be transferred between your active devices.');
  };

  app.post('/chat/history/requests', auth, async (request) => {
    const me = caller(request);
    const owned = await devices.forUsers([me.userId], true);
    const current = owned.find((d) => d.deviceId === me.deviceId);
    if (!current || !owned.some((d) => d.deviceId !== me.deviceId)) fail('conflict', 'Keep another device signed in to approve history recovery.');
    await db.run(
      `INSERT INTO history_requests (user_id, device_id, identity_key) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE identity_key = VALUES(identity_key), requested_at = CURRENT_TIMESTAMP(3), completed_at = NULL`,
      [me.userId, me.deviceId, current!.identityKey],
    );
    return { ok: true };
  });

  app.get('/chat/history/requests', auth, async (request) => {
    const me = caller(request);
    const owned = await devices.forUsers([me.userId], true);
    const rows = await db.query<{ device_id: string; identity_key: string; requested_at: Date; completed_at: Date | null }>(
      'SELECT device_id, identity_key, requested_at, completed_at FROM history_requests WHERE user_id = ? AND requested_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY',
      [me.userId],
    );
    const requests = rows.filter((r) => owned.some((d) => d.deviceId === r.device_id && d.identityKey === r.identity_key));
    return {
      incoming: requests.filter((r) => r.device_id !== me.deviceId && !r.completed_at).map((r) => ({ deviceId: r.device_id, identityKey: r.identity_key, requestedAt: r.requested_at.toISOString() })),
      pending: requests.some((r) => r.device_id === me.deviceId && !r.completed_at),
    };
  });

  app.post('/chat/history/requests/complete', auth, async (request) => {
    const me = caller(request);
    const destination = target.extend({ transferred: z.boolean().default(false) }).parse(request.body);
    await verifyDevices(me, destination);
    const completed = await db.tx(async (tx) => {
      if (!(await tx.one('SELECT 1 FROM message_keys WHERE device_id = ? AND wrap_device_id = ? LIMIT 1', [destination.deviceId, me.deviceId]))) return false;
      const pending = await tx.run(
        `UPDATE history_requests SET completed_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND device_id = ? AND identity_key = ? AND completed_at IS NULL`,
        [me.userId, destination.deviceId, destination.identityKey],
      );
      if (pending.affectedRows > 0 || destination.transferred) {
        await writeOutbox(tx, { id: ids.next(), type: 'history.synced', key: me.userId, payload: { userId: me.userId, deviceId: destination.deviceId } });
      }
      return pending.affectedRows > 0;
    });
    relay.kick();
    return { completed };
  });

  app.get('/chat/history/transfer', auth, async (request) => {
    const me = caller(request);
    const query = target.extend({ before: id.optional() }).parse(request.query);
    await verifyDevices(me, query);
    const rows = await db.query<{ id: string; nonce: Buffer; key_sender: string; sealed_key: Buffer }>(
      `SELECT m.id, m.nonce, COALESCE(source.wrap_device_id, m.sender_device_id) AS key_sender, source.sealed_key
       ${ELIGIBLE}
       AND NOT EXISTS (SELECT 1 FROM message_keys destination WHERE destination.message_id = m.id AND destination.device_id = ?)
       ${query.before ? 'AND source.message_id < ?' : ''}
       ORDER BY source.message_id DESC LIMIT ${BATCH_SIZE}`,
      [me.userId, me.deviceId, query.deviceId, ...(query.before ? [query.before] : [])],
    );
    return {
      keys: rows.map((row) => ({ messageId: row.id, nonce: row.nonce.toString('base64url'), keySenderDeviceId: row.key_sender, sealedKey: row.sealed_key.toString('base64url') })),
      nextBefore: rows.length === BATCH_SIZE ? rows.at(-1)!.id : null,
    };
  });

  app.post('/chat/history/transfer', auth, async (request) => {
    const me = caller(request);
    const input = batch.parse(request.body);
    await verifyDevices(me, input.target);
    const submitted = new Map(input.keys.map((key) => [key.messageId, key]));
    const added = await db.tx(async (tx) => {
      // Lock the message while attaching a wrapper for this version of its ciphertext.
      const rows = await tx.query<{ id: string; nonce: Buffer }>(
        `SELECT m.id, m.nonce ${ELIGIBLE} AND m.id IN (${[...submitted].map(() => '?').join(',')}) ORDER BY m.id FOR UPDATE`,
        [me.userId, me.deviceId, ...submitted.keys()],
      );
      const valid = rows.filter((row) => row.nonce.toString('base64url') === submitted.get(row.id)!.nonce);
      if (!valid.length) return 0;
      const result = await tx.run(
        `INSERT IGNORE INTO message_keys (message_id, device_id, sealed_key, wrap_device_id)
         VALUES ${valid.map(() => '(?, ?, ?, ?)').join(',')}`,
        valid.flatMap(({ id: messageId }) => [messageId, input.target.deviceId, Buffer.from(submitted.get(messageId)!.sealedKey, 'base64url'), me.deviceId]),
      );
      return result.affectedRows;
    });
    return { added };
  });
}
