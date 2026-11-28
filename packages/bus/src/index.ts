import { Redis } from 'ioredis';
import type { BaseEnv, Logger } from '@talkie/core';
import { connectDatabase, type Database } from '@talkie/db';

/** An event as delivered to consumers. */
export interface BusEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  key: string;
  payload: T;
  occurredAt: string;
}

export type Handler = (event: BusEvent) => Promise<void>;

export interface Bus {
  publish(event: BusEvent): Promise<void>;
  /**
   * Consumes `types` as consumer group `group` (one delivery per group, shared between that group's replicas).
   * Handlers must be idempotent: delivery is at-least-once.
   */
  subscribe(group: string, types: string[], handler: Handler): void;
  close(): Promise<void>;
}

const STREAM_PREFIX = 'talkie:events:';
const MAX_STREAM_LENGTH = 100_000;

/** Redis Streams: durable, consumer groups, pending-entry recovery. Production driver. */
function redisBus(url: string, log: Logger, consumer: string): Bus {
  const publisher = new Redis(url, { maxRetriesPerRequest: 3 });
  const readers: Redis[] = [];
  let closed = false;
  return {
    async publish(event) {
      await publisher.xadd(STREAM_PREFIX + event.type, 'MAXLEN', '~', MAX_STREAM_LENGTH, '*', 'event', JSON.stringify(event));
    },
    subscribe(group, types, handler) {
      const reader = new Redis(url, { maxRetriesPerRequest: null });
      readers.push(reader);
      const streams = types.map((type) => STREAM_PREFIX + type);
      const loop = async () => {
        for (const stream of streams) {
          try {
            await reader.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
          } catch (error) {
            if (!String((error as Error).message).includes('BUSYGROUP')) throw error;
          }
        }
        // First drain this consumer's own unacknowledged entries (after a crash), then read new ones.
        let cursor = '0';
        while (!closed) {
          try {
            const result = (await reader.xreadgroup(
              'GROUP', group, consumer, 'COUNT', 50, 'BLOCK', 5_000, 'STREAMS', ...streams, ...streams.map(() => cursor),
            )) as Array<[string, Array<[string, string[]]>]> | null;
            if (!result) {
              cursor = '>';
              continue;
            }
            let any = false;
            for (const [stream, entries] of result) {
              for (const [entryId, fields] of entries) {
                any = true;
                const raw = fields[1];
                try {
                  if (raw) await handler(JSON.parse(raw) as BusEvent);
                  await reader.xack(stream, group, entryId);
                } catch (error) {
                  log.error({ err: error, stream, entryId }, 'event handler failed; will retry');
                }
              }
            }
            if (!any) cursor = '>';
          } catch (error) {
            if (closed) return;
            log.warn({ err: error }, 'bus read failed; retrying');
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      };
      void loop();
    },
    async close() {
      closed = true;
      await Promise.allSettled([publisher.quit(), ...readers.map((reader) => reader.disconnect())]);
    },
  };
}

/**
 * MySQL-backed event log (`talkie_bus`): lets separate processes share events without Redis.
 * Used for local development and small single-host installs.
 */
function mysqlBus(db: Database, log: Logger): Bus {
  const timers: NodeJS.Timeout[] = [];
  let closed = false;
  return {
    async publish(event) {
      await db.run(
        'INSERT IGNORE INTO events (id, event_type, event_key, payload, occurred_at) VALUES (?, ?, ?, ?, ?)',
        [event.id, event.type, event.key, JSON.stringify(event.payload), new Date(event.occurredAt)],
      );
    },
    subscribe(group, types, handler) {
      const placeholders = types.map(() => '?').join(',');
      const tick = async () => {
        if (closed) return;
        try {
          await db.run('INSERT IGNORE INTO consumer_offsets (consumer_group, last_event_id) VALUES (?, 0)', [group]);
          const offset = await db.one<{ last_event_id: string }>(
            'SELECT last_event_id FROM consumer_offsets WHERE consumer_group = ?', [group],
          );
          const rows = await db.query<{ id: string; event_type: string; event_key: string; payload: string | object; occurred_at: Date }>(
            `SELECT id, event_type, event_key, payload, occurred_at FROM events
             WHERE id > ? AND event_type IN (${placeholders}) ORDER BY id LIMIT 100`,
            [offset?.last_event_id ?? '0', ...types],
          );
          for (const row of rows) {
            await handler({
              id: row.id,
              type: row.event_type,
              key: row.event_key,
              payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>),
              occurredAt: row.occurred_at.toISOString(),
            });
            await db.run('UPDATE consumer_offsets SET last_event_id = ? WHERE consumer_group = ?', [row.id, group]);
          }
        } catch (error) {
          log.error({ err: error, group }, 'event handler failed; will retry');
        }
        if (!closed) timers.push(setTimeout(tick, 250));
      };
      void tick();
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      await db.close();
    },
  };
}

/** In-process only (tests). */
export function memoryBus(): Bus {
  const handlers: Array<{ types: string[]; handler: Handler }> = [];
  return {
    async publish(event) {
      for (const entry of handlers) if (entry.types.includes(event.type)) await entry.handler(event);
    },
    subscribe(_group, types, handler) {
      handlers.push({ types, handler });
    },
    async close() {},
  };
}

/**
 * Every service running inside one Node.js process (cPanel "Setup Node.js App", see infra/cpanel/app.cjs).
 * Each service bundle has its own copy of this module, so subscribers meet in a registry on `globalThis`.
 * Delivery stays reliable: events come from each service's outbox, and a failing handler is retried on its own
 * (handlers are idempotent) without holding up the others.
 */
export function processBus(log: Logger): Bus {
  type Entry = { group: string; types: string[]; handler: Handler };
  const registry = globalThis as unknown as Record<symbol, Entry[] | undefined>;
  const key = Symbol.for('talkie.bus.subscribers');
  const subscribers = (registry[key] ??= []);
  const mine: Entry[] = [];
  const deliver = async (entry: Entry, event: BusEvent, attempt = 0): Promise<void> => {
    try {
      await entry.handler(event);
    } catch (error) {
      if (attempt >= 6) return log.error({ err: error, group: entry.group, type: event.type }, 'event handler gave up');
      log.warn({ err: error, group: entry.group, type: event.type }, 'event handler failed; retrying');
      setTimeout(() => void deliver(entry, event, attempt + 1), 500 * 2 ** attempt).unref();
    }
  };
  return {
    async publish(event) {
      await Promise.all(subscribers.filter((entry) => entry.types.includes(event.type)).map((entry) => deliver(entry, event)));
    },
    subscribe(group, types, handler) {
      const entry = { group, types, handler };
      subscribers.push(entry);
      mine.push(entry);
    },
    async close() {
      for (const entry of mine) subscribers.splice(subscribers.indexOf(entry), 1);
    },
  };
}

export function createBus(env: BaseEnv, log: Logger, consumerName: string): Bus {
  if (env.BUS_DRIVER === 'process') return processBus(log);
  if (env.BUS_DRIVER === 'redis') {
    if (!env.REDIS_URL) throw new Error('BUS_DRIVER=redis needs REDIS_URL');
    return redisBus(env.REDIS_URL, log, `${consumerName}-${process.pid}`);
  }
  if (env.BUS_DRIVER === 'memory') return memoryBus();
  return mysqlBus(connectDatabase(env.DB_POOL_SHARED ? env : { ...env, DB_POOL_SIZE: 2 }, 'talkie_bus'), log);
}

export { startOutboxRelay, type OutboxRelay } from './relay.ts';
