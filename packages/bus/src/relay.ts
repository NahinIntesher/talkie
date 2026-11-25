import type { Logger } from '@talkie/core';
import type { Database } from '@talkie/db';
import type { Bus } from './index.ts';

/**
 * Publishes a service's committed outbox rows to the bus, in id order, then marks them published.
 * `FOR UPDATE SKIP LOCKED` lets several replicas run the relay without sending a row twice at the same time.
 * Published rows are deleted after a day.
 */
export interface OutboxRelay {
  stop(): void;
  /** Publish now instead of waiting for the next tick (call right after a commit that wrote events). */
  kick(): void;
}

// Writes wake the relay at once (`kick`); the timer only catches anything missed. OUTBOX_POLL_MS slows it on shared hosting.
export function startOutboxRelay(db: Database, bus: Bus, log: Logger, intervalMs = Number(process.env.OUTBOX_POLL_MS) || 200): OutboxRelay {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastCleanup = 0;
  let running = false;
  let again = false;
  // MySQL 8 / MariaDB 10.6+ support SKIP LOCKED; older MariaDB (local XAMPP) falls back to a plain row lock.
  let lockClause = 'FOR UPDATE SKIP LOCKED';
  const tick = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    if (timer) clearTimeout(timer);
    let sent = 0;
    try {
      sent = await db.tx(async (tx) => {
        const rows = await tx.query<{ id: string; event_type: string; event_key: string; payload: string | object; created_at: Date }>(
          `SELECT id, event_type, event_key, payload, created_at FROM outbox
           WHERE published_at IS NULL ORDER BY id LIMIT 100 ${lockClause}`,
        );
        for (const row of rows) {
          await bus.publish({
            id: row.id,
            type: row.event_type,
            key: row.event_key,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>),
            occurredAt: row.created_at.toISOString(),
          });
        }
        if (rows.length)
          await tx.run(
            `UPDATE outbox SET published_at = CURRENT_TIMESTAMP(3) WHERE id IN (${rows.map(() => '?').join(',')})`,
            rows.map((row) => row.id),
          );
        return rows.length;
      });
      if (Date.now() - lastCleanup > 3_600_000) {
        lastCleanup = Date.now();
        await db.run('DELETE FROM outbox WHERE published_at < CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY LIMIT 10000');
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_PARSE_ERROR' && lockClause.includes('SKIP')) {
        lockClause = 'FOR UPDATE';
        log.warn('database has no SKIP LOCKED; run a single relay replica');
      } else log.error({ err: error }, 'outbox relay failed; will retry');
    }
    running = false;
    const soon = sent === 100 || again;
    again = false;
    if (!stopped) timer = setTimeout(tick, soon ? 0 : intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    kick: () => void tick(),
  };
}
