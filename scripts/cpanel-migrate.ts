// Bundled to migrate.mjs for the cPanel build: app.cjs runs it at start-up, so the tables are always up to date.
import { resolve } from 'node:path';
import { loadConfig } from '@talkie/core';
import { migrate } from '@talkie/db';

const SERVICES = ['bus', 'auth', 'users', 'chat', 'media', 'meet', 'notify', 'admin'];

export async function runMigrations(folder: string): Promise<void> {
  const env = loadConfig({});
  for (const service of SERVICES) await migrate(env, `talkie_${service}`, resolve(folder, service), (line) => console.log('[migrate]', line.trim()));
}
