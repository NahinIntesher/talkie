import { z } from 'zod';
import { createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus, startOutboxRelay } from '@talkie/bus';
import { createVerifier, installAuth } from '@talkie/auth-kit';
import { registerRoutes } from './routes.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4102),
  DB_NAME: z.string().default('talkie_users'),
  /** Public base URL for avatar downloads (media service). */
  MEDIA_PUBLIC_URL: z.string().default('/api/media'),
  MEDIA_URL: z.url().default('http://127.0.0.1:4105'),
});

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'users', env, ready: () => db.ping() });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);
registerRoutes(service.app, db, ids, guards, env.MEDIA_PUBLIC_URL, async (ownerId, mediaId) => {
  const response = await fetch(`${env.MEDIA_URL}/internal/media/verify`, {
    method: "POST",
    headers: { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ ownerId, mediaIds: [mediaId], purposes: ["avatar"] }),
    signal: AbortSignal.timeout(5000),
  });
  return response.ok && ((await response.json()) as { valid: string[] }).valid.includes(mediaId);
});

const bus = createBus(env, service.log, 'users');
const relay = startOutboxRelay(db, bus, service.log);

// Remember "last seen" when the realtime service reports that a person's last device went offline.
bus.subscribe('users', ['presence.offline'], async (event) => {
  const { userId, at } = event.payload as { userId: string; at: string };
  await db.run('UPDATE profiles SET last_seen_at = ? WHERE user_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)', [
    new Date(at),
    userId,
    new Date(at),
  ]);
});

service.onShutdown(async () => {
  relay.stop();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
