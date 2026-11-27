import cookie from '@fastify/cookie';
import { createService, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus, startOutboxRelay } from '@talkie/bus';
import { createVerifier, installAuth } from '@talkie/auth-kit';
import { env } from './config.ts';
import { registerRoutes } from './routes.ts';
import { registerAdminRoutes } from './admin.ts';
import { enforceDeviceLimit, sessionIsActive } from './sessions.ts';

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'auth', env, ready: () => db.ping(), rateLimitPerMinute: 120 });
const ids = new Snowflake(env.WORKER_ID);
await enforceDeviceLimit(db, ids);

await service.app.register(cookie);
const guards = installAuth(
  service.app,
  await createVerifier(env, undefined, (auth) => sessionIsActive(db, auth)),
  env,
  new Set(['/auth/refresh', '/auth/otp/request', '/auth/otp/verify', '/auth/signup']),
);
registerRoutes(service.app, db, ids, guards);
registerAdminRoutes(service.app, db, ids, guards);

const bus = createBus(env, service.log, 'auth');
const relay = startOutboxRelay(db, bus, service.log);
service.onShutdown(async () => {
  relay.stop();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
