import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { databaseName, sharedTableNames, tableRewriter, type BaseEnv } from '@talkie/core';

export type Row = RowDataPacket;
export type Params = Array<string | number | bigint | boolean | Date | Buffer | null>;

/** Anything that can run a query: the pool or a connection inside a transaction. */
export interface Executor {
  query<T = Row>(sql: string, params?: Params): Promise<T[]>;
  one<T = Row>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<ResultSetHeader>;
}

export interface Database extends Executor {
  pool: Pool;
  name: string;
  /** Runs `work` in one transaction; retries once on deadlock. */
  tx<T>(work: (tx: Executor) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const wrap = (target: Pool | PoolConnection, rewrite: (sql: string) => string): Executor => ({
  async query<T>(sql: string, params: Params = []) {
    const [rows] = await target.execute<RowDataPacket[]>(rewrite(sql), params as never);
    return rows as T[];
  },
  async one<T>(sql: string, params: Params = []) {
    const [rows] = await target.execute<RowDataPacket[]>(rewrite(sql), params as never);
    return rows[0] as T | undefined;
  },
  async run(sql: string, params: Params = []) {
    const [result] = await target.execute<ResultSetHeader>(rewrite(sql), params as never);
    return result;
  },
});

export function connectDatabase(env: BaseEnv, database: string): Database {
  // Single-database hosting: a few shared table names are renamed per service (see sharedTableNames).
  const rewrite = tableRewriter(sharedTableNames(env, database));
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: databaseName(env, database),
    connectionLimit: env.DB_POOL_SIZE,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
    ...(env.DB_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  // Every connection works in UTC, so CURRENT_TIMESTAMP and JavaScript dates agree whatever the server's zone is.
  (pool as unknown as { pool: { on(event: 'connection', fn: (c: { query(sql: string): void }) => void): void } }).pool.on(
    'connection',
    (connection) => connection.query("SET time_zone = '+00:00'"),
  );
  const executor = wrap(pool, rewrite);
  return {
    ...executor,
    pool,
    name: database,
    async tx<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const result = await work(wrap(connection, rewrite));
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback().catch(() => {});
          const code = (error as { code?: string }).code;
          if (attempt === 0 && (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT')) continue;
          throw error;
        } finally {
          connection.release();
        }
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

/** True when a MySQL error is a unique-key violation. */
export const isDuplicate = (error: unknown): boolean => (error as { code?: string }).code === 'ER_DUP_ENTRY';

export { writeOutbox, type OutboxEvent } from './outbox.ts';
export { migrate } from './migrate.ts';
