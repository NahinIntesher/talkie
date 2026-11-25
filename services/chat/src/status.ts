import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from '@talkie/core';
import { caller } from '@talkie/auth-kit';
import * as contract from '@talkie/contracts';
import { decode, emit, type Context } from './context.ts';

interface StatusRow {
  id: string;
  owner_id: string;
  sender_device_id: string;
  kind: contract.WireStatus['kind'];
  ciphertext: Buffer;
  nonce: Buffer;
  sealed_key: Buffer | null;
  created_at: Date;
  expires_at: Date;
  viewed: number;
}

const toWire = (row: StatusRow): contract.WireStatus => ({
  id: row.id,
  ownerId: row.owner_id,
  senderDeviceId: row.sender_device_id,
  kind: row.kind,
  ciphertext: row.ciphertext.toString('base64url'),
  nonce: row.nonce.toString('base64url'),
  sealedKey: row.sealed_key ? row.sealed_key.toString('base64url') : null,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  viewed: Number(row.viewed) === 1,
});

/**
 * Status updates: shared for 24 hours with an audience the owner's device chooses (contacts, all except…,
 * only share with…). End-to-end encrypted exactly like messages.
 */
export function registerStatusRoutes(app: FastifyInstance, ctx: Context) {
  const { db, guards } = ctx;
  const auth = { preHandler: guards.requireAuth };

  /** Device keys of the people a status will be shared with. */
  app.post('/chat/status/devices', auth, async (request) => {
    const { userIds } = z.object({ userIds: z.array(contract.id).max(5000) }).parse(request.body);
    const me = caller(request);
    return { devices: await ctx.devices.forUsers([...new Set([...userIds, me.userId])]) };
  });

  app.post('/chat/status', { ...auth, bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const input = contract.createStatus.parse(request.body);
    if (input.kind !== 'text' && !input.mediaId) fail('bad_request', 'Attach the photo or video.');
    if (input.mediaId && !(await ctx.media.verify(me.userId, [input.mediaId], ['status'])).length) fail('bad_request', 'The file is still uploading.');
    const audience = [...new Set(input.audience)].filter((id) => id !== me.userId);
    const relationships = audience.length ? await ctx.users.relationships(me.userId, audience) : [];
    const allowed = audience.filter((id) => relationships.find((r) => r.userId === id && !r.blocked));
    const devices = await ctx.devices.forUsers([...allowed, me.userId]);
    const valid = new Set(devices.map((d) => d.deviceId));
    valid.add(me.deviceId);
    const keys = input.keys.filter((key) => valid.has(key.deviceId));
    const id = ctx.ids.next();
    await db.tx(async (tx) => {
      await tx.run('INSERT INTO statuses (id, owner_id, sender_device_id, kind, ciphertext, nonce, media_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        me.userId,
        me.deviceId,
        input.kind,
        decode(input.ciphertext),
        decode(input.nonce),
        input.mediaId ?? null,
        new Date(Date.now() + contract.STATUS_TTL_MS),
      ]);
      for (let offset = 0; offset < allowed.length; offset += 500) {
        const batch = allowed.slice(offset, offset + 500);
        await tx.run(`INSERT INTO status_audience (status_id, user_id) VALUES ${batch.map(() => '(?, ?)').join(',')}`, batch.flatMap((user) => [id, user]));
      }
      for (let offset = 0; offset < keys.length; offset += 500) {
        const batch = keys.slice(offset, offset + 500);
        await tx.run(`INSERT INTO status_keys (status_id, device_id, sealed_key) VALUES ${batch.map(() => '(?, ?, ?)').join(',')}`, batch.flatMap((key) => [id, key.deviceId, decode(key.sealedKey)]));
      }
      await emit(tx, ctx, 'status.updated', id, [me.userId, ...allowed], { statusId: id, ownerId: me.userId, change: 'posted' });
    });
    ctx.relay.kick();
    reply.status(201);
    return { id, sharedWith: allowed.length };
  });

  /** My own updates and everyone else's that I may see, newest first, grouped on the client by owner. */
  app.get('/chat/status/feed', auth, async (request) => {
    const me = caller(request);
    const columns = `s.id, s.owner_id, s.sender_device_id, s.kind, s.ciphertext, s.nonce, k.sealed_key, s.created_at, s.expires_at,
      EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = ?) AS viewed`;
    const [mine, others, muted] = await Promise.all([
      db.query<StatusRow>(
        `SELECT ${columns} FROM statuses s LEFT JOIN status_keys k ON k.status_id = s.id AND k.device_id = ?
         WHERE s.owner_id = ? AND s.expires_at > CURRENT_TIMESTAMP(3) ORDER BY s.id`,
        [me.userId, me.deviceId, me.userId],
      ),
      db.query<StatusRow>(
        `SELECT ${columns} FROM status_audience a JOIN statuses s ON s.id = a.status_id
         LEFT JOIN status_keys k ON k.status_id = s.id AND k.device_id = ?
         WHERE a.user_id = ? AND s.expires_at > CURRENT_TIMESTAMP(3) ORDER BY s.id LIMIT 2000`,
        [me.userId, me.deviceId, me.userId],
      ),
      db.query<{ muted_id: string }>('SELECT muted_id FROM status_mutes WHERE user_id = ?', [me.userId]),
    ]);
    const viewCounts = mine.length
      ? await db.query<{ status_id: string; total: number }>(
          `SELECT status_id, COUNT(*) AS total FROM status_views WHERE status_id IN (${mine.map(() => '?').join(',')}) GROUP BY status_id`,
          mine.map((s) => s.id),
        )
      : [];
    const counts = new Map(viewCounts.map((row) => [row.status_id, Number(row.total)]));
    return {
      mine: mine.map((row) => ({ ...toWire(row), viewCount: counts.get(row.id) ?? 0 })),
      others: others.map(toWire),
      mutedOwnerIds: muted.map((row) => row.muted_id),
    };
  });

  app.post('/chat/status/:id/view', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const { reaction } = z.object({ reaction: z.string().min(1).max(16).nullable().default(null) }).parse(request.body ?? {});
    const status = await db.one<{ owner_id: string }>(
      'SELECT s.owner_id FROM statuses s JOIN status_audience a ON a.status_id = s.id AND a.user_id = ? WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP(3)',
      [me.userId, id],
    );
    if (!status) fail('not_found', 'This status is no longer available.');
    await db.tx(async (tx) => {
      const result = await tx.run(
        `INSERT INTO status_views (status_id, viewer_id, reaction) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE reaction = COALESCE(VALUES(reaction), reaction)`,
        [id, me.userId, reaction],
      );
      if (result.affectedRows) await emit(tx, ctx, 'status.updated', id, [status!.owner_id], { statusId: id, ownerId: status!.owner_id, change: 'view', by: me.userId });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  app.get('/chat/status/:id/viewers', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const status = await db.one<{ owner_id: string }>('SELECT owner_id FROM statuses WHERE id = ?', [id]);
    if (!status || status.owner_id !== me.userId) fail('not_found', 'Status not found.');
    const rows = await db.query<{ viewer_id: string; viewed_at: Date; reaction: string | null }>(
      'SELECT viewer_id, viewed_at, reaction FROM status_views WHERE status_id = ? ORDER BY viewed_at DESC',
      [id],
    );
    const viewers: contract.StatusViewer[] = rows.map((row) => ({ userId: row.viewer_id, viewedAt: row.viewed_at.toISOString(), reaction: row.reaction }));
    return { viewers };
  });

  app.delete('/chat/status/:id', auth, async (request) => {
    const me = caller(request);
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const status = await db.one<{ owner_id: string; media_id: string | null }>('SELECT owner_id, media_id FROM statuses WHERE id = ?', [id]);
    if (!status || status.owner_id !== me.userId) fail('not_found', 'Status not found.');
    const audience = (await db.query<{ user_id: string }>('SELECT user_id FROM status_audience WHERE status_id = ?', [id])).map((a) => a.user_id);
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM statuses WHERE id = ?', [id]);
      await emit(tx, ctx, 'status.updated', id, [me.userId, ...audience], { statusId: id, ownerId: me.userId, change: 'deleted' });
    });
    ctx.relay.kick();
    if (status!.media_id) await ctx.media.release([status!.media_id]);
    return { ok: true };
  });

  app.put('/chat/status/mutes/:userId', auth, async (request) => {
    const me = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { muted } = z.object({ muted: z.boolean() }).parse(request.body);
    if (muted) await db.run('INSERT IGNORE INTO status_mutes (user_id, muted_id) VALUES (?, ?)', [me.userId, userId]);
    else await db.run('DELETE FROM status_mutes WHERE user_id = ? AND muted_id = ?', [me.userId, userId]);
    return { ok: true };
  });
}
