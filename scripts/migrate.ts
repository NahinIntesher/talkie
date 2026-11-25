// Applies every service's migrations: `npm run db:migrate` (all) or `npm run db:migrate -- auth users`.
import { resolve } from 'node:path';
import { databaseName, loadConfig } from '@talkie/core';
import { migrate } from '@talkie/db';

const env = loadConfig({});
const services = ['bus', 'auth', 'users', 'chat', 'media', 'meet', 'notify', 'admin'];
const chosen = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const targets = chosen.length ? chosen : services;

for (const service of targets) {
  if (!services.includes(service)) throw new Error(`Unknown service: ${service}`);
  console.log(databaseName(env, `talkie_${service}`));
  await migrate(env, `talkie_${service}`, resolve(import.meta.dirname, '..', 'database', service));
}
console.log('Migrations complete.');
