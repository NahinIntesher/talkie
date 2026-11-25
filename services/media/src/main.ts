import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { createService, fail, loadConfig, configPath, Snowflake } from '@talkie/core';
import { connectDatabase, isDuplicate, writeOutbox } from '@talkie/db';
import { createBus, startOutboxRelay } from '@talkie/bus';
import { caller, createVerifier, installAuth } from '@talkie/auth-kit';
import * as contract from '@talkie/contracts';
import { diskStorage, joinKey, s3Storage } from './storage.ts';

/**
 * Media: stores uploaded files. Message and status media arrive already encrypted by the sender's device; the
 * server only keeps opaque bytes. Profile and group photos are plain images, resized here to 640 px JPEG.
 */
const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4105),
  DB_NAME: z.string().default('talkie_media'),
  STORAGE_DRIVER: z.enum(['disk', 's3']).default('disk'),
  STORAGE_DIR: z.string().default('data/media'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Per-person storage for message and status media. */
  USER_QUOTA_BYTES: z.coerce.number().int().positive().default(20 * 1024 ** 3),
});

const storage =
  env.STORAGE_DRIVER === 's3'
    ? s3Storage({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET ?? fail('internal', 'S3_BUCKET is required'), accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' })
    : diskStorage(configPath(env.STORAGE_DIR));

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'media', env, ready: () => db.ping(), rateLimitPerMinute: 2000, bodyLimit: contract.MEDIA_PART_SIZE + 1024 });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);
const bus = createBus(env, service.log, 'media');
const relay = startOutboxRelay(db, bus, service.log);
const app = service.app;

app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: contract.MEDIA_PART_SIZE + 1024 }, (_request, body, done) => done(null, body));

interface MediaRow {
  id: string;
  owner_id: string;
  purpose: 'avatar' | 'group_avatar' | 'message' | 'status' | 'recording' | 'meeting_file';
  storage_key: string;
  content_type: string;
  byte_size: string;
  status: 'pending' | 'ready' | 'deleted';
  s3_upload_id: string | null;
  created_at: Date;
}

/** How much of an unfinished upload has arrived, from its part rows. */
const progress = async (id: string) => {
  const row = await db.one<{ parts: string; bytes: string | null }>('SELECT COUNT(*) AS parts, SUM(byte_size) AS bytes FROM upload_parts WHERE media_id = ?', [id]);
  return { parts: Number(row?.parts ?? 0), bytes: Number(row?.bytes ?? 0) };
};

const load = async (id: string) => {
  const row = await db.one<MediaRow>('SELECT * FROM media_objects WHERE id = ?', [id]);
  if (!row || row.status === 'deleted') fail('not_found', 'File not found.');
  return row!;
};

const isImage = (type: string) => /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/.test(type);

// ───────── Upload ─────────

app.post('/media/uploads', { preHandler: guards.requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
  const me = caller(request);
  const input = contract.createUpload.parse(request.body);
  if (input.byteSize > contract.MEDIA_LIMITS[input.purpose]) fail('bad_request', 'This file is too large.');
  if ((input.purpose === 'avatar' || input.purpose === 'group_avatar') && !isImage(input.contentType)) fail('bad_request', 'Choose a photo.');
  if (input.purpose === 'message' || input.purpose === 'status') {
    const usage = await db.one<{ bytes_used: string | null }>(
      "SELECT SUM(byte_size) AS bytes_used FROM media_objects WHERE owner_id = ? AND status = 'ready' AND purpose IN ('message','status')",
      [me.userId],
    );
    if (Number(usage?.bytes_used ?? 0) + input.byteSize > env.USER_QUOTA_BYTES) fail('forbidden', 'Your Talkie storage is full. Delete large chats to free space.');
  }
  const id = ids.next();
  const key = joinKey(input.purpose, me.userId.slice(-4), `${id}-${randomBytes(9).toString('base64url')}`);
  await db.run('INSERT INTO media_objects (id, owner_id, purpose, storage_key, content_type, byte_size, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    me.userId,
    input.purpose,
    key,
    input.contentType,
    input.byteSize,
    input.purpose === 'avatar' || input.purpose === 'group_avatar' ? 0 : 1,
  ]);
  reply.status(201);
  const body: contract.UploadCreated = { mediaId: id, partSize: contract.MEDIA_PART_SIZE, partsReceived: 0 };
  return body;
});

/** Parts must arrive in order (0, 1, 2…); resending the last accepted part is ignored, so retries are safe. */
app.put('/media/uploads/:id/parts/:index', { preHandler: guards.requireAuth, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (request) => {
  const me = caller(request);
  const { id, index } = z.object({ id: contract.id, index: z.coerce.number().int().min(0).max(100_000) }).parse(request.params);
  const data = request.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) fail('bad_request', 'Send the file part as application/octet-stream.');
  const row = await load(id);
  if (row.owner_id !== me.userId) fail('not_found', 'File not found.');
  if (row.status !== 'pending') fail('conflict', 'This upload is already finished.');
  const received = await progress(id);
  if (index < received.parts) return { partsReceived: received.parts };
  if (index !== received.parts) fail('conflict', `Expected part ${received.parts}.`, { partsReceived: received.parts });
  const total = Number(row.byte_size);
  const expected = Math.min(contract.MEDIA_PART_SIZE, total - received.bytes);
  if (data.length !== expected) fail('bad_request', `Part ${index} must be ${expected} bytes.`);
  const result = await storage.putPart(row.storage_key, index, data, row.s3_upload_id);
  try {
    await db.tx(async (tx) => {
      // The part row is the record of progress; its primary key makes a duplicate (racing retry) fail here.
      await tx.run('INSERT INTO upload_parts (media_id, part_number, byte_size, etag) VALUES (?, ?, ?, ?)', [id, index + 1, data.length, result.etag ?? null]);
      if (result.uploadId) await tx.run('UPDATE media_objects SET s3_upload_id = COALESCE(s3_upload_id, ?) WHERE id = ?', [result.uploadId, id]);
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
  }
  return { partsReceived: index + 1 };
});

app.get('/media/uploads/:id', { preHandler: guards.requireAuth }, async (request) => {
  const { id } = z.object({ id: contract.id }).parse(request.params);
  const row = await load(id);
  if (row.owner_id !== caller(request).userId) fail('not_found', 'File not found.');
  return { mediaId: id, partSize: contract.MEDIA_PART_SIZE, partsReceived: row.status === 'pending' ? (await progress(id)).parts : 0, status: row.status };
});

app.post('/media/uploads/:id/complete', { preHandler: guards.requireAuth }, async (request) => {
  const me = caller(request);
  const { id } = z.object({ id: contract.id }).parse(request.params);
  const row = await load(id);
  if (row.owner_id !== me.userId) fail('not_found', 'File not found.');
  if (row.status === 'ready') return { mediaId: id, status: 'ready' };
  const received = await progress(id);
  if (received.bytes !== Number(row.byte_size)) fail('conflict', 'The upload is not finished.', { partsReceived: received.parts });
  const parts = await db.query<{ etag: string }>('SELECT etag FROM upload_parts WHERE media_id = ? AND etag IS NOT NULL ORDER BY part_number', [id]);
  await storage.complete(row.storage_key, row.s3_upload_id, parts.map((p) => p.etag));

  let finalSize = Number(row.byte_size);
  let width: number | null = null;
  let height: number | null = null;
  if (row.purpose === 'avatar' || row.purpose === 'group_avatar') {
    // Re-encode photos: strips metadata (location, camera), fixes orientation, bounds the size.
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.read(row.storage_key)) chunks.push(chunk as Buffer);
    try {
      const output = await sharp(Buffer.concat(chunks), { failOn: 'error', limitInputPixels: 50_000_000 })
        .rotate()
        .resize(640, 640, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      await storage.put(row.storage_key, output.data, 'image/jpeg');
      finalSize = output.data.length;
      width = output.info.width;
      height = output.info.height;
    } catch {
      await storage.remove(row.storage_key);
      await db.run("UPDATE media_objects SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
      fail('bad_request', 'This photo could not be read. Try another one.');
    }
  }
  await db.tx(async (tx) => {
    await tx.run(
      "UPDATE media_objects SET status = 'ready', completed_at = CURRENT_TIMESTAMP(3), byte_size = ?, width = ?, height = ?, content_type = IF(purpose IN ('avatar','group_avatar'), 'image/jpeg', content_type) WHERE id = ?",
      [finalSize, width, height, id],
    );
    await tx.run('DELETE FROM upload_parts WHERE media_id = ?', [id]);
    await writeOutbox(tx, { id: ids.next(), type: 'media.ready', key: me.userId, payload: { mediaId: id, ownerId: me.userId, purpose: row.purpose, byteSize: finalSize } });
  });
  relay.kick();
  return { mediaId: id, status: 'ready' };
});

// ───────── Download ─────────

/**
 * Encrypted files: any signed-in person may fetch the bytes, which are useless without the key carried inside an
 * end-to-end encrypted message. Supports byte ranges so large files can resume.
 */
app.get('/media/files/:id', { preHandler: guards.requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
  const { id } = z.object({ id: contract.id }).parse(request.params);
  const row = await load(id);
  if (row.status !== 'ready' || !['message', 'status'].includes(row.purpose)) fail('not_found', 'File not found.');
  const size = Number(row.byte_size);
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''));
  reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=31536000, immutable').type('application/octet-stream');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start > end) return reply.status(416).header('content-range', `bytes */${size}`).send();
    reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(await storage.read(row.storage_key, { start, end }));
  }
  reply.header('content-length', size);
  return reply.send(await storage.read(row.storage_key));
});

/** Profile and group photos, for <img> tags (no auth header possible). Paths contain the unguessable media id. */
app.get('/media/avatars/:id', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (request, reply) => {
  const { id } = z.object({ id: contract.id }).parse(request.params);
  const row = await load(id);
  if (row.status !== 'ready' || !['avatar', 'group_avatar'].includes(row.purpose)) fail('not_found', 'File not found.');
  reply.header('cache-control', 'public, max-age=31536000, immutable').header('content-length', Number(row.byte_size)).type('image/jpeg');
  return reply.send(await storage.read(row.storage_key));
});

app.delete('/media/files/:id', { preHandler: guards.requireAuth }, async (request) => {
  const me = caller(request);
  const { id } = z.object({ id: contract.id }).parse(request.params);
  const row = await load(id);
  if (row.owner_id !== me.userId) fail('not_found', 'File not found.');
  await removeMedia(row);
  return { ok: true };
});

async function removeMedia(row: MediaRow) {
  if (row.status === 'pending') await storage.abort(row.storage_key, row.s3_upload_id);
  else await storage.remove(row.storage_key).catch(() => {});
  await db.run("UPDATE media_objects SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status <> 'deleted'", [row.id]);
}

// ───────── Internal ─────────

/** Which of these files are finished uploads owned by `ownerId` for `purpose` (other services attach them). */
app.post('/internal/media/verify', { preHandler: guards.requireInternal }, async (request) => {
  const { ownerId, mediaIds, purposes } = z
    .object({ ownerId: contract.id, mediaIds: z.array(contract.id).min(1).max(50), purposes: z.array(z.enum(['message', 'status', 'avatar', 'group_avatar'])).min(1) })
    .parse(request.body);
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM media_objects WHERE owner_id = ? AND status = 'ready' AND purpose IN (${purposes.map(() => '?').join(',')}) AND id IN (${mediaIds.map(() => '?').join(',')})`,
    [ownerId, ...purposes, ...mediaIds],
  );
  return { valid: rows.map((row) => row.id) };
});

/** Files no longer referenced anywhere (expired status, deleted messages). */
app.post('/internal/media/release', { preHandler: guards.requireInternal }, async (request) => {
  const { mediaIds } = z.object({ mediaIds: z.array(contract.id).min(1).max(500) }).parse(request.body);
  for (const id of mediaIds) {
    const row = await db.one<MediaRow>('SELECT * FROM media_objects WHERE id = ?', [id]);
    if (row && row.status !== 'deleted') await removeMedia(row);
  }
  return { ok: true };
});

/** Storage numbers for the admin panel (files are encrypted, so only sizes and purposes are known). */
app.get('/internal/admin/stats', { preHandler: guards.requireInternal }, async () => {
  const rows = await db.query<{ purpose: string; files: string; bytes: string | null }>(
    "SELECT purpose, COUNT(*) AS files, SUM(byte_size) AS bytes FROM media_objects WHERE status = 'ready' GROUP BY purpose",
  );
  const byPurpose = Object.fromEntries(rows.map((row) => [row.purpose, { files: Number(row.files), bytes: Number(row.bytes ?? 0) }]));
  return {
    files: rows.reduce((sum, row) => sum + Number(row.files), 0),
    bytes: rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    byPurpose,
    driver: env.STORAGE_DRIVER,
  };
});

/** One person's storage use. */
app.get('/internal/admin/users/:userId', { preHandler: guards.requireInternal }, async (request) => {
  const { userId } = z.object({ userId: contract.id }).parse(request.params);
  const row = await db.one<{ files: string; bytes: string | null }>(
    "SELECT COUNT(*) AS files, SUM(byte_size) AS bytes FROM media_objects WHERE owner_id = ? AND status = 'ready'",
    [userId],
  );
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
});

// Unfinished uploads are cleaned up after a day.
const sweep = setInterval(async () => {
  try {
    const stale = await db.query<MediaRow>("SELECT * FROM media_objects WHERE status = 'pending' AND created_at < CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY LIMIT 200");
    for (const row of stale) await removeMedia(row);
  } catch (error) {
    service.log.error({ err: error }, 'media sweep failed');
  }
}, 15 * 60_000);
sweep.unref();

service.onShutdown(async () => {
  clearInterval(sweep);
  relay.stop();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
