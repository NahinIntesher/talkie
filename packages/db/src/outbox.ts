import type { Executor } from './index.ts';

export interface OutboxEvent {
  /** Snowflake id of the event. */
  id: string;
  /** Stream / topic, e.g. `user.created`. */
  type: string;
  /** Business key used for ordering and de-duplication, e.g. the user id. */
  key: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox: call inside the same transaction as the business write.
 * The service's relay publishes pending rows to the bus and marks them sent, so an event exists if and only if
 * its write committed.
 */
export async function writeOutbox(tx: Executor, event: OutboxEvent): Promise<void> {
  await tx.run('INSERT INTO outbox (id, event_type, event_key, payload) VALUES (?, ?, ?, ?)', [
    event.id,
    event.type,
    event.key,
    JSON.stringify(event.payload),
  ]);
}
