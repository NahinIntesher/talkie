import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/meet/src/main.ts
import { z as z6 } from "zod";

// packages/core/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
var loaded = false;
var envDirectory = process.cwd();
function loadEnvFile() {
  if (loaded) return;
  loaded = true;
  for (const directory of [process.cwd(), resolve(process.cwd(), "../..")]) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      envDirectory = directory;
      return;
    }
  }
}
var configPath = (path) => isAbsolute(path) ? path : resolve(envDirectory, path);
var bool = z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1");
var baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
  /** Extra allowed browser origins, comma separated. */
  CORS_ORIGINS: z.string().default(""),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default("root"),
  DB_PASSWORD: z.string().default(""),
  /** Read the database password from this file (Docker secret) when DB_PASSWORD is empty. */
  DB_PASSWORD_FILE: z.string().optional(),
  /**
   * Hosting that dictates database names (cPanel: `account_…`): `talkie_auth` becomes `<prefix>auth`, and so on.
   * Empty keeps the default `talkie_<service>` names.
   */
  DB_NAME_PREFIX: z.string().regex(/^[A-Za-z0-9_]*$/).default(""),
  /**
   * Hosting with a single database: every service uses this one. The few table names two services share
   * (outbox, processed_events, poll_votes) get the service's name in front, e.g. `chat_outbox`.
   */
  DB_SHARED_NAME: z.string().regex(/^[A-Za-z0-9_]*$/).default(""),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  AUTH_URL: z.url().default("http://127.0.0.1:4101"),
  DB_SSL: bool.default(false),
  REDIS_URL: z.string().optional(),
  /**
   * `redis` with Docker (several processes and replicas); `process` when every service runs in one Node.js process
   * (cPanel); `mysql` lets separate local processes share events without Redis (development).
   */
  BUS_DRIVER: z.enum(["redis", "mysql", "memory", "process"]).default("mysql"),
  /** Snowflake worker id, unique per running replica (0–1023). `auto` derives it from the container's IP address. */
  WORKER_ID: z.union([z.literal("auto"), z.coerce.number().int().min(0).max(1023)]).default(0),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PUBLIC_KEY_FILE: z.string().optional(),
  JWT_ISSUER: z.string().default("talkie-auth"),
  JWT_AUDIENCE: z.string().default("talkie"),
  /** Shared secret for service-to-service calls on the private network. */
  INTERNAL_TOKEN: z.string().min(32).default("development-internal-token-change-me-0000"),
  TRUST_PROXY: bool.default(true)
});
var databaseName = (env2, name) => env2.DB_SHARED_NAME && name.startsWith("talkie_") ? env2.DB_SHARED_NAME : env2.DB_NAME_PREFIX && name.startsWith("talkie_") ? env2.DB_NAME_PREFIX + name.slice("talkie_".length) : name;
function sharedTableNames(env2, name) {
  if (!env2.DB_SHARED_NAME || !name.startsWith("talkie_")) return null;
  const service2 = name.slice("talkie_".length);
  const renames = { outbox: `${service2}_outbox`, processed_events: `${service2}_processed_events`, schema_migrations: `${service2}_schema_migrations` };
  if (service2 === "meet") renames.poll_votes = "meet_poll_votes";
  if (service2 === "bus") Object.assign(renames, { events: "bus_events", consumer_offsets: "bus_consumer_offsets" });
  return renames;
}
function tableRewriter(renames) {
  if (!renames || !Object.keys(renames).length) return (sql) => sql;
  const pattern = new RegExp(String.raw`(?<![\w` + "`" + String.raw`.])(` + Object.keys(renames).join("|") + String.raw`)(?![\w` + "`" + String.raw`])`, "g");
  const cache = /* @__PURE__ */ new Map();
  return (sql) => {
    let out = cache.get(sql);
    if (out === void 0) {
      out = sql.replace(pattern, (word) => renames[word]);
      if (cache.size < 5e3) cache.set(sql, out);
    }
    return out;
  };
}
function workerIdFromAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        const [, , c, d] = address.address.split(".").map(Number);
        return (c & 3) << 8 | d;
      }
    }
  }
  return 0;
}
function loadConfig(extra) {
  loadEnvFile();
  const schema = baseEnvSchema.extend(extra);
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:
${issues.join("\n")}`);
  }
  const value = parsed.data;
  if (value.WORKER_ID === "auto") value.WORKER_ID = workerIdFromAddress();
  if (!value.DB_PASSWORD && value.DB_PASSWORD_FILE) value.DB_PASSWORD = readFileSync(configPath(value.DB_PASSWORD_FILE), "utf8").trim();
  if (value.NODE_ENV === "production" && value.INTERNAL_TOKEN.startsWith("development-"))
    throw new Error("Invalid configuration:\n  INTERNAL_TOKEN must be set to a strong secret in production");
  return value;
}

// packages/core/src/errors.ts
var statusOf = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  otp_invalid: 400,
  otp_expired: 410,
  otp_attempts_exceeded: 429,
  username_taken: 409,
  username_reserved: 409,
  device_limit: 409,
  session_revoked: 401,
  blocked: 403,
  devices_changed: 409,
  unavailable: 503,
  internal: 500
};
var AppError = class extends Error {
  constructor(code2, message, details) {
    super(message);
    this.code = code2;
    this.details = details;
    this.name = "AppError";
    this.status = statusOf[code2];
  }
  code;
  details;
  status;
};
var fail = (code2, message, details) => {
  throw new AppError(code2, message, details);
};

// packages/core/src/logger.ts
import pino from "pino";
function createLogger(service2, level = "info") {
  return pino({
    name: service2,
    level,
    base: { service: service2 },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-internal-token"]',
        'res.headers["set-cookie"]',
        "*.password",
        "*.code",
        "*.refreshToken",
        "*.accessToken",
        "*.token"
      ],
      censor: "[redacted]"
    }
  });
}

// packages/core/src/server.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

// packages/core/src/crypto.ts
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
var safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// packages/core/src/server.ts
async function createService(options) {
  const { env: env2, name } = options;
  const log = createLogger(name, env2.LOG_LEVEL);
  const fastifyOptions = {
    loggerInstance: log,
    trustProxy: env2.TRUST_PROXY,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w-]{8,64}$/.test(given) ? given : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: "all", coerceTypes: false } }
  };
  const app = Fastify(fastifyOptions);
  const internalToken = Buffer.from(env2.INTERNAL_TOKEN);
  const redis = env2.REDIS_URL ? new Redis(env2.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2, enableAutoPipelining: true }) : null;
  redis?.on("error", (error) => log.warn({ err: error }, "redis error"));
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  const origins = /* @__PURE__ */ new Set([env2.PUBLIC_ORIGIN, ...env2.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)]);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || origins.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 600
  });
  await app.register(rateLimit, {
    global: true,
    max: options.rateLimitPerMinute ?? 300,
    timeWindow: "1 minute",
    ...redis ? { redis, nameSpace: `rl:${name}:` } : {},
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
    allowList: (request) => {
      const token = request.headers["x-internal-token"];
      return request.routeOptions.url?.startsWith("/internal/") === true && typeof token === "string" && safeEqual(Buffer.from(token), internalToken);
    },
    errorResponseBuilder: (_request, context) => new AppError("rate_limited", "Too many requests. Please slow down.", { retryAfterSeconds: Math.ceil(context.ttl / 1e3) })
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: "validation_failed",
          message: "Some fields are not valid.",
          details: { fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }
        }
      });
    }
    const err = error;
    if (err.validation) {
      return reply.status(422).send({ error: { code: "validation_failed", message: err.message ?? "Invalid request." } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: "bad_request", message: err.message ?? "Bad request." } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  });
  app.setNotFoundHandler(
    (_request, reply) => reply.status(404).send({ error: { code: "not_found", message: "Not found." } })
  );
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ status: "ok", service: name }));
  app.get("/readyz", { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await options.ready?.();
      if (redis) await redis.ping();
      return { status: "ready", service: name };
    } catch (error) {
      log.warn({ err: error }, "not ready");
      return reply.status(503).send({ status: "not_ready", service: name });
    }
  });
  const steps = [];
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const timer = setTimeout(() => process.exit(1), 15e3);
    timer.unref();
    try {
      await app.close();
      for (const step of steps.reverse()) await step();
      await redis?.quit();
    } catch (error) {
      log.error({ err: error }, "shutdown failed");
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return {
    app,
    log,
    redis,
    onShutdown: (step) => void steps.push(step),
    listen: async (port) => {
      await app.listen({ port, host: env2.HOST });
    }
  };
}

// packages/core/src/snowflake.ts
var EPOCH = 1767225600000n;
var WORKER_BITS = 10n;
var SEQUENCE_BITS = 12n;
var MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;
var Snowflake = class {
  last = -1n;
  sequence = 0n;
  worker;
  constructor(workerId) {
    if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) throw new Error("Worker id must be 0\u20131023");
    this.worker = BigInt(workerId);
  }
  next() {
    let now = BigInt(Date.now());
    if (now < this.last) now = this.last;
    if (now === this.last) {
      this.sequence = this.sequence + 1n & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        while (now <= this.last) now = BigInt(Date.now());
      }
    } else {
      this.sequence = 0n;
    }
    this.last = now;
    return (now - EPOCH << WORKER_BITS + SEQUENCE_BITS | this.worker << SEQUENCE_BITS | this.sequence).toString();
  }
  /** The smallest id that could have been made at `date`, for range scans over time-ordered primary keys. */
  static floor(date) {
    const ms = BigInt(Math.max(date.getTime(), Number(EPOCH)));
    return (ms - EPOCH << WORKER_BITS + SEQUENCE_BITS).toString();
  }
  /** Creation time encoded in an id. */
  static timeOf(id2) {
    return new Date(Number((BigInt(id2) >> WORKER_BITS + SEQUENCE_BITS) + EPOCH));
  }
};

// packages/core/src/net.ts
async function lookupInternal(token, log, operation, url, body, retry = true) {
  let status;
  for (let attempt = 0; ; attempt++) {
    status = void 0;
    try {
      const response = await fetch(url, {
        method: body === void 0 ? "GET" : "POST",
        headers: { "x-internal-token": token, ...body === void 0 ? {} : { "content-type": "application/json" } },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: AbortSignal.timeout(3e3)
      });
      status = response.status;
      if (response.ok) return await response.json();
      await response.body?.cancel();
    } catch {
    }
    if (status === 404) throw new AppError("not_found", "Not found.");
    if (!retry || attempt > 0 || status !== void 0 && status >= 400 && status < 500) break;
    await new Promise((resolve2) => setTimeout(resolve2, 250));
  }
  log.warn({ operation, upstreamStatus: status }, "internal service request failed");
  throw new AppError("unavailable", "Talkie is busy right now. Please try again in a moment.");
}

// packages/core/src/series.ts
function dailySeries(rows, days, now = /* @__PURE__ */ new Date()) {
  const byDay = new Map(rows.map((row) => [row.day, Number(row.total)]));
  const out = [];
  for (let index = days - 1; index >= 0; index--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - index)).toISOString().slice(0, 10);
    out.push({ day, total: byDay.get(day) ?? 0 });
  }
  return out;
}
var seriesStart = (days, now = /* @__PURE__ */ new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));

// packages/db/src/index.ts
import mysql2 from "mysql2/promise";

// packages/db/src/outbox.ts
async function writeOutbox(tx, event) {
  await tx.run("INSERT INTO outbox (id, event_type, event_key, payload) VALUES (?, ?, ?, ?)", [
    event.id,
    event.type,
    event.key,
    JSON.stringify(event.payload)
  ]);
}

// packages/db/src/migrate.ts
import mysql from "mysql2/promise";

// packages/db/src/index.ts
var wrap = (target, rewrite) => ({
  async query(sql, params = []) {
    const [rows] = await target.execute(rewrite(sql), params);
    return rows;
  },
  async one(sql, params = []) {
    const [rows] = await target.execute(rewrite(sql), params);
    return rows[0];
  },
  async run(sql, params = []) {
    const [result] = await target.execute(rewrite(sql), params);
    return result;
  }
});
function connectDatabase(env2, database) {
  const rewrite = tableRewriter(sharedTableNames(env2, database));
  const pool = mysql2.createPool({
    host: env2.DB_HOST,
    port: env2.DB_PORT,
    user: env2.DB_USER,
    password: env2.DB_PASSWORD,
    database: databaseName(env2, database),
    connectionLimit: env2.DB_POOL_SIZE,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 1e4,
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
    ...env2.DB_SSL ? { ssl: { rejectUnauthorized: true } } : {}
  });
  pool.pool.on(
    "connection",
    (connection) => connection.query("SET time_zone = '+00:00'")
  );
  const executor = wrap(pool, rewrite);
  return {
    ...executor,
    pool,
    name: database,
    async tx(work) {
      for (let attempt = 0; ; attempt++) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const result = await work(wrap(connection, rewrite));
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback().catch(() => {
          });
          const code2 = error.code;
          if (attempt === 0 && (code2 === "ER_LOCK_DEADLOCK" || code2 === "ER_LOCK_WAIT_TIMEOUT")) continue;
          throw error;
        } finally {
          connection.release();
        }
      }
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    }
  };
}
var isDuplicate = (error) => error.code === "ER_DUP_ENTRY";

// packages/bus/src/index.ts
import { Redis as Redis2 } from "ioredis";

// packages/bus/src/relay.ts
function startOutboxRelay(db2, bus2, log, intervalMs = Number(process.env.OUTBOX_POLL_MS) || 200) {
  let stopped = false;
  let timer;
  let lastCleanup = 0;
  let running = false;
  let again = false;
  let lockClause = "FOR UPDATE SKIP LOCKED";
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
      sent = await db2.tx(async (tx) => {
        const rows = await tx.query(
          `SELECT id, event_type, event_key, payload, created_at FROM outbox
           WHERE published_at IS NULL ORDER BY id LIMIT 100 ${lockClause}`
        );
        for (const row of rows) {
          await bus2.publish({
            id: row.id,
            type: row.event_type,
            key: row.event_key,
            payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
            occurredAt: row.created_at.toISOString()
          });
        }
        if (rows.length)
          await tx.run(
            `UPDATE outbox SET published_at = CURRENT_TIMESTAMP(3) WHERE id IN (${rows.map(() => "?").join(",")})`,
            rows.map((row) => row.id)
          );
        return rows.length;
      });
      if (Date.now() - lastCleanup > 36e5) {
        lastCleanup = Date.now();
        await db2.run("DELETE FROM outbox WHERE published_at < CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY LIMIT 10000");
      }
    } catch (error) {
      if (error.code === "ER_PARSE_ERROR" && lockClause.includes("SKIP")) {
        lockClause = "FOR UPDATE";
        log.warn("database has no SKIP LOCKED; run a single relay replica");
      } else log.error({ err: error }, "outbox relay failed; will retry");
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
    kick: () => void tick()
  };
}

// packages/bus/src/index.ts
var STREAM_PREFIX = "talkie:events:";
var MAX_STREAM_LENGTH = 1e5;
function redisBus(url, log, consumer) {
  const publisher = new Redis2(url, { maxRetriesPerRequest: 3 });
  const readers = [];
  let closed = false;
  return {
    async publish(event) {
      await publisher.xadd(STREAM_PREFIX + event.type, "MAXLEN", "~", MAX_STREAM_LENGTH, "*", "event", JSON.stringify(event));
    },
    subscribe(group, types, handler) {
      const reader = new Redis2(url, { maxRetriesPerRequest: null });
      readers.push(reader);
      const streams = types.map((type) => STREAM_PREFIX + type);
      const loop = async () => {
        for (const stream of streams) {
          try {
            await reader.xgroup("CREATE", stream, group, "0", "MKSTREAM");
          } catch (error) {
            if (!String(error.message).includes("BUSYGROUP")) throw error;
          }
        }
        let cursor = "0";
        while (!closed) {
          try {
            const result = await reader.xreadgroup(
              "GROUP",
              group,
              consumer,
              "COUNT",
              50,
              "BLOCK",
              5e3,
              "STREAMS",
              ...streams,
              ...streams.map(() => cursor)
            );
            if (!result) {
              cursor = ">";
              continue;
            }
            let any = false;
            for (const [stream, entries] of result) {
              for (const [entryId, fields] of entries) {
                any = true;
                const raw = fields[1];
                try {
                  if (raw) await handler(JSON.parse(raw));
                  await reader.xack(stream, group, entryId);
                } catch (error) {
                  log.error({ err: error, stream, entryId }, "event handler failed; will retry");
                }
              }
            }
            if (!any) cursor = ">";
          } catch (error) {
            if (closed) return;
            log.warn({ err: error }, "bus read failed; retrying");
            await new Promise((resolve2) => setTimeout(resolve2, 1e3));
          }
        }
      };
      void loop();
    },
    async close() {
      closed = true;
      await Promise.allSettled([publisher.quit(), ...readers.map((reader) => reader.disconnect())]);
    }
  };
}
function mysqlBus(db2, log) {
  const timers = [];
  let closed = false;
  return {
    async publish(event) {
      await db2.run(
        "INSERT IGNORE INTO events (id, event_type, event_key, payload, occurred_at) VALUES (?, ?, ?, ?, ?)",
        [event.id, event.type, event.key, JSON.stringify(event.payload), new Date(event.occurredAt)]
      );
    },
    subscribe(group, types, handler) {
      const placeholders = types.map(() => "?").join(",");
      const tick = async () => {
        if (closed) return;
        try {
          await db2.run("INSERT IGNORE INTO consumer_offsets (consumer_group, last_event_id) VALUES (?, 0)", [group]);
          const offset = await db2.one(
            "SELECT last_event_id FROM consumer_offsets WHERE consumer_group = ?",
            [group]
          );
          const rows = await db2.query(
            `SELECT id, event_type, event_key, payload, occurred_at FROM events
             WHERE id > ? AND event_type IN (${placeholders}) ORDER BY id LIMIT 100`,
            [offset?.last_event_id ?? "0", ...types]
          );
          for (const row of rows) {
            await handler({
              id: row.id,
              type: row.event_type,
              key: row.event_key,
              payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
              occurredAt: row.occurred_at.toISOString()
            });
            await db2.run("UPDATE consumer_offsets SET last_event_id = ? WHERE consumer_group = ?", [row.id, group]);
          }
        } catch (error) {
          log.error({ err: error, group }, "event handler failed; will retry");
        }
        if (!closed) timers.push(setTimeout(tick, 250));
      };
      void tick();
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      await db2.close();
    }
  };
}
function memoryBus() {
  const handlers = [];
  return {
    async publish(event) {
      for (const entry of handlers) if (entry.types.includes(event.type)) await entry.handler(event);
    },
    subscribe(_group, types, handler) {
      handlers.push({ types, handler });
    },
    async close() {
    }
  };
}
function processBus(log) {
  const registry = globalThis;
  const key = /* @__PURE__ */ Symbol.for("talkie.bus.subscribers");
  const subscribers = registry[key] ??= [];
  const mine = [];
  const deliver = async (entry, event, attempt = 0) => {
    try {
      await entry.handler(event);
    } catch (error) {
      if (attempt >= 6) return log.error({ err: error, group: entry.group, type: event.type }, "event handler gave up");
      log.warn({ err: error, group: entry.group, type: event.type }, "event handler failed; retrying");
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
    }
  };
}
function createBus(env2, log, consumerName) {
  if (env2.BUS_DRIVER === "process") return processBus(log);
  if (env2.BUS_DRIVER === "redis") {
    if (!env2.REDIS_URL) throw new Error("BUS_DRIVER=redis needs REDIS_URL");
    return redisBus(env2.REDIS_URL, log, `${consumerName}-${process.pid}`);
  }
  if (env2.BUS_DRIVER === "memory") return memoryBus();
  return mysqlBus(connectDatabase({ ...env2, DB_POOL_SIZE: 2 }, "talkie_bus"), log);
}

// packages/auth-kit/src/index.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
var ACCESS_TOKEN_ALG = "EdDSA";
function readPublicKey(env2) {
  if (env2.JWT_PUBLIC_KEY) return env2.JWT_PUBLIC_KEY.replace(/\\n/g, "\n");
  if (env2.JWT_PUBLIC_KEY_FILE) return readFileSync2(configPath(env2.JWT_PUBLIC_KEY_FILE), "utf8");
  throw new Error("JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE is required");
}
var remoteSessionCheck = (env2) => async (auth) => {
  try {
    const result = await internalFetch(env2, `${env2.AUTH_URL}/internal/sessions/check`, {
      method: "POST",
      body: { userId: auth.userId, deviceId: auth.deviceId, sessionId: auth.sessionId }
    });
    return result.active === true;
  } catch {
    throw new AppError("unavailable", "Could not check your session. Try again.");
  }
};
async function createVerifier(env2, publicKeyPem = readPublicKey(env2), check = remoteSessionCheck(env2)) {
  const key = await importSPKI(publicKeyPem, ACCESS_TOKEN_ALG);
  return {
    async verify(token) {
      let auth;
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ACCESS_TOKEN_ALG],
          issuer: env2.JWT_ISSUER,
          audience: env2.JWT_AUDIENCE,
          clockTolerance: 5
        });
        if (!payload.sub || !payload.did || !payload.sid) throw new Error("incomplete token");
        auth = { userId: payload.sub, deviceId: payload.did, sessionId: payload.sid, role: payload.role ?? "user" };
      } catch {
        throw new AppError("unauthorized", "Your session has expired. Please sign in again.");
      }
      if (!await check(auth)) throw new AppError("session_revoked", "This device has been signed out.");
      return auth;
    }
  };
}
var bearer = (request) => {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return null;
};
function installAuth(app, verifier, env2, publicRoutes = /* @__PURE__ */ new Set()) {
  app.decorateRequest("auth", void 0);
  app.addHook("onRequest", async (request) => {
    if (publicRoutes.has(request.url.split("?")[0])) return;
    const token = bearer(request);
    if (token) request.auth = await verifier.verify(token);
  });
  const internal = Buffer.from(env2.INTERNAL_TOKEN);
  return {
    requireAuth: async (request, _reply) => {
      if (!request.auth) throw new AppError("unauthorized", "Please sign in.");
    },
    requireRole: (...roles) => async (request, _reply) => {
      if (!request.auth) throw new AppError("unauthorized", "Please sign in.");
      if (!roles.includes(request.auth.role)) throw new AppError("forbidden", "You do not have access to this.");
    },
    /** Service-to-service routes. Nginx never forwards `/internal/*` from the internet. */
    requireInternal: async (request, _reply) => {
      const given = Buffer.from(String(request.headers["x-internal-token"] ?? ""));
      if (given.length !== internal.length || !timingSafeEqual2(given, internal))
        throw new AppError("forbidden", "Internal route.");
    }
  };
}
var caller = (request) => {
  if (!request.auth) throw new AppError("unauthorized", "Please sign in.");
  return request.auth;
};
async function internalFetch(env2, url, init = {}) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      "x-internal-token": env2.INTERNAL_TOKEN,
      ...init.body === void 0 ? {} : { "content-type": "application/json" }
    },
    body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5e3)
  });
  if (!response.ok) throw new AppError("unavailable", `Internal call failed (${response.status})`);
  return await response.json();
}

// services/meet/src/livekit.ts
import { AccessToken, EgressClient, EncodedFileOutput, RoomServiceClient, StreamOutput, StreamProtocol, TrackSource, WebhookReceiver, S3Upload } from "livekit-server-sdk";
function createLiveKit(env2, log) {
  const configured = !!(env2.LIVEKIT_URL && env2.LIVEKIT_API_KEY && env2.LIVEKIT_API_SECRET);
  const httpUrl = env2.LIVEKIT_URL?.replace(/^ws(s?):\/\//, "http$1://");
  const rooms = configured ? new RoomServiceClient(httpUrl, env2.LIVEKIT_API_KEY, env2.LIVEKIT_API_SECRET) : null;
  const egress = configured ? new EgressClient(httpUrl, env2.LIVEKIT_API_KEY, env2.LIVEKIT_API_SECRET) : null;
  const receiver = configured ? new WebhookReceiver(env2.LIVEKIT_API_KEY, env2.LIVEKIT_API_SECRET) : null;
  const require2 = () => {
    if (!configured) throw new AppError("unavailable", "Calls and meetings are not set up on this server yet.");
  };
  const sourceList = (sources) => [sources.camera && TrackSource.CAMERA, sources.microphone && TrackSource.MICROPHONE, sources.screen && TrackSource.SCREEN_SHARE, sources.screen && TrackSource.SCREEN_SHARE_AUDIO].filter(
    (value) => value !== false
  );
  const attempt = async (label, work) => {
    if (!configured) return;
    try {
      await work();
    } catch (error) {
      log.warn({ err: error, action: label }, "media server call failed");
    }
  };
  return {
    configured,
    url: env2.LIVEKIT_URL ?? "",
    async connectedUsers(room) {
      require2();
      try {
        return new Set((await rooms.listParticipants(room)).map((p) => p.identity));
      } catch (error) {
        if (error.code === "not_found") return /* @__PURE__ */ new Set();
        throw error;
      }
    },
    /** Install check: are the URL, key and secret accepted by the media server? Never returns secrets. */
    async check() {
      if (!configured) return "not configured";
      try {
        await Promise.race([rooms.listRooms(), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 6e3))]);
        return "ok";
      } catch (error) {
        const message = String(error?.message ?? error);
        return /401|unauthor|invalid/i.test(message) ? "rejected: wrong LIVEKIT_API_KEY or LIVEKIT_API_SECRET" : `unreachable: ${message.slice(0, 120)}`;
      }
    },
    async token(input) {
      require2();
      const token = new AccessToken(env2.LIVEKIT_API_KEY, env2.LIVEKIT_API_SECRET, {
        identity: input.identity,
        name: input.name,
        metadata: JSON.stringify(input.metadata),
        ttl: input.ttlSeconds ?? 6 * 3600
      });
      const grant = {
        room: input.room,
        roomJoin: true,
        canSubscribe: true,
        canPublish: input.sources.camera || input.sources.microphone || input.sources.screen,
        canPublishSources: sourceList(input.sources),
        canPublishData: input.sources.data,
        canUpdateOwnMetadata: false,
        roomAdmin: !!input.admin
      };
      token.addGrant(grant);
      return token.toJwt();
    },
    setPermissions: (room, identity, sources) => attempt(
      "updateParticipant",
      () => rooms.updateParticipant(room, identity, void 0, {
        canSubscribe: true,
        canPublish: sources.camera || sources.microphone || sources.screen,
        canPublishSources: sourceList(sources),
        canPublishData: sources.data,
        canUpdateMetadata: false,
        hidden: false,
        recorder: false,
        agent: false,
        canSubscribeMetrics: false
      })
    ),
    /** Mutes every published track of one source (e.g. microphone) for a participant. */
    async mute(room, identity, source) {
      await attempt("mute", async () => {
        const participant = await rooms.getParticipant(room, identity);
        const wanted = source === "microphone" ? TrackSource.MICROPHONE : TrackSource.CAMERA;
        for (const track of participant.tracks) if (track.source === wanted && !track.muted) await rooms.mutePublishedTrack(room, identity, track.sid, true);
      });
    },
    remove: (room, identity) => attempt("removeParticipant", () => rooms.removeParticipant(room, identity)),
    close: (room) => attempt("deleteRoom", () => rooms.deleteRoom(room)),
    /** Small JSON signal to everyone in a room (reactions, "lower your hand"…). */
    broadcast: (room, payload, identities) => attempt("sendData", () => rooms.sendData(room, new TextEncoder().encode(JSON.stringify(payload)), 0, { destinationIdentities: identities, topic: "talkie" })),
    recordingAvailable: configured && !!env2.RECORDING_S3_BUCKET,
    async startRecording(room, fileName) {
      require2();
      if (!env2.RECORDING_S3_BUCKET) throw new AppError("unavailable", "Recording needs cloud storage. Add RECORDING_S3_* settings on the server.");
      const output = new EncodedFileOutput({
        filepath: `recordings/${fileName}.mp4`,
        output: {
          case: "s3",
          value: new S3Upload({
            bucket: env2.RECORDING_S3_BUCKET,
            region: env2.RECORDING_S3_REGION ?? "auto",
            endpoint: env2.RECORDING_S3_ENDPOINT ?? "",
            accessKey: env2.RECORDING_S3_ACCESS_KEY_ID ?? "",
            secret: env2.RECORDING_S3_SECRET_ACCESS_KEY ?? "",
            forcePathStyle: !!env2.RECORDING_S3_ENDPOINT
          })
        }
      });
      const info = await egress.startRoomCompositeEgress(room, { file: output }, { layout: "grid" });
      return info.egressId;
    },
    async startStream(room, rtmpUrl) {
      require2();
      const info = await egress.startRoomCompositeEgress(room, { stream: new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [rtmpUrl] }) }, { layout: "speaker" });
      return info.egressId;
    },
    stopEgress: (egressId) => attempt("stopEgress", () => egress.stopEgress(egressId)),
    async verifyWebhook(body, authorization) {
      if (!receiver) throw new AppError("unavailable", "Not configured.");
      return receiver.receive(body, authorization);
    }
  };
}

// services/meet/src/context.ts
function services(env2, log) {
  const names = /* @__PURE__ */ new Map();
  return {
    conversation: (conversationId) => lookupInternal(env2.INTERNAL_TOKEN, log, "chat.members", `${env2.CHAT_URL}/internal/conversations/${conversationId}/members`),
    relationships: async (userId, otherIds) => (await lookupInternal(env2.INTERNAL_TOKEN, log, "users.relationships", `${env2.USERS_URL}/internal/relationships`, { userId, otherIds })).relationships,
    devices: async (userIds) => (await lookupInternal(env2.INTERNAL_TOKEN, log, "auth.device-keys", `${env2.AUTH_URL}/internal/device-keys`, { userIds })).devices,
    async displayName(userId) {
      const hit = names.get(userId);
      if (hit && Date.now() - hit.at < 3e5) return hit.name;
      const { profile } = await lookupInternal(env2.INTERNAL_TOKEN, log, "users.profile", `${env2.USERS_URL}/internal/profiles/${userId}`);
      names.set(userId, { at: Date.now(), name: profile.displayName });
      return profile.displayName;
    }
  };
}
async function emit(tx, ctx2, type, key, recipients, payload) {
  await writeOutbox(tx, { id: ctx2.ids.next(), type, key, payload: { recipients: [...new Set(recipients)], ...payload } });
}
var decode = (value) => Buffer.from(value, "base64url");

// services/meet/src/calls.ts
import { z as z3 } from "zod";

// packages/contracts/src/index.ts
import { z as z2 } from "zod";
var USERNAME_MIN = 3;
var USERNAME_MAX = 32;
var DISPLAY_NAME_MAX = 64;
var ABOUT_MAX = 140;
var OTP_LENGTH = 6;
var id = z2.string().regex(/^[1-9]\d{0,19}$/, "Invalid id");
var email = z2.string().trim().toLowerCase().max(254).pipe(z2.email("Enter a valid email address"));
var username = z2.string().trim().toLowerCase().min(USERNAME_MIN, `At least ${USERNAME_MIN} characters`).max(USERNAME_MAX, `At most ${USERNAME_MAX} characters`).regex(/^[a-z0-9._]+$/, "Use only letters, numbers, dot and underscore").refine((value) => !value.startsWith(".") && !value.endsWith(".") && !value.includes(".."), "Dots cannot be at the start, end or next to each other").refine((value) => /[a-z]/.test(value), "Include at least one letter");
var displayName = z2.string().trim().min(1, "Enter your name").max(DISPLAY_NAME_MAX, `At most ${DISPLAY_NAME_MAX} characters`).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Remove special control characters");
var about = z2.string().trim().max(ABOUT_MAX, `At most ${ABOUT_MAX} characters`);
var otpCode = z2.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);
var platform = z2.enum(["web", "android", "ios", "desktop"]);
var locale = z2.enum(["bn", "en"]);
var publicKey = z2.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid public key");
var device = z2.object({
  name: z2.string().trim().min(1).max(80),
  platform,
  /** Device identity key for end-to-end encryption, generated on the device. */
  identityKey: publicKey.optional()
});
var otpRequestKey = z2.string().regex(/^[A-Za-z0-9_-]{22}$/);
var otpRequest = z2.object({ email, locale: locale.default("bn"), requestKey: otpRequestKey.optional() });
var otpVerify = z2.union([
  z2.object({ challengeId: id, code: otpCode, device }),
  z2.object({ requestKey: otpRequestKey, code: otpCode, device })
]);
var signupComplete = z2.object({ signupToken: z2.string().min(20).max(512), username, displayName, device });
var usernameCheck = z2.object({ username });
var privacyAudience = z2.enum(["everyone", "contacts", "nobody"]);
var privacyKey = z2.enum(["last_seen", "online", "profile_photo", "about", "status", "groups_add"]);
var profileUpdate = z2.object({ displayName: displayName.optional(), about: about.optional(), locale: locale.optional() }).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var privacyUpdate = z2.object({
  settings: z2.array(z2.object({ key: privacyKey, audience: privacyAudience })).min(1).max(6).optional(),
  readReceipts: z2.boolean().optional()
});
var userReport = z2.object({
  reason: z2.enum(["spam", "harassment", "impersonation", "inappropriate", "other"]),
  note: z2.string().trim().max(500).default("")
});
var GROUP_NAME_MAX = 100;
var GROUP_DESCRIPTION_MAX = 2048;
var GROUP_MAX_MEMBERS = 1024;
var EDIT_WINDOW_MS = 15 * 6e4;
var DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 36e5;
var b64 = (maxChars) => z2.string().regex(/^[A-Za-z0-9_-]*$/, "Invalid encoding").max(maxChars);
var messageKind = z2.enum(["text", "image", "video", "audio", "voice", "document", "sticker", "location", "contact", "poll"]);
var clientMessageId = z2.string().regex(/^[0-9A-Za-z]{26}$/, "Invalid client message id");
var sealedKeys = z2.array(z2.object({ deviceId: id, sealedKey: b64(200) })).min(1).max(GROUP_MAX_MEMBERS * 5);
var sendMessage = z2.object({
  clientMessageId,
  kind: messageKind,
  ciphertext: b64(14e4),
  nonce: b64(40),
  keys: sealedKeys,
  replyToId: id.optional(),
  forwardedCount: z2.number().int().min(0).max(255).default(0),
  /** Uploaded (encrypted) files this message carries; their keys travel inside the ciphertext. */
  mediaIds: z2.array(id).max(10).default([])
});
var editMessage = z2.object({ ciphertext: b64(14e4), nonce: b64(40), keys: sealedKeys });
var createGroup = z2.object({
  name: z2.string().trim().min(1).max(GROUP_NAME_MAX),
  description: z2.string().trim().max(GROUP_DESCRIPTION_MAX).default(""),
  memberIds: z2.array(id).max(GROUP_MAX_MEMBERS - 1).default([])
});
var updateGroup = z2.object({
  name: z2.string().trim().min(1).max(GROUP_NAME_MAX).optional(),
  description: z2.string().trim().max(GROUP_DESCRIPTION_MAX).optional(),
  sendPolicy: z2.enum(["all", "admins"]).optional(),
  editInfoPolicy: z2.enum(["all", "admins"]).optional(),
  addMemberPolicy: z2.enum(["all", "admins"]).optional(),
  approvalRequired: z2.boolean().optional(),
  avatarMediaId: id.nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var conversationSettings = z2.object({
  mutedUntil: z2.iso.datetime().nullable().optional(),
  archived: z2.boolean().optional(),
  pinned: z2.boolean().optional(),
  markedUnread: z2.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var MEDIA_PART_SIZE = 8 * 1024 * 1024;
var MEDIA_CHUNK_SIZE = 64 * 1024;
var MEDIA_LIMITS = {
  message: 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024,
  status: 64 * 1024 * 1024,
  avatar: 10 * 1024 * 1024,
  group_avatar: 10 * 1024 * 1024
};
var createUpload = z2.object({
  purpose: z2.enum(["message", "status", "avatar", "group_avatar"]),
  byteSize: z2.number().int().positive(),
  /** Encrypted media is always application/octet-stream on the server; avatars are images. */
  contentType: z2.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(127)
});
var pollVote = z2.object({ options: z2.array(z2.number().int().min(0).max(11)).max(12) });
var STATUS_TTL_MS = 24 * 36e5;
var createStatus = z2.object({
  kind: z2.enum(["text", "image", "video"]),
  ciphertext: b64(2e4),
  nonce: b64(40),
  keys: sealedKeys,
  audience: z2.array(id).max(5e3),
  mediaId: id.optional()
});
var CALL_RING_MS = 45e3;
var GROUP_CALL_MAX = 32;
var startCall = z2.object({
  conversationId: id,
  media: z2.enum(["audio", "video"]),
  /** The call's media key sealed for every invited device (end-to-end encrypted calls). */
  keys: sealedKeys
});
var meetingAccess = z2.enum(["open", "trusted", "restricted"]);
var createMeeting = z2.object({
  title: z2.string().trim().max(160).default(""),
  description: z2.string().trim().max(2048).default(""),
  scheduledStartAt: z2.iso.datetime().nullable().default(null),
  scheduledEndAt: z2.iso.datetime().nullable().default(null),
  access: meetingAccess.default("trusted"),
  inviteeIds: z2.array(id).max(500).default([])
});
var meetingControls = z2.object({
  hostManagement: z2.boolean(),
  allowScreenShare: z2.boolean(),
  allowChat: z2.boolean(),
  allowReactions: z2.boolean(),
  allowUnmute: z2.boolean(),
  allowVideo: z2.boolean(),
  locked: z2.boolean()
}).partial();
var updateMeeting = z2.object({
  title: z2.string().trim().max(160).optional(),
  description: z2.string().trim().max(2048).optional(),
  access: meetingAccess.optional(),
  controls: meetingControls.optional(),
  scheduledStartAt: z2.iso.datetime().nullable().optional(),
  scheduledEndAt: z2.iso.datetime().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var meetingChat = z2.object({ body: z2.string().trim().min(1).max(2e3) });
var createMeetingPoll = z2.object({
  question: z2.string().trim().min(1).max(300),
  options: z2.array(z2.string().trim().min(1).max(120)).min(2).max(10),
  multipleChoice: z2.boolean().default(false),
  anonymous: z2.boolean().default(false)
});
var askQuestion = z2.object({ body: z2.string().trim().min(1).max(500), anonymous: z2.boolean().default(false) });
var breakoutPlan = z2.object({
  rooms: z2.array(z2.object({ name: z2.string().trim().min(1).max(60), participantIds: z2.array(id).max(500) })).min(1).max(50),
  minutes: z2.number().int().min(1).max(240).nullable().default(null)
});

// services/meet/src/calls.ts
var OPEN = ["ringing", "active"];
function registerCallRoutes(app, ctx2) {
  const { db: db2, guards: guards2, lk: lk2 } = ctx2;
  const auth = { preHandler: guards2.requireAuth };
  const participants = (executor, callId) => executor.query("SELECT call_id, user_id, state, joined_at, left_at, joined_device_id FROM call_participants WHERE call_id = ? ORDER BY invited_at", [callId]);
  const view = async (call, me) => {
    const [people, key] = await Promise.all([
      participants(db2, call.id),
      db2.one("SELECT sealed_key FROM call_keys WHERE call_id = ? AND device_id = ?", [call.id, me.deviceId])
    ]);
    return {
      id: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      media: call.media,
      state: call.state,
      e2ee: Number(call.e2ee) === 1,
      createdAt: call.created_at.toISOString(),
      answeredAt: call.answered_at?.toISOString() ?? null,
      endedAt: call.ended_at?.toISOString() ?? null,
      participants: people.map((p) => ({ userId: p.user_id, state: p.state, joinedAt: p.joined_at?.toISOString() ?? null, leftAt: p.left_at?.toISOString() ?? null })),
      sealedKey: key ? key.sealed_key.toString("base64url") : null,
      keySenderDeviceId: call.key_sender_device_id
    };
  };
  const load = async (callId, me) => {
    const call = await db2.one("SELECT * FROM calls WHERE id = ?", [callId]);
    const mine = call && await db2.one("SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ?", [callId, me.userId]);
    if (!call || !mine) fail("not_found", "Call not found.");
    return call;
  };
  const grant = async (call, me) => ({
    url: lk2.url,
    room: call.room_name,
    token: await lk2.token({
      room: call.room_name,
      identity: me.userId,
      name: await ctx2.services.displayName(me.userId).catch(() => "Talkie"),
      metadata: { userId: me.userId, deviceId: me.deviceId, callId: call.id },
      sources: { camera: true, microphone: true, screen: true, data: true },
      ttlSeconds: 120
    })
  });
  const busy = (tx, userId, exceptCallId) => tx.one(
    `SELECT c.id, p.joined_device_id FROM call_participants p JOIN calls c ON c.id = p.call_id
       WHERE p.user_id = ? AND c.id <> ? AND c.state IN ('ringing','active') AND p.state = 'joined' LIMIT 1`,
    [userId, exceptCallId]
  );
  const lockUsers = async (tx, ids2) => {
    for (const id2 of [...new Set(ids2)].sort())
      await tx.run("INSERT INTO call_user_locks (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)", [id2]);
  };
  const checkAvailable = async (tx, me, except = "0") => {
    const current = await busy(tx, me.userId, except);
    if (current) fail(
      "conflict",
      current.joined_device_id === me.deviceId ? "Return to your ongoing call." : "You have an ongoing call on another device.",
      current.joined_device_id === me.deviceId ? { currentCallId: current.id } : void 0
    );
  };
  const finish = async (tx, call, state) => {
    const updated = await tx.run("UPDATE calls SET state = ?, ended_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND state IN ('ringing','active')", [state, call.id]);
    if (!updated.affectedRows) return false;
    await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND state = 'joined'", [call.id]);
    await tx.run("UPDATE call_participants SET state = 'missed' WHERE call_id = ? AND state IN ('invited','ringing')", [call.id]);
    const people = await participants(tx, call.id);
    const duration = call.answered_at ? Math.round((Date.now() - call.answered_at.getTime()) / 1e3) : 0;
    await emit(tx, ctx2, "call.ended", call.id, people.map((p) => p.user_id), {
      callId: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      media: call.media,
      outcome: state,
      durationSeconds: state === "ended" ? duration : 0,
      joinedIds: people.filter((p) => p.joined_at).map((p) => p.user_id)
    });
    return true;
  };
  const afterCommit = (room) => {
    ctx2.relay.kick();
    if (room) void lk2.close(room);
  };
  app.post("/meet/calls", { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const input = startCall.parse(request.body);
    if (!lk2.configured) fail("unavailable", "Calls and meetings are not set up on this server yet.");
    const conversation = await ctx2.services.conversation(input.conversationId);
    if (!conversation.memberIds.includes(me.userId)) fail("not_found", "Conversation not found.");
    const others = conversation.memberIds.filter((id3) => id3 !== me.userId);
    if (!others.length) fail("bad_request", "There is no one to call.");
    if (others.length + 1 > GROUP_CALL_MAX) fail("bad_request", `Group calls can have up to ${GROUP_CALL_MAX} people.`);
    if (conversation.kind === "direct" && (await ctx2.services.relationships(me.userId, others)).some((r) => r.blocked)) fail("blocked", "You cannot call this person.");
    const devices = await ctx2.services.devices(conversation.memberIds);
    const provided = new Map(input.keys.map((key) => [key.deviceId, key]));
    if (!devices.some((device2) => device2.userId !== me.userId)) fail("conflict", "The other participants have no active device ready for encrypted calls.");
    if (devices.some((device2) => device2.userId !== me.userId && !provided.has(device2.deviceId))) {
      throw new AppError("devices_changed", "The call devices changed. Try again.", { devices });
    }
    const allowed = new Set(devices.map((d) => d.deviceId));
    allowed.add(me.deviceId);
    const keys = [...provided.values()].filter((key) => allowed.has(key.deviceId));
    const id2 = ctx2.ids.next();
    const call = await db2.tx(async (tx) => {
      await lockUsers(tx, conversation.memberIds);
      await checkAvailable(tx, me);
      if (conversation.kind === "group") {
        const running = await tx.one("SELECT * FROM calls WHERE conversation_id = ? AND state IN ('ringing','active') ORDER BY id DESC LIMIT 1 FOR UPDATE", [input.conversationId]);
        if (running) {
          if (!await tx.one("SELECT 1 FROM call_keys WHERE call_id = ? AND device_id = ?", [running.id, me.deviceId])) fail("conflict", "This device cannot join the existing encrypted call.");
          await joinParticipant(tx, running.id, me);
          return await tx.one("SELECT * FROM calls WHERE id = ?", [running.id]);
        }
      }
      const directBusy = conversation.kind === "direct" && await busy(tx, others[0], id2);
      await tx.run("INSERT INTO calls (id, conversation_id, initiator_id, media, state, e2ee, key_sender_device_id, room_name) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", [
        id2,
        input.conversationId,
        me.userId,
        input.media,
        "ringing",
        me.deviceId,
        `call-${id2}`
      ]);
      await tx.run("INSERT INTO call_participants (call_id, user_id, state, joined_device_id, joined_at) VALUES (?, ?, 'joined', ?, CURRENT_TIMESTAMP(3))", [id2, me.userId, me.deviceId]);
      for (const userId of others) await tx.run("INSERT INTO call_participants (call_id, user_id, state) VALUES (?, ?, 'ringing')", [id2, userId]);
      for (const key of keys) await tx.run("INSERT INTO call_keys (call_id, device_id, sealed_key) VALUES (?, ?, ?)", [id2, key.deviceId, decode(key.sealedKey)]);
      const row = await tx.one("SELECT * FROM calls WHERE id = ?", [id2]);
      if (directBusy) {
        await tx.run("UPDATE call_participants SET state = 'busy' WHERE call_id = ? AND user_id = ?", [id2, others[0]]);
        await finish(tx, row, "busy");
      } else await emit(tx, ctx2, "call.ringing", id2, others, { callId: id2, conversationId: input.conversationId, initiatorId: me.userId, media: input.media, group: conversation.kind === "group" });
      return await tx.one("SELECT * FROM calls WHERE id = ?", [id2]);
    });
    afterCommit();
    reply.status(201);
    return { call: await view(call, me), grant: call.state === "busy" ? null : await grant(call, me) };
  });
  async function joinParticipant(tx, id2, me) {
    const member = await tx.one("SELECT state, joined_device_id FROM call_participants WHERE call_id = ? AND user_id = ? FOR UPDATE", [id2, me.userId]);
    if (member?.state === "joined" && member.joined_device_id && member.joined_device_id !== me.deviceId) fail("conflict", "This call was answered on another device.");
    await tx.run(
      "INSERT INTO call_participants (call_id, user_id, state, joined_device_id, joined_at) VALUES (?, ?, 'joined', ?, CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE state = 'joined', joined_device_id = VALUES(joined_device_id), joined_at = COALESCE(joined_at, CURRENT_TIMESTAMP(3)), left_at = NULL, media_missing_since = NULL",
      [id2, me.userId, me.deviceId]
    );
    await tx.run("UPDATE calls SET state = 'active', answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND state = 'ringing'", [id2]);
    await emit(tx, ctx2, "call.updated", id2, (await participants(tx, id2)).map((p) => p.user_id), { callId: id2, change: "joined", userId: me.userId });
  }
  app.post("/meet/calls/:id/accept", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const call = await load(id2, me);
    if (!OPEN.includes(call.state)) fail("conflict", "This call has ended.");
    if (call.conversation_id && !(await ctx2.services.conversation(call.conversation_id)).memberIds.includes(me.userId)) fail("not_found", "Call not found.");
    if (!await db2.one("SELECT 1 FROM call_keys WHERE call_id = ? AND device_id = ?", [id2, me.deviceId])) fail("conflict", "This device cannot join this encrypted call.");
    await db2.tx(async (tx) => {
      await lockUsers(tx, [me.userId]);
      await checkAvailable(tx, me, id2);
      const current = await tx.one("SELECT state FROM calls WHERE id = ? FOR UPDATE", [id2]);
      if (!current || !OPEN.includes(current.state)) fail("conflict", "This call has ended.");
      await joinParticipant(tx, id2, me);
    });
    afterCommit();
    const fresh = await db2.one("SELECT * FROM calls WHERE id = ?", [id2]);
    return { call: await view(fresh, me), grant: await grant(fresh, me) };
  });
  app.post("/meet/calls/:id/decline", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const call = await load(id2, me);
    if (!OPEN.includes(call.state)) return { ok: true };
    let room;
    await db2.tx(async (tx) => {
      const fresh = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [id2]);
      if (!fresh || !OPEN.includes(fresh.state)) return;
      const changed = await tx.run("UPDATE call_participants SET state = 'declined' WHERE call_id = ? AND user_id = ? AND state IN ('invited','ringing')", [id2, me.userId]);
      if (!changed.affectedRows) return;
      const people = await participants(tx, id2);
      const stillRinging = people.some((p) => p.state === "ringing" || p.state === "invited");
      const others = people.filter((p) => p.user_id !== call.initiator_id && p.state === "joined");
      if (fresh.state === "ringing" && !stillRinging && !others.length) {
        await finish(tx, fresh, "declined");
        room = call.room_name;
      } else await emit(tx, ctx2, "call.updated", id2, people.map((p) => p.user_id), { callId: id2, change: "declined", userId: me.userId });
    });
    afterCommit(room);
    return { ok: true };
  });
  app.post("/meet/calls/:id/leave", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const call = await load(id2, me);
    if (!OPEN.includes(call.state)) return { ok: true };
    let room;
    await db2.tx(async (tx) => {
      const fresh = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [id2]);
      if (!fresh || !OPEN.includes(fresh.state)) return;
      const changed = await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND user_id = ? AND state = 'joined' AND (joined_device_id IS NULL OR joined_device_id = ?)", [id2, me.userId, me.deviceId]);
      if (!changed.affectedRows) return;
      const people = await participants(tx, id2);
      const connected = people.filter((p) => p.state === "joined");
      const direct = people.length === 2;
      const ends = fresh.state === "ringing" ? me.userId === fresh.initiator_id : direct || connected.length < 2;
      if (ends) {
        await finish(tx, fresh, fresh.state === "ringing" ? "cancelled" : "ended");
        room = call.room_name;
      } else await emit(tx, ctx2, "call.updated", id2, people.map((p) => p.user_id), { callId: id2, change: "left", userId: me.userId });
    });
    afterCommit(room);
    return { ok: true };
  });
  app.post("/meet/calls/:id/join", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const call = await db2.one("SELECT * FROM calls WHERE id = ?", [id2]);
    if (!call || !OPEN.includes(call.state) || !call.conversation_id) fail("not_found", "This call has ended.");
    const conversation = await ctx2.services.conversation(call.conversation_id);
    if (!conversation.memberIds.includes(me.userId)) fail("not_found", "Call not found.");
    if (!await db2.one("SELECT 1 FROM call_keys WHERE call_id = ? AND device_id = ?", [id2, me.deviceId])) fail("conflict", "This device cannot join this encrypted call.");
    await db2.tx(async (tx) => {
      await lockUsers(tx, [me.userId]);
      await checkAvailable(tx, me, id2);
      const current = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [id2]);
      if (!current || !OPEN.includes(current.state)) fail("conflict", "This call has ended.");
      await joinParticipant(tx, id2, me);
    });
    afterCommit();
    const fresh = await db2.one("SELECT * FROM calls WHERE id = ?", [id2]);
    return { call: await view(fresh, me), grant: await grant(fresh, me) };
  });
  app.put("/meet/calls/:id/keys", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const { keys } = z3.object({ keys: sealedKeys }).parse(request.body);
    const call = await load(id2, me);
    if (call.key_sender_device_id !== me.deviceId) fail("forbidden", "Only the device that started the call shares its key.");
    for (const key of keys) await db2.run("INSERT IGNORE INTO call_keys (call_id, device_id, sealed_key) VALUES (?, ?, ?)", [id2, key.deviceId, decode(key.sealedKey)]);
    return { ok: true };
  });
  app.get("/meet/calls/current", auth, async (request) => {
    const me = caller(request);
    const current = await busy(db2, me.userId, "0");
    return { call: current?.joined_device_id === me.deviceId ? await view(await load(current.id, me), me) : null };
  });
  app.post("/meet/calls/:id/resume", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const call = await load(id2, me);
    const current = await busy(db2, me.userId, "0");
    if (!OPEN.includes(call.state) || current?.id !== id2 || current.joined_device_id !== me.deviceId) fail("conflict", "This device has no ongoing call here.");
    if (!call.conversation_id || !(await ctx2.services.conversation(call.conversation_id)).memberIds.includes(me.userId)) fail("not_found", "Call not found.");
    const info = await view(call, me);
    if (!info.sealedKey) fail("conflict", "This device cannot open the call.");
    return { call: info, grant: await grant(call, me) };
  });
  app.get("/meet/calls/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    return { call: await view(await load(id2, me), me) };
  });
  app.get("/meet/calls/incoming", auth, async (request) => {
    const me = caller(request);
    const rows = await db2.query(
      `SELECT c.* FROM calls c JOIN call_participants p ON p.call_id = c.id
       WHERE p.user_id = ? AND p.state = 'ringing' AND c.state IN ('ringing','active') AND c.created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 MINUTE`,
      [me.userId]
    );
    return { calls: await Promise.all(rows.map((row) => view(row, me))) };
  });
  app.get("/meet/calls", auth, async (request) => {
    const me = caller(request);
    const { before } = z3.object({ before: id.optional() }).parse(request.query);
    const rows = await db2.query(
      `SELECT c.* FROM call_participants p JOIN calls c ON c.id = p.call_id
       WHERE p.user_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT 50`,
      [me.userId, before ?? "18446744073709551615"]
    );
    return { calls: await Promise.all(rows.map((row) => view(row, me))) };
  });
  async function reconcile(call) {
    const claimed = await db2.run("UPDATE calls SET media_checked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND state = 'active' AND (media_checked_at IS NULL OR media_checked_at < CURRENT_TIMESTAMP(3) - INTERVAL 25 SECOND)", [call.id]);
    if (!claimed.affectedRows) return;
    const connected = await lk2.connectedUsers(call.room_name).catch(() => null);
    if (!connected) return;
    const ended = await db2.tx(async (tx) => {
      const current = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [call.id]);
      if (current?.state !== "active") return false;
      const joined = (await participants(tx, call.id)).filter((p) => p.state === "joined");
      for (const p of joined) {
        if (connected.has(p.user_id)) {
          await tx.run("UPDATE call_participants SET media_missing_since = NULL WHERE call_id = ? AND user_id = ? AND media_missing_since IS NOT NULL", [call.id, p.user_id]);
        } else {
          await tx.run("UPDATE call_participants SET media_missing_since = COALESCE(media_missing_since, CURRENT_TIMESTAMP(3)) WHERE call_id = ? AND user_id = ?", [call.id, p.user_id]);
        }
      }
      const left = await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND state = 'joined' AND media_missing_since < CURRENT_TIMESTAMP(3) - INTERVAL 60 SECOND", [call.id]);
      if (!left.affectedRows) return false;
      if (joined.length - left.affectedRows < 2) return finish(tx, current, "ended");
      await emit(tx, ctx2, "call.updated", call.id, joined.map((p) => p.user_id), { callId: call.id, change: "left" });
      return false;
    });
    afterCommit(ended ? call.room_name : void 0);
  }
  const sweep2 = async () => {
    const stale = await db2.query(
      `SELECT * FROM calls WHERE state = 'ringing' AND created_at < CURRENT_TIMESTAMP(3) - INTERVAL ${CALL_RING_MS / 1e3} SECOND LIMIT 200`
    );
    for (const call of stale) {
      const ended = await db2.tx(async (tx) => {
        const current = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [call.id]);
        return current?.state === "ringing" && await finish(tx, current, "missed");
      });
      if (ended) afterCommit(call.room_name);
    }
    await db2.run(
      `UPDATE call_participants p JOIN calls c ON c.id = p.call_id SET p.state = 'missed'
       WHERE p.state = 'ringing' AND c.state = 'active' AND c.created_at < CURRENT_TIMESTAMP(3) - INTERVAL ${CALL_RING_MS / 1e3} SECOND`
    );
    if (lk2.configured) {
      const active = await db2.query("SELECT * FROM calls WHERE state = 'active' AND answered_at < CURRENT_TIMESTAMP(3) - INTERVAL 20 SECOND AND (media_checked_at IS NULL OR media_checked_at < CURRENT_TIMESTAMP(3) - INTERVAL 25 SECOND) ORDER BY media_checked_at, id LIMIT 16");
      await Promise.all(active.map(reconcile));
    }
  };
  const roomFinished = async (roomName) => {
    const call = await db2.one("SELECT * FROM calls WHERE room_name = ? AND state IN ('ringing','active')", [roomName]);
    if (!call) return;
    if (call.state === "active") {
      await reconcile(call);
      return;
    }
    await db2.tx((tx) => finish(tx, call, call.state === "ringing" ? "missed" : "ended"));
    afterCommit(call.room_name);
  };
  async function revokeDevice(deviceId) {
    const rows = await db2.query("SELECT c.id, c.room_name, p.user_id FROM calls c JOIN call_participants p ON p.call_id = c.id WHERE p.joined_device_id = ? AND p.state = 'joined' AND c.state IN ('active','ringing')", [deviceId]);
    for (const row of rows) {
      const ended = await db2.tx(async (tx) => {
        const call = await tx.one("SELECT * FROM calls WHERE id = ? FOR UPDATE", [row.id]);
        if (!call || !OPEN.includes(call.state)) return false;
        const updated = await tx.run("UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP(3) WHERE call_id = ? AND user_id = ? AND joined_device_id = ? AND state = 'joined'", [row.id, row.user_id, deviceId]);
        if (!updated.affectedRows) return false;
        const people = await participants(tx, row.id);
        if (people.filter((p) => p.state === "joined").length < 2) return finish(tx, call, call.state === "ringing" ? "cancelled" : "ended");
        await emit(tx, ctx2, "call.updated", row.id, people.map((p) => p.user_id), { callId: row.id, change: "left", userId: row.user_id });
        return false;
      });
      if (!ended) await lk2.remove(row.room_name, row.user_id);
      afterCommit(ended ? row.room_name : void 0);
    }
  }
  return { sweep: sweep2, finish, roomFinished, revokeDevice };
}

// services/meet/src/meetings.ts
import { randomInt as randomInt2 } from "node:crypto";
import { z as z4 } from "zod";
var LETTERS = "abcdefghijkmnopqrstuvwxyz";
var code = () => [3, 4, 3].map((n) => Array.from({ length: n }, () => LETTERS[randomInt2(LETTERS.length)]).join("")).join("-");
var codeSchema = z4.string().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/, "Invalid meeting code");
var controlsOf = (row) => ({
  hostManagement: Number(row.host_management) === 1,
  allowScreenShare: Number(row.allow_screen_share) === 1,
  allowChat: Number(row.allow_chat) === 1,
  allowReactions: Number(row.allow_reactions) === 1,
  allowUnmute: Number(row.allow_unmute) === 1,
  allowVideo: Number(row.allow_video) === 1,
  locked: Number(row.locked) === 1
});
var sourcesFor = (role, controls) => role !== "participant" || !controls.hostManagement ? { camera: true, microphone: true, screen: true, data: true } : { camera: controls.allowVideo, microphone: controls.allowUnmute, screen: controls.allowScreenShare, data: controls.allowChat || controls.allowReactions };
function registerMeetingRoutes(app, ctx2, hooks = {}) {
  const { db: db2, guards: guards2, lk: lk2 } = ctx2;
  const auth = { preHandler: guards2.requireAuth };
  const meetingByCode = async (value) => {
    const row = await db2.one("SELECT * FROM meetings WHERE code = ?", [codeSchema.parse(value)]);
    if (!row) fail("not_found", "There is no meeting with this code.");
    return row;
  };
  const controls = async (meetingId, executor = db2) => controlsOf(await executor.one("SELECT * FROM meeting_controls WHERE meeting_id = ?", [meetingId]));
  const cohosts = async (meetingId) => (await db2.query("SELECT user_id FROM meeting_cohosts WHERE meeting_id = ?", [meetingId])).map((r) => r.user_id);
  const invitees = async (meetingId) => (await db2.query("SELECT user_id FROM meeting_invitees WHERE meeting_id = ?", [meetingId])).map((r) => r.user_id);
  const roleOf = async (meeting, userId) => meeting.host_id === userId ? "host" : await db2.one("SELECT 1 FROM meeting_cohosts WHERE meeting_id = ? AND user_id = ?", [meeting.id, userId]) ? "cohost" : "participant";
  const requireHost = async (meeting, me) => {
    const role = await roleOf(meeting, me.userId);
    if (role === "participant") fail("forbidden", "Only the host and co-hosts can do this.");
    return role;
  };
  const liveSession = (meetingId, executor = db2) => executor.one("SELECT * FROM meeting_sessions WHERE meeting_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [meetingId]);
  const requireSession = async (meetingId) => {
    const session = await liveSession(meetingId);
    if (!session) fail("conflict", "This meeting is not live.");
    return session;
  };
  const myParticipant = async (session, me) => {
    const row = await db2.one("SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?", [session.id, me.userId]);
    if (!row || row.admission !== "admitted") fail("forbidden", "Join the meeting first.");
    return row;
  };
  const audience = async (session, meeting, executor = db2) => {
    const rows = await executor.query("SELECT user_id FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
    return [.../* @__PURE__ */ new Set([...rows.map((r) => r.user_id), meeting.host_id, ...await cohosts(meeting.id)])];
  };
  const signal = async (session, meeting, change, extra = {}) => {
    await db2.tx(async (tx) => emit(tx, ctx2, "meeting.updated", meeting.id, await audience(session, meeting, tx), { meetingId: meeting.id, code: meeting.code, sessionId: session.id, change, ...extra }));
    ctx2.relay.kick();
  };
  const info = async (meeting, me) => {
    const session = await liveSession(meeting.id);
    const [count, recording] = session ? await Promise.all([
      db2.one("SELECT COUNT(*) AS total FROM meeting_participants WHERE session_id = ? AND admission = 'admitted' AND (last_left_at IS NULL OR last_left_at < last_joined_at)", [session.id]),
      db2.one("SELECT kind, started_at FROM recordings WHERE session_id = ? AND status IN ('starting','active') ORDER BY id DESC LIMIT 1", [session.id])
    ]) : [void 0, void 0];
    return {
      id: meeting.id,
      code: meeting.code,
      title: meeting.title,
      description: meeting.description,
      hostId: meeting.host_id,
      scheduledStartAt: meeting.scheduled_start_at?.toISOString() ?? null,
      scheduledEndAt: meeting.scheduled_end_at?.toISOString() ?? null,
      access: meeting.access,
      status: meeting.status,
      controls: await controls(meeting.id),
      cohostIds: await cohosts(meeting.id),
      inviteeIds: await invitees(meeting.id),
      myRole: await roleOf(meeting, me.userId),
      sessionId: session?.id ?? null,
      participantCount: Number(count?.total ?? 0),
      recording: recording ? { kind: recording.kind, startedAt: recording.started_at.toISOString() } : null,
      createdAt: meeting.created_at.toISOString()
    };
  };
  const token = async (session, meeting, me, role, room = session.room_name) => ({
    url: lk2.url,
    room,
    token: await lk2.token({
      room,
      identity: me.userId,
      name: await ctx2.services.displayName(me.userId).catch(() => "Guest"),
      metadata: { userId: me.userId, role, meetingId: meeting.id },
      sources: sourcesFor(role, await controls(meeting.id)),
      admin: role !== "participant"
    })
  });
  app.post("/meet/meetings", { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const input = createMeeting.parse(request.body);
    const id2 = ctx2.ids.next();
    for (let attempt = 0; ; attempt++) {
      try {
        await db2.tx(async (tx) => {
          await tx.run("INSERT INTO meetings (id, code, title, description, host_id, scheduled_start_at, scheduled_end_at, access) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            id2,
            code(),
            input.title,
            input.description,
            me.userId,
            input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
            input.scheduledEndAt ? new Date(input.scheduledEndAt) : null,
            input.access
          ]);
          await tx.run("INSERT INTO meeting_controls (meeting_id) VALUES (?)", [id2]);
          for (const userId of new Set(input.inviteeIds)) if (userId !== me.userId) await tx.run("INSERT INTO meeting_invitees (meeting_id, user_id) VALUES (?, ?)", [id2, userId]);
          if (input.inviteeIds.length)
            await emit(tx, ctx2, "meeting.updated", id2, input.inviteeIds, { meetingId: id2, change: "invited", hostId: me.userId });
        });
        break;
      } catch (error) {
        if (!isDuplicate(error) || attempt > 3) throw error;
      }
    }
    ctx2.relay.kick();
    reply.status(201);
    return { meeting: await info(await db2.one("SELECT * FROM meetings WHERE id = ?", [id2]), me) };
  });
  app.get("/meet/meetings", auth, async (request) => {
    const me = caller(request);
    const rows = await db2.query(
      `SELECT DISTINCT m.* FROM meetings m
       LEFT JOIN meeting_invitees i ON i.meeting_id = m.id AND i.user_id = ?
       LEFT JOIN meeting_cohosts c ON c.meeting_id = m.id AND c.user_id = ?
       WHERE (m.host_id = ? OR i.user_id IS NOT NULL OR c.user_id IS NOT NULL) AND m.status <> 'cancelled'
         AND (m.status = 'live' OR m.scheduled_start_at IS NULL OR m.scheduled_start_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY)
       ORDER BY (m.status = 'live') DESC, COALESCE(m.scheduled_start_at, m.created_at) DESC LIMIT 50`,
      [me.userId, me.userId, me.userId]
    );
    return { meetings: await Promise.all(rows.map((row) => info(row, me))) };
  });
  app.get("/meet/meetings/:code", auth, async (request) => {
    const me = caller(request);
    const { code: value } = z4.object({ code: z4.string() }).parse(request.params);
    const meeting = await meetingByCode(value);
    return { meeting: await info(meeting, me) };
  });
  app.patch("/meet/meetings/:code", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const input = updateMeeting.parse(request.body);
    await db2.tx(async (tx) => {
      await tx.run(
        `UPDATE meetings SET title = COALESCE(?, title), description = COALESCE(?, description), access = COALESCE(?, access),
           scheduled_start_at = IF(?, ?, scheduled_start_at), scheduled_end_at = IF(?, ?, scheduled_end_at) WHERE id = ?`,
        [
          input.title ?? null,
          input.description ?? null,
          input.access ?? null,
          input.scheduledStartAt !== void 0 ? 1 : 0,
          input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
          input.scheduledEndAt !== void 0 ? 1 : 0,
          input.scheduledEndAt ? new Date(input.scheduledEndAt) : null,
          meeting.id
        ]
      );
      const c = input.controls ?? {};
      const columns = {
        hostManagement: "host_management",
        allowScreenShare: "allow_screen_share",
        allowChat: "allow_chat",
        allowReactions: "allow_reactions",
        allowUnmute: "allow_unmute",
        allowVideo: "allow_video",
        locked: "locked"
      };
      for (const [key, value] of Object.entries(c))
        await tx.run(`UPDATE meeting_controls SET ${columns[key]} = ? WHERE meeting_id = ?`, [value ? 1 : 0, meeting.id]);
    });
    const session = await liveSession(meeting.id);
    if (session) {
      if (input.controls) {
        const now = await controls(meeting.id);
        const people = await db2.query("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
        for (const person of people) {
          const role = await roleOf(meeting, person.user_id);
          if (role === "participant") await lk2.setPermissions(session.room_name, person.user_id, sourcesFor(role, now));
        }
      }
      await signal(session, meeting, "settings");
    }
    return { meeting: await info(await db2.one("SELECT * FROM meetings WHERE id = ?", [meeting.id]), me) };
  });
  app.put("/meet/meetings/:code/cohosts/:userId", auth, async (request) => {
    const me = caller(request);
    const { userId } = z4.object({ userId: id }).parse(request.params);
    const { cohost } = z4.object({ cohost: z4.boolean() }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    if (meeting.host_id !== me.userId) fail("forbidden", "Only the host can choose co-hosts.");
    if (userId === meeting.host_id) fail("bad_request", "The host is already in charge.");
    if (cohost) await db2.run("INSERT IGNORE INTO meeting_cohosts (meeting_id, user_id) VALUES (?, ?)", [meeting.id, userId]);
    else await db2.run("DELETE FROM meeting_cohosts WHERE meeting_id = ? AND user_id = ?", [meeting.id, userId]);
    const session = await liveSession(meeting.id);
    if (session) {
      await db2.run("UPDATE meeting_participants SET role = ? WHERE session_id = ? AND user_id = ?", [cohost ? "cohost" : "participant", session.id, userId]);
      await lk2.setPermissions(session.room_name, userId, sourcesFor(cohost ? "cohost" : "participant", await controls(meeting.id)));
      await signal(session, meeting, "roles", { userId });
    }
    return { ok: true };
  });
  app.delete("/meet/meetings/:code", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    if (meeting.host_id !== me.userId) fail("forbidden", "Only the host can cancel the meeting.");
    if (meeting.status === "live") fail("conflict", "End the meeting first.");
    await db2.tx(async (tx) => {
      await tx.run("UPDATE meetings SET status = 'cancelled' WHERE id = ?", [meeting.id]);
      await emit(tx, ctx2, "meeting.updated", meeting.id, await invitees(meeting.id), { meetingId: meeting.id, change: "cancelled" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.post("/meet/meetings/:code/join", { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    if (meeting.status === "cancelled") fail("not_found", "This meeting was cancelled.");
    if (!lk2.configured) fail("unavailable", "Calls and meetings are not set up on this server yet.");
    const role = await roleOf(meeting, me.userId);
    const invited = role !== "participant" || !!await db2.one("SELECT 1 FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?", [meeting.id, me.userId]);
    if (meeting.access === "restricted" && !invited) fail("forbidden", "Only invited people can join this meeting.");
    const rules = await controls(meeting.id);
    const result = await db2.tx(async (tx) => {
      let session = await liveSession(meeting.id, tx);
      if (!session) {
        const sessionId = ctx2.ids.next();
        await tx.run("INSERT INTO meeting_sessions (id, meeting_id, room_name) VALUES (?, ?, ?)", [sessionId, meeting.id, `meet-${sessionId}`]);
        await tx.run("UPDATE meetings SET status = 'live' WHERE id = ?", [meeting.id]);
        session = await tx.one("SELECT * FROM meeting_sessions WHERE id = ?", [sessionId]);
      }
      const existing = await tx.one("SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?", [session.id, me.userId]);
      if (existing && (existing.admission === "removed" || existing.admission === "denied") && role === "participant") return { kind: "denied" };
      const direct = role !== "participant" || !rules.locked && (meeting.access === "open" || invited) || existing?.admission === "admitted" || existing?.admission === "left";
      const admission = direct ? "admitted" : "waiting";
      let participantId = existing?.id;
      if (existing)
        await tx.run("UPDATE meeting_participants SET admission = ?, role = ?, last_joined_at = IF(? = 'admitted', CURRENT_TIMESTAMP(3), last_joined_at), first_joined_at = COALESCE(first_joined_at, IF(? = 'admitted', CURRENT_TIMESTAMP(3), NULL)) WHERE id = ?", [
          admission,
          role,
          admission,
          admission,
          existing.id
        ]);
      else {
        participantId = ctx2.ids.next();
        await tx.run(
          "INSERT INTO meeting_participants (id, session_id, user_id, role, admission, first_joined_at, last_joined_at) VALUES (?, ?, ?, ?, ?, IF(? = 'admitted', CURRENT_TIMESTAMP(3), NULL), IF(? = 'admitted', CURRENT_TIMESTAMP(3), NULL))",
          [participantId, session.id, me.userId, role, admission, admission, admission]
        );
      }
      const count = await tx.one("SELECT COUNT(*) AS total FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
      await tx.run("UPDATE meeting_sessions SET peak_participants = GREATEST(peak_participants, ?) WHERE id = ?", [Number(count?.total ?? 0), session.id]);
      await emit(tx, ctx2, "meeting.updated", meeting.id, await audience(session, meeting, tx), {
        meetingId: meeting.id,
        code: meeting.code,
        sessionId: session.id,
        change: admission === "waiting" ? "knock" : "joined",
        userId: me.userId
      });
      return { kind: admission, session, participantId };
    });
    ctx2.relay.kick();
    if (result.kind === "denied") return { state: "denied" };
    if (result.kind === "waiting") return { state: "waiting", participantId: result.participantId, sessionId: result.session.id };
    return { state: "admitted", participantId: result.participantId, sessionId: result.session.id, role, grant: await token(result.session, meeting, me, role) };
  });
  app.post("/meet/meetings/:code/token", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const role = await roleOf(meeting, me.userId);
    const breakout = await db2.one(
      "SELECT b.room_name FROM breakout_assignments a JOIN breakout_rooms b ON b.id = a.breakout_room_id WHERE a.participant_id = ? AND b.opened_at IS NOT NULL AND b.closed_at IS NULL",
      [participant.id]
    );
    const { main } = z4.object({ main: z4.boolean().default(false) }).parse(request.body ?? {});
    return { grant: await token(session, meeting, me, role, !main && breakout ? breakout.room_name : session.room_name), breakout: !main && !!breakout };
  });
  app.get("/meet/meetings/:code/participants", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    if (role === "participant") await myParticipant(session, me);
    const rows = await db2.query(
      `SELECT * FROM meeting_participants WHERE session_id = ? AND admission IN (${role === "participant" ? "'admitted'" : "'admitted','waiting'"})
       ORDER BY admission = 'waiting' DESC, hand_raised_at IS NULL, hand_raised_at, first_joined_at`,
      [session.id]
    );
    const people = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      role: row.role === "viewer" ? "participant" : row.role,
      admission: row.admission,
      handRaisedAt: row.hand_raised_at?.toISOString() ?? null,
      joinedAt: row.last_joined_at?.toISOString() ?? null
    }));
    return { participants: people };
  });
  app.post("/meet/meetings/:code/participants/:participantId/:action", auth, async (request) => {
    const me = caller(request);
    const { participantId, action } = z4.object({ participantId: id, action: z4.enum(["admit", "deny", "remove", "mute", "stop-video", "lower-hand"]) }).parse(request.params);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const target = await db2.one("SELECT * FROM meeting_participants WHERE id = ? AND session_id = ?", [participantId, session.id]);
    if (!target) fail("not_found", "Participant not found.");
    if (target.user_id === meeting.host_id && action === "remove") fail("forbidden", "The host cannot be removed.");
    if (action === "admit" || action === "deny") {
      const admission = action === "admit" ? "admitted" : "denied";
      await db2.tx(async (tx) => {
        await tx.run("UPDATE meeting_participants SET admission = ?, first_joined_at = IF(? = 'admitted', COALESCE(first_joined_at, CURRENT_TIMESTAMP(3)), first_joined_at), last_joined_at = IF(? = 'admitted', CURRENT_TIMESTAMP(3), last_joined_at) WHERE id = ? AND admission = 'waiting'", [
          admission,
          admission,
          admission,
          participantId
        ]);
        await emit(tx, ctx2, "meeting.admission", meeting.id, [target.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: admission });
      });
      ctx2.relay.kick();
      await signal(session, meeting, "participants");
    } else if (action === "remove") {
      await db2.run("UPDATE meeting_participants SET admission = 'removed', last_left_at = CURRENT_TIMESTAMP(3), duration_seconds = duration_seconds + GREATEST(0, TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3))) WHERE id = ?", [participantId]);
      await lk2.remove(session.room_name, target.user_id);
      await db2.tx((tx) => emit(tx, ctx2, "meeting.admission", meeting.id, [target.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: "removed" }));
      await signal(session, meeting, "participants");
    } else if (action === "mute" || action === "stop-video") {
      await lk2.mute(session.room_name, target.user_id, action === "mute" ? "microphone" : "camera");
      await lk2.broadcast(session.room_name, { type: action === "mute" ? "muted-by-host" : "video-stopped-by-host" }, [target.user_id]);
    } else {
      await db2.run("UPDATE meeting_participants SET hand_raised_at = NULL WHERE id = ?", [participantId]);
      await signal(session, meeting, "hands");
    }
    return { ok: true };
  });
  app.post("/meet/meetings/:code/admit-all", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const waiting = await db2.query("SELECT user_id FROM meeting_participants WHERE session_id = ? AND admission = 'waiting'", [session.id]);
    await db2.tx(async (tx) => {
      await tx.run("UPDATE meeting_participants SET admission = 'admitted', first_joined_at = COALESCE(first_joined_at, CURRENT_TIMESTAMP(3)), last_joined_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND admission = 'waiting'", [session.id]);
      for (const person of waiting) await emit(tx, ctx2, "meeting.admission", meeting.id, [person.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: "admitted" });
    });
    ctx2.relay.kick();
    await signal(session, meeting, "participants");
    return { admitted: waiting.length };
  });
  app.post("/meet/meetings/:code/mute-all", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const people = await db2.query("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted' AND user_id <> ?", [session.id, me.userId]);
    await Promise.all(people.map((p) => lk2.mute(session.room_name, p.user_id, "microphone")));
    await lk2.broadcast(session.room_name, { type: "muted-by-host" }, people.map((p) => p.user_id));
    return { muted: people.length };
  });
  app.post("/meet/meetings/:code/hand", auth, async (request) => {
    const me = caller(request);
    const { raised } = z4.object({ raised: z4.boolean() }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    await db2.run(`UPDATE meeting_participants SET hand_raised_at = ${raised ? "COALESCE(hand_raised_at, CURRENT_TIMESTAMP(3))" : "NULL"} WHERE id = ?`, [participant.id]);
    await signal(session, meeting, "hands", { userId: me.userId, raised });
    return { ok: true };
  });
  app.post("/meet/meetings/:code/leave", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await liveSession(meeting.id);
    if (!session) return { ok: true };
    await db2.run(
      `UPDATE meeting_participants SET admission = IF(admission = 'admitted', 'left', admission), last_left_at = CURRENT_TIMESTAMP(3),
         duration_seconds = duration_seconds + IF(last_joined_at IS NOT NULL AND (last_left_at IS NULL OR last_left_at < last_joined_at), TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3)), 0),
         hand_raised_at = NULL
       WHERE session_id = ? AND user_id = ?`,
      [session.id, me.userId]
    );
    await signal(session, meeting, "left", { userId: me.userId });
    return { ok: true };
  });
  const endSession = async (meeting, session) => {
    await db2.tx(async (tx) => {
      const recipients = await audience(session, meeting, tx);
      await tx.run(
        `UPDATE meeting_participants SET duration_seconds = duration_seconds + IF(admission = 'admitted' AND last_joined_at IS NOT NULL AND (last_left_at IS NULL OR last_left_at < last_joined_at), TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3)), 0),
           last_left_at = IF(admission = 'admitted', CURRENT_TIMESTAMP(3), last_left_at), admission = IF(admission IN ('admitted','waiting'), 'left', admission)
         WHERE session_id = ?`,
        [session.id]
      );
      await tx.run("UPDATE meeting_sessions SET ended_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND ended_at IS NULL", [session.id]);
      await tx.run("UPDATE breakout_rooms SET closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP(3)) WHERE session_id = ?", [session.id]);
      await tx.run("UPDATE meetings SET status = IF(scheduled_start_at IS NULL, 'ended', 'ended') WHERE id = ?", [meeting.id]);
      await emit(tx, ctx2, "meeting.updated", meeting.id, recipients, { meetingId: meeting.id, code: meeting.code, sessionId: session.id, change: "ended" });
    });
    ctx2.relay.kick();
    const active = await db2.query("SELECT egress_id FROM recordings WHERE session_id = ? AND status IN ('starting','active')", [session.id]);
    for (const recording of active) await lk2.stopEgress(recording.egress_id);
    const breakouts = await db2.query("SELECT room_name FROM breakout_rooms WHERE session_id = ?", [session.id]);
    for (const room of breakouts) await lk2.close(room.room_name);
    await lk2.close(session.room_name);
  };
  app.post("/meet/meetings/:code/end", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await liveSession(meeting.id);
    if (session) await endSession(meeting, session);
    return { ok: true };
  });
  app.get("/meet/meetings/:code/chat", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    if (await roleOf(meeting, me.userId) === "participant") await myParticipant(session, me);
    const rows = await db2.query(
      `SELECT c.id, p.user_id, c.body, c.created_at FROM meeting_chat_messages c JOIN meeting_participants p ON p.id = c.participant_id
       WHERE c.session_id = ? AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 200`,
      [session.id]
    );
    return { messages: rows.reverse().map((r) => ({ id: r.id, userId: r.user_id, body: r.body, createdAt: r.created_at.toISOString() })) };
  });
  app.post("/meet/meetings/:code/chat", { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const { body } = meetingChat.parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const rules = await controls(meeting.id);
    if (rules.hostManagement && !rules.allowChat && await roleOf(meeting, me.userId) === "participant") fail("forbidden", "The host turned off chat.");
    const id2 = ctx2.ids.next();
    await db2.run("INSERT INTO meeting_chat_messages (id, session_id, participant_id, body) VALUES (?, ?, ?, ?)", [id2, session.id, participant.id, body]);
    await signal(session, meeting, "chat", { messageId: id2 });
    reply.status(201);
    return { message: { id: id2, userId: me.userId, body, createdAt: (/* @__PURE__ */ new Date()).toISOString() } };
  });
  app.get("/meet/meetings/:code/polls", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    const participant = role === "participant" ? await myParticipant(session, me) : await db2.one("SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?", [session.id, me.userId]);
    const polls = await db2.query(
      `SELECT * FROM polls WHERE session_id = ? ${role === "participant" ? "AND status <> 'draft'" : ""} ORDER BY id DESC`,
      [session.id]
    );
    const result = [];
    for (const poll of polls) {
      const options = await db2.query("SELECT id, label, ordinal FROM poll_options WHERE poll_id = ? ORDER BY ordinal", [poll.id]);
      const votes = await db2.query("SELECT option_id, participant_id FROM poll_votes WHERE poll_id = ?", [poll.id]);
      const showResults = role !== "participant" || Number(poll.results_shared) === 1 || poll.status === "closed";
      result.push({
        id: poll.id,
        question: poll.question,
        multipleChoice: Number(poll.multiple_choice) === 1,
        anonymous: Number(poll.anonymous) === 1,
        status: poll.status,
        options: options.map((o) => ({ id: o.id, label: o.label, votes: showResults ? votes.filter((v) => v.option_id === o.id).length : null })),
        myVotes: participant ? votes.filter((v) => v.participant_id === participant.id).map((v) => v.option_id) : [],
        totalVoters: new Set(votes.map((v) => v.participant_id)).size
      });
    }
    return { polls: result };
  });
  app.post("/meet/meetings/:code/polls", auth, async (request, reply) => {
    const me = caller(request);
    const input = createMeetingPoll.parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const id2 = ctx2.ids.next();
    await db2.tx(async (tx) => {
      await tx.run("INSERT INTO polls (id, session_id, created_by, question, multiple_choice, anonymous, results_shared, status) VALUES (?, ?, ?, ?, ?, ?, 1, 'open')", [
        id2,
        session.id,
        participant.id,
        input.question,
        input.multipleChoice ? 1 : 0,
        input.anonymous ? 1 : 0
      ]);
      for (const [ordinal, label] of input.options.entries()) await tx.run("INSERT INTO poll_options (id, poll_id, ordinal, label) VALUES (?, ?, ?, ?)", [ctx2.ids.next(), id2, ordinal, label]);
    });
    await signal(session, meeting, "polls", { pollId: id2 });
    reply.status(201);
    return { id: id2 };
  });
  app.post("/meet/meetings/:code/polls/:pollId/vote", auth, async (request) => {
    const me = caller(request);
    const { pollId } = z4.object({ pollId: id }).parse(request.params);
    const { optionIds } = z4.object({ optionIds: z4.array(id).max(10) }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const poll = await db2.one("SELECT status, multiple_choice FROM polls WHERE id = ? AND session_id = ?", [pollId, session.id]);
    if (!poll || poll.status !== "open") fail("conflict", "This poll is closed.");
    if (Number(poll.multiple_choice) !== 1 && optionIds.length > 1) fail("bad_request", "Choose one answer.");
    const valid = (await db2.query("SELECT id FROM poll_options WHERE poll_id = ?", [pollId])).map((o) => o.id);
    if (optionIds.some((o) => !valid.includes(o))) fail("bad_request", "Choose a valid answer.");
    await db2.tx(async (tx) => {
      await tx.run("DELETE FROM poll_votes WHERE poll_id = ? AND participant_id = ?", [pollId, participant.id]);
      for (const optionId of optionIds) await tx.run("INSERT INTO poll_votes (poll_id, option_id, participant_id) VALUES (?, ?, ?)", [pollId, optionId, participant.id]);
    });
    await signal(session, meeting, "polls", { pollId });
    return { ok: true };
  });
  app.post("/meet/meetings/:code/polls/:pollId/close", auth, async (request) => {
    const me = caller(request);
    const { pollId } = z4.object({ pollId: id }).parse(request.params);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    await db2.run("UPDATE polls SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND session_id = ?", [pollId, session.id]);
    await signal(session, meeting, "polls", { pollId });
    return { ok: true };
  });
  app.get("/meet/meetings/:code/questions", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    const participant = await db2.one("SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?", [session.id, me.userId]);
    if (role === "participant" && participant?.admission !== "admitted") fail("forbidden", "Join the meeting first.");
    const rows = await db2.query(
      `SELECT q.id, q.participant_id, p.user_id, q.body, q.anonymous, q.status, q.created_at,
         (SELECT COUNT(*) FROM question_votes v WHERE v.question_id = q.id) AS votes,
         EXISTS(SELECT 1 FROM question_votes v WHERE v.question_id = q.id AND v.participant_id = ?) AS mine
       FROM questions q JOIN meeting_participants p ON p.id = q.participant_id
       WHERE q.session_id = ? ${role === "participant" ? "AND q.status <> 'hidden'" : ""}
       ORDER BY q.status = 'answered', votes DESC, q.id`,
      [participant?.id ?? "0", session.id]
    );
    return {
      questions: rows.map((r) => ({
        id: r.id,
        userId: Number(r.anonymous) === 1 && r.user_id !== me.userId ? null : r.user_id,
        body: r.body,
        status: r.status,
        votes: Number(r.votes),
        votedByMe: Number(r.mine) === 1,
        createdAt: r.created_at.toISOString()
      }))
    };
  });
  app.post("/meet/meetings/:code/questions", { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const input = askQuestion.parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const id2 = ctx2.ids.next();
    await db2.run("INSERT INTO questions (id, session_id, participant_id, body, anonymous) VALUES (?, ?, ?, ?, ?)", [id2, session.id, participant.id, input.body, input.anonymous ? 1 : 0]);
    await signal(session, meeting, "questions", { questionId: id2 });
    reply.status(201);
    return { id: id2 };
  });
  app.post("/meet/meetings/:code/questions/:questionId/vote", auth, async (request) => {
    const me = caller(request);
    const { questionId } = z4.object({ questionId: id }).parse(request.params);
    const { voted } = z4.object({ voted: z4.boolean() }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    if (!await db2.one("SELECT 1 FROM questions WHERE id = ? AND session_id = ?", [questionId, session.id])) fail("not_found", "Question not found.");
    if (voted) await db2.run("INSERT IGNORE INTO question_votes (question_id, participant_id) VALUES (?, ?)", [questionId, participant.id]);
    else await db2.run("DELETE FROM question_votes WHERE question_id = ? AND participant_id = ?", [questionId, participant.id]);
    await signal(session, meeting, "questions", { questionId });
    return { ok: true };
  });
  app.post("/meet/meetings/:code/questions/:questionId/status", auth, async (request) => {
    const me = caller(request);
    const { questionId } = z4.object({ questionId: id }).parse(request.params);
    const { status } = z4.object({ status: z4.enum(["open", "answered", "hidden"]) }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    await db2.run(`UPDATE questions SET status = ?, answered_at = ${status === "answered" ? "CURRENT_TIMESTAMP(3)" : "answered_at"} WHERE id = ? AND session_id = ?`, [status, questionId, session.id]);
    await signal(session, meeting, "questions", { questionId });
    return { ok: true };
  });
  app.get("/meet/meetings/:code/breakouts", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    const session = await requireSession(meeting.id);
    const rooms = await db2.query(
      "SELECT id, name, opened_at, closes_at FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL ORDER BY id",
      [session.id]
    );
    const assignments = rooms.length ? await db2.query(
      `SELECT a.breakout_room_id, p.user_id FROM breakout_assignments a JOIN meeting_participants p ON p.id = a.participant_id
           WHERE a.breakout_room_id IN (${rooms.map(() => "?").join(",")})`,
      rooms.map((r) => r.id)
    ) : [];
    return {
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        openedAt: room.opened_at?.toISOString() ?? null,
        closesAt: room.closes_at?.toISOString() ?? null,
        userIds: assignments.filter((a) => a.breakout_room_id === room.id).map((a) => a.user_id)
      })),
      myRoomId: assignments.find((a) => a.user_id === me.userId)?.breakout_room_id ?? null
    };
  });
  app.post("/meet/meetings/:code/breakouts", auth, async (request) => {
    const me = caller(request);
    const plan = breakoutPlan.parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const participants = await db2.query("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
    const byId = new Map(participants.map((p) => [p.id, p]));
    await db2.tx(async (tx) => {
      await tx.run("UPDATE breakout_rooms SET closed_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND closed_at IS NULL", [session.id]);
      await tx.run("DELETE a FROM breakout_assignments a JOIN meeting_participants p ON p.id = a.participant_id WHERE p.session_id = ?", [session.id]);
      for (const room of plan.rooms) {
        const roomId = ctx2.ids.next();
        await tx.run("INSERT INTO breakout_rooms (id, session_id, name, room_name, opened_at, closes_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?)", [
          roomId,
          session.id,
          room.name,
          `meet-${session.id}-b${roomId}`,
          plan.minutes ? new Date(Date.now() + plan.minutes * 6e4) : null
        ]);
        for (const participantId of new Set(room.participantIds)) if (byId.has(participantId)) await tx.run("INSERT INTO breakout_assignments (participant_id, breakout_room_id) VALUES (?, ?)", [participantId, roomId]);
      }
    });
    await signal(session, meeting, "breakouts-open");
    return { ok: true };
  });
  app.delete("/meet/meetings/:code/breakouts", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rooms = await db2.query("SELECT room_name FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL", [session.id]);
    await db2.run("UPDATE breakout_rooms SET closed_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND closed_at IS NULL", [session.id]);
    await signal(session, meeting, "breakouts-closed");
    setTimeout(() => rooms.forEach((room) => void lk2.close(room.room_name)), 15e3).unref();
    return { ok: true };
  });
  app.post("/meet/meetings/:code/breakouts/broadcast", auth, async (request) => {
    const me = caller(request);
    const { text } = z4.object({ text: z4.string().trim().min(1).max(300) }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rooms = await db2.query("SELECT room_name FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL", [session.id]);
    for (const room of rooms) await lk2.broadcast(room.room_name, { type: "host-message", text });
    return { ok: true };
  });
  app.post("/meet/meetings/:code/recording", auth, async (request) => {
    const me = caller(request);
    const input = z4.object({ kind: z4.enum(["recording", "stream"]), rtmpUrl: z4.string().regex(/^rtmps?:\/\/[^\s]+$/, "Enter the RTMP address from YouTube or Facebook").optional() }).parse(request.body);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    if (await db2.one("SELECT 1 FROM recordings WHERE session_id = ? AND kind = ? AND status IN ('starting','active')", [session.id, input.kind])) fail("conflict", "Already running.");
    if (input.kind === "stream" && !input.rtmpUrl) fail("bad_request", "Enter the stream address.");
    const egressId = input.kind === "recording" ? await lk2.startRecording(session.room_name, `${meeting.code}-${session.id}`) : await lk2.startStream(session.room_name, input.rtmpUrl);
    await db2.run("INSERT INTO recordings (id, session_id, kind, egress_id, status, started_by) VALUES (?, ?, ?, ?, 'active', ?)", [ctx2.ids.next(), session.id, input.kind, egressId, me.userId]);
    await signal(session, meeting, "recording", { kind: input.kind, active: true });
    return { ok: true };
  });
  app.delete("/meet/meetings/:code/recording/:kind", auth, async (request) => {
    const me = caller(request);
    const { kind } = z4.object({ kind: z4.enum(["recording", "stream"]) }).parse(request.params);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rows = await db2.query("SELECT id, egress_id FROM recordings WHERE session_id = ? AND kind = ? AND status IN ('starting','active')", [session.id, kind]);
    for (const row of rows) {
      await lk2.stopEgress(row.egress_id);
      await db2.run("UPDATE recordings SET status = 'ending' WHERE id = ?", [row.id]);
    }
    await signal(session, meeting, "recording", { kind, active: false });
    return { ok: true };
  });
  app.get("/meet/meetings/:code/attendance", auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode(request.params.code);
    await requireHost(meeting, me);
    const sessions = await db2.query("SELECT * FROM meeting_sessions WHERE meeting_id = ? ORDER BY id DESC LIMIT 20", [meeting.id]);
    const result = [];
    for (const session of sessions) {
      const rows = await db2.query("SELECT * FROM meeting_participants WHERE session_id = ? AND first_joined_at IS NOT NULL ORDER BY first_joined_at", [session.id]);
      result.push({
        sessionId: session.id,
        startedAt: session.started_at.toISOString(),
        endedAt: session.ended_at?.toISOString() ?? null,
        peak: session.peak_participants,
        people: rows.map((row) => ({
          userId: row.user_id,
          firstJoinedAt: row.first_joined_at.toISOString(),
          lastLeftAt: row.last_left_at?.toISOString() ?? null,
          minutes: Math.round(
            (row.duration_seconds + (row.admission === "admitted" && row.last_joined_at && (!row.last_left_at || row.last_left_at < row.last_joined_at) ? (Date.now() - row.last_joined_at.getTime()) / 1e3 : 0)) / 60
          )
        }))
      });
    }
    return { sessions: result };
  });
  app.post("/meet/livekit/webhook", { config: { rateLimit: false }, bodyLimit: 256 * 1024 }, async (request) => {
    const event = await lk2.verifyWebhook(request.body, request.headers.authorization);
    const room = event.room?.name ?? "";
    const match = /^meet-(\d+)$/.exec(room);
    if (event.event === "room_finished" && match) {
      const session = await db2.one("SELECT * FROM meeting_sessions WHERE id = ? AND ended_at IS NULL", [match[1]]);
      const meeting = session && await db2.one("SELECT * FROM meetings WHERE id = ?", [session.meeting_id]);
      if (session && meeting) await endSession(meeting, session);
    }
    if (event.event === "room_finished" && room.startsWith("call-")) await hooks.callRoomFinished?.(room);
    if (event.event === "egress_ended" && event.egressInfo)
      await db2.run("UPDATE recordings SET status = IF(? = '', 'complete', 'failed'), ended_at = CURRENT_TIMESTAMP(3) WHERE egress_id = ?", [event.egressInfo.error ?? "", event.egressInfo.egressId]);
    return { ok: true };
  });
  return { endSession };
}

// services/meet/src/admin.ts
import { z as z5 } from "zod";
function registerAdminRoutes(app, { db: db2, guards: guards2 }) {
  app.get("/internal/admin/stats", { preHandler: guards2.requireInternal }, async (request) => {
    const { days } = z5.object({ days: z5.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const from = Snowflake.floor(seriesStart(days));
    const [calls2, callsDaily, meetings, sessionsDaily, minutes] = await Promise.all([
      db2.one(
        "SELECT COUNT(*) AS total, COALESCE(SUM(state IN ('ringing','active')), 0) AS live, COALESCE(SUM(media = 'video'), 0) AS video FROM calls"
      ),
      db2.query(
        "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM calls WHERE id >= ? GROUP BY day",
        [from]
      ),
      db2.one("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'live'), 0) AS live FROM meetings"),
      db2.query(
        "SELECT DATE_FORMAT(started_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM meeting_sessions WHERE id >= ? GROUP BY day",
        [from]
      ),
      db2.one(
        `SELECT
           (SELECT SUM(TIMESTAMPDIFF(SECOND, answered_at, ended_at)) FROM calls WHERE id >= ? AND answered_at IS NOT NULL AND ended_at IS NOT NULL) AS calls,
           (SELECT SUM(TIMESTAMPDIFF(SECOND, started_at, ended_at)) FROM meeting_sessions WHERE id >= ? AND ended_at IS NOT NULL) AS meetings`,
        [from, from]
      )
    ]);
    return {
      calls: { total: Number(calls2?.total ?? 0), live: Number(calls2?.live ?? 0), video: Number(calls2?.video ?? 0) },
      meetings: { total: Number(meetings?.total ?? 0), live: Number(meetings?.live ?? 0) },
      minutes: { calls: Math.round(Number(minutes?.calls ?? 0) / 60), meetings: Math.round(Number(minutes?.meetings ?? 0) / 60) },
      callsDaily: dailySeries(callsDaily, days),
      meetingsDaily: dailySeries(sessionsDaily, days)
    };
  });
}

// services/meet/src/main.ts
var env = loadConfig({
  PORT: z6.coerce.number().int().positive().default(4106),
  DB_NAME: z6.string().default("talkie_meet"),
  USERS_URL: z6.url().default("http://127.0.0.1:4102"),
  AUTH_URL: z6.url().default("http://127.0.0.1:4101"),
  CHAT_URL: z6.url().default("http://127.0.0.1:4103"),
  LIVEKIT_URL: z6.string().optional(),
  LIVEKIT_API_KEY: z6.string().optional(),
  LIVEKIT_API_SECRET: z6.string().optional(),
  RECORDING_S3_BUCKET: z6.string().optional(),
  RECORDING_S3_REGION: z6.string().optional(),
  RECORDING_S3_ENDPOINT: z6.string().optional(),
  RECORDING_S3_ACCESS_KEY_ID: z6.string().optional(),
  RECORDING_S3_SECRET_ACCESS_KEY: z6.string().optional()
});
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "meet", env, ready: () => db.ping(), rateLimitPerMinute: 600 });
var ids = new Snowflake(env.WORKER_ID);
var guards = installAuth(service.app, await createVerifier(env), env);
var bus = createBus(env, service.log, "meet");
var relay = startOutboxRelay(db, bus, service.log);
var lk = createLiveKit(env, service.log);
if (!lk.configured) service.log.warn("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set: calls and meetings are disabled");
service.app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_request, body, done) => done(null, body));
var ctx = { db, ids, relay, guards, lk, env, services: services(env, service.log) };
var calls = registerCallRoutes(service.app, ctx);
bus.subscribe("meet-call-revocations", ["device.revoked"], async (event) => {
  const { deviceId } = event.payload;
  await calls.revokeDevice(deviceId);
});
registerMeetingRoutes(service.app, ctx, { callRoomFinished: calls.roomFinished });
registerAdminRoutes(service.app, ctx);
service.app.get("/internal/selfcheck", { preHandler: guards.requireInternal }, async () => ({ livekit: await lk.check() }));
service.app.get("/meet/config", { preHandler: guards.requireAuth }, async () => ({ enabled: lk.configured, recording: lk.recordingAvailable }));
var sweep = setInterval(() => {
  calls.sweep().catch((error) => service.log.error({ err: error }, "call sweep failed"));
}, 5e3);
sweep.unref();
service.onShutdown(async () => {
  clearInterval(sweep);
  relay.stop();
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
