import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

let loaded = false;
let envDirectory = process.cwd();

/** Loads `.env` from the repository root once (development only; production uses real env vars). */
function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  for (const directory of [process.cwd(), resolve(process.cwd(), '../..')]) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      envDirectory = directory;
      return;
    }
  }
}

/** Resolves a relative path from configuration against the folder that holds `.env` (the repository root). */
export const configPath = (path: string): string => (isAbsolute(path) ? path : resolve(envDirectory, path));

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** Settings every service shares. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  /** Extra allowed browser origins, comma separated. */
  CORS_ORIGINS: z.string().default(''),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  /** Read the database password from this file (Docker secret) when DB_PASSWORD is empty. */
  DB_PASSWORD_FILE: z.string().optional(),
  /**
   * Hosting that dictates database names (cPanel: `account_…`): `talkie_auth` becomes `<prefix>auth`, and so on.
   * Empty keeps the default `talkie_<service>` names.
   */
  DB_NAME_PREFIX: z.string().regex(/^[A-Za-z0-9_]*$/).default(''),
  /**
   * Hosting with a single database: every service uses this one. The few table names two services share
   * (outbox, processed_events, poll_votes) get the service's name in front, e.g. `chat_outbox`.
   */
  DB_SHARED_NAME: z.string().regex(/^[A-Za-z0-9_]*$/).default(''),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_POOL_SHARED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  AUTH_URL: z.url().default('http://127.0.0.1:4101'),
  DB_SSL: bool.default(false),
  REDIS_URL: z.string().optional(),
  /**
   * `redis` with Docker (several processes and replicas); `process` when every service runs in one Node.js process
   * (cPanel); `mysql` lets separate local processes share events without Redis (development).
   */
  BUS_DRIVER: z.enum(['redis', 'mysql', 'memory', 'process']).default('mysql'),
  /** Snowflake worker id, unique per running replica (0–1023). `auto` derives it from the container's IP address. */
  WORKER_ID: z.union([z.literal('auto'), z.coerce.number().int().min(0).max(1023)]).default(0),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PUBLIC_KEY_FILE: z.string().optional(),
  JWT_ISSUER: z.string().default('talkie-auth'),
  JWT_AUDIENCE: z.string().default('talkie'),
  /** Shared secret for service-to-service calls on the private network. */
  INTERNAL_TOKEN: z.string().min(32).default('development-internal-token-change-me-0000'),
  TRUST_PROXY: bool.default(true),
});

type DbNaming = { DB_NAME_PREFIX?: string; DB_SHARED_NAME?: string };

/** The real database name for a service's default name (`talkie_auth` → `<DB_NAME_PREFIX>auth`, or the shared one). */
export const databaseName = (env: DbNaming, name: string) =>
  env.DB_SHARED_NAME && name.startsWith('talkie_')
    ? env.DB_SHARED_NAME
    : env.DB_NAME_PREFIX && name.startsWith('talkie_')
      ? env.DB_NAME_PREFIX + name.slice('talkie_'.length)
      : name;

/** In single-database mode, the tables a service must rename so services do not collide (`outbox` → `chat_outbox`). */
export function sharedTableNames(env: DbNaming, name: string): Record<string, string> | null {
  if (!env.DB_SHARED_NAME || !name.startsWith('talkie_')) return null;
  const service = name.slice('talkie_'.length);
  const renames: Record<string, string> = { outbox: `${service}_outbox`, processed_events: `${service}_processed_events`, schema_migrations: `${service}_schema_migrations` };
  // Meetings have their own polls; chat keeps the plain name.
  if (service === 'meet') renames.poll_votes = 'meet_poll_votes';
  if (service === 'bus') Object.assign(renames, { events: 'bus_events', consumer_offsets: 'bus_consumer_offsets' });
  return renames;
}

/** Rewrites table names in SQL text (whole words only). Returns the SQL unchanged when there is nothing to rename. */
export function tableRewriter(renames: Record<string, string> | null): (sql: string) => string {
  if (!renames || !Object.keys(renames).length) return (sql) => sql;
  // Whole table names only: not part of a longer word (`ix_outbox_pending`), not quoted, not `db.table`.
  const pattern = new RegExp(String.raw`(?<![\w` + '`' + String.raw`.])(` + Object.keys(renames).join('|') + String.raw`)(?![\w` + '`' + String.raw`])`, 'g');
  const cache = new Map<string, string>();
  return (sql) => {
    let out = cache.get(sql);
    if (out === undefined) {
      out = sql.replace(pattern, (word) => renames[word]!);
      if (cache.size < 5000) cache.set(sql, out);
    }
    return out;
  };
}

export type BaseEnv = Omit<z.infer<typeof baseEnvSchema>, 'WORKER_ID'> & { WORKER_ID: number };

/**
 * A worker id from the container's private IPv4 address. Docker hands out addresses in order inside a network,
 * so replicas get different values (the last 10 bits of the address).
 */
export function workerIdFromAddress(): number {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        const [, , c, d] = address.address.split('.').map(Number);
        return ((c! & 0b11) << 8) | d!;
      }
    }
  }
  return 0;
}

/** Parses the environment with the base schema plus a service's own fields. Fails fast with a clear message. */
export function loadConfig<T extends z.ZodRawShape>(extra: T): BaseEnv & z.infer<z.ZodObject<T>> {
  loadEnvFile();
  const schema = baseEnvSchema.extend(extra);
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const value = parsed.data as BaseEnv & z.infer<z.ZodObject<T>>;
  if ((value as { WORKER_ID: unknown }).WORKER_ID === 'auto') value.WORKER_ID = workerIdFromAddress();
  if (!value.DB_PASSWORD && value.DB_PASSWORD_FILE) value.DB_PASSWORD = readFileSync(configPath(value.DB_PASSWORD_FILE), 'utf8').trim();
  if (value.NODE_ENV === 'production' && value.INTERNAL_TOKEN.startsWith('development-'))
    throw new Error('Invalid configuration:\n  INTERNAL_TOKEN must be set to a strong secret in production');
  return value;
}
