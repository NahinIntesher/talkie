import { z } from 'zod';
import { createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus } from '@talkie/bus';
import { createVerifier, installAuth } from '@talkie/auth-kit';
import { clients } from './clients.ts';
import { registerRoutes } from './routes.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4108),
  DB_NAME: z.string().default('talkie_admin'),
  AUTH_URL: z.url().default('http://127.0.0.1:4101'),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  CHAT_URL: z.url().default('http://127.0.0.1:4103'),
  MEDIA_URL: z.url().default('http://127.0.0.1:4105'),
  MEET_URL: z.url().default('http://127.0.0.1:4106'),
});

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'admin', env, ready: () => db.ping(), rateLimitPerMinute: 300 });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);
registerRoutes(service.app, db, ids, guards, clients(env));

const bus = createBus(env, service.log, 'admin');

// Reports are filed in the users service and land in the moderation queue here. The report id makes it idempotent.
bus.subscribe('admin-reports', ['report.created'], async (event) => {
  const report = event.payload as { reportId: string; reporterId: string; targetType: string; targetId: string; reason: string; note: string };
  await db.run(
    'INSERT IGNORE INTO reports (id, reporter_id, target_type, target_id, reason, note) VALUES (?, ?, ?, ?, ?, ?)',
    [report.reportId, report.reporterId, report.targetType, report.targetId, report.reason, report.note ?? ''],
  );
});

service.onShutdown(async () => {
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
