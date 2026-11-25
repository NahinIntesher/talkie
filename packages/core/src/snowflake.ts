/**
 * 64-bit time-ordered IDs: 41 bits of milliseconds since the Talkie epoch, 10 bits of worker id, 12 bits of sequence.
 * Sortable by creation time, unique across replicas (each replica has its own WORKER_ID), compact in an index.
 * Sent to clients as decimal strings because JavaScript numbers lose precision above 2^53.
 */
const EPOCH = 1_767_225_600_000n; // 2026-01-01T00:00:00Z
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export class Snowflake {
  private last = -1n;
  private sequence = 0n;
  private readonly worker: bigint;

  constructor(workerId: number) {
    if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) throw new Error('Worker id must be 0–1023');
    this.worker = BigInt(workerId);
  }

  next(): string {
    let now = BigInt(Date.now());
    if (now < this.last) now = this.last; // clock moved backwards: keep monotonic
    if (now === this.last) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        while (now <= this.last) now = BigInt(Date.now());
      }
    } else {
      this.sequence = 0n;
    }
    this.last = now;
    return (((now - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)) | (this.worker << SEQUENCE_BITS) | this.sequence).toString();
  }

  /** The smallest id that could have been made at `date`, for range scans over time-ordered primary keys. */
  static floor(date: Date): string {
    const ms = BigInt(Math.max(date.getTime(), Number(EPOCH)));
    return ((ms - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)).toString();
  }

  /** Creation time encoded in an id. */
  static timeOf(id: string): Date {
    return new Date(Number((BigInt(id) >> (WORKER_BITS + SEQUENCE_BITS)) + EPOCH));
  }
}

export const isSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < 1n << 63n;
