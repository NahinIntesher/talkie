import { z } from 'zod';
import { createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus, startOutboxRelay } from '@talkie/bus';
import { createVerifier, installAuth } from '@talkie/auth-kit';
import { createLiveKit } from './livekit.ts';
import { services, type Context } from './context.ts';
import { registerCallRoutes } from './calls.ts';
import { registerMeetingRoutes } from './meetings.ts';
import { registerAdminRoutes } from './admin.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4106),
  DB_NAME: z.string().default('talkie_meet'),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  AUTH_URL: z.url().default('http://127.0.0.1:4101'),
  CHAT_URL: z.url().default('http://127.0.0.1:4103'),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  RECORDING_S3_BUCKET: z.string().optional(),
  RECORDING_S3_REGION: z.string().optional(),
  RECORDING_S3_ENDPOINT: z.string().optional(),
  RECORDING_S3_ACCESS_KEY_ID: z.string().optional(),
  RECORDING_S3_SECRET_ACCESS_KEY: z.string().optional(),
});

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'meet', env, ready: () => db.ping(), rateLimitPerMinute: 600 });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);
const bus = createBus(env, service.log, 'meet');
const relay = startOutboxRelay(db, bus, service.log);
const lk = createLiveKit(env, service.log);
if (!lk.configured) service.log.warn('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set: calls and meetings are disabled');

// LiveKit signs the raw webhook body; keep it as text for verification.
service.app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

const ctx: Context = { db, ids, relay, guards, lk, env, services: services(env, service.log) };
const calls = registerCallRoutes(service.app, ctx);
bus.subscribe('meet-call-revocations', ['device.revoked'], async (event) => {
  const { deviceId } = event.payload as { deviceId: string };
  await calls.revokeDevice(deviceId);
});
registerMeetingRoutes(service.app, ctx, { callRoomFinished: calls.roomFinished });
registerAdminRoutes(service.app, ctx);

/** Lets clients know whether calls can be placed on this server. */
/** Install check for /api/health (internal only). */
service.app.get('/internal/selfcheck', { preHandler: guards.requireInternal }, async () => ({ livekit: await lk.check() }));

service.app.get('/meet/config', { preHandler: guards.requireAuth }, async () => ({ enabled: lk.configured, recording: lk.recordingAvailable }));

const sweep = setInterval(() => {
  calls.sweep().catch((error) => service.log.error({ err: error }, 'call sweep failed'));
}, 5_000);
sweep.unref();

service.onShutdown(async () => {
  clearInterval(sweep);
  relay.stop();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
