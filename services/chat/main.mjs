import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/chat/src/main.ts
import { z as z8 } from "zod";

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
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AppError";
    this.status = statusOf[code];
  }
  code;
  details;
  status;
};
var fail = (code, message, details) => {
  throw new AppError(code, message, details);
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

// packages/core/src/crypto.ts
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
var randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

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
var wrap = (target2, rewrite) => ({
  async query(sql, params = []) {
    const [rows] = await target2.execute(rewrite(sql), params);
    return rows;
  },
  async one(sql, params = []) {
    const [rows] = await target2.execute(rewrite(sql), params);
    return rows[0];
  },
  async run(sql, params = []) {
    const [result] = await target2.execute(rewrite(sql), params);
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
          const code = error.code;
          if (attempt === 0 && (code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT")) continue;
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
async function createVerifier(env2, publicKeyPem = readPublicKey(env2)) {
  const key = await importSPKI(publicKeyPem, ACCESS_TOKEN_ALG);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ACCESS_TOKEN_ALG],
          issuer: env2.JWT_ISSUER,
          audience: env2.JWT_AUDIENCE,
          clockTolerance: 5
        });
        if (!payload.sub || !payload.did || !payload.sid) throw new Error("incomplete token");
        return { userId: payload.sub, deviceId: payload.did, sessionId: payload.sid, role: payload.role ?? "user" };
      } catch {
        throw new AppError("unauthorized", "Your session has expired. Please sign in again.");
      }
    }
  };
}
var bearer = (request) => {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return null;
};
function installAuth(app, verifier, env2) {
  app.decorateRequest("auth", void 0);
  app.addHook("onRequest", async (request) => {
    const token = bearer(request);
    if (token) request.auth = await verifier.verify(token);
  });
  const internal2 = Buffer.from(env2.INTERNAL_TOKEN);
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
      if (given.length !== internal2.length || !timingSafeEqual2(given, internal2))
        throw new AppError("forbidden", "Internal route.");
    }
  };
}
var caller = (request) => {
  if (!request.auth) throw new AppError("unauthorized", "Please sign in.");
  return request.auth;
};

// services/chat/src/context.ts
async function internal(env2, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "x-internal-token": env2.INTERNAL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5e3)
    });
  } catch {
    throw new AppError("unavailable", "Talkie is busy right now. Please try again in a moment.");
  }
  if (!response.ok) throw new AppError("unavailable", "Talkie is busy right now. Please try again in a moment.");
  return await response.json();
}
var mediaClient = (env2) => ({
  verify: async (ownerId, mediaIds, purposes) => mediaIds.length ? (await internal(env2, `${env2.MEDIA_URL}/internal/media/verify`, { ownerId, mediaIds, purposes })).valid : [],
  release: async (mediaIds) => {
    if (!mediaIds.length) return;
    await internal(env2, `${env2.MEDIA_URL}/internal/media/release`, { mediaIds }).catch(() => {
    });
  }
});
var usersClient = (env2) => ({
  relationships: async (userId, otherIds) => (await internal(env2, `${env2.USERS_URL}/internal/relationships`, { userId, otherIds })).relationships
});
function deviceDirectory(env2) {
  const cache = /* @__PURE__ */ new Map();
  const TTL = 3e4;
  return {
    async forUsers(userIds, fresh = false) {
      const unique = [...new Set(userIds)];
      const now = Date.now();
      const missing = unique.filter((id2) => fresh || (cache.get(id2)?.at ?? 0) + TTL < now);
      for (let offset = 0; offset < missing.length; offset += 1e3) {
        const batch2 = missing.slice(offset, offset + 1e3);
        const { devices } = await internal(env2, `${env2.AUTH_URL}/internal/device-keys`, { userIds: batch2 });
        for (const id2 of batch2) cache.set(id2, { at: now, devices: [] });
        for (const device2 of devices) cache.get(device2.userId)?.devices.push(device2);
      }
      return unique.flatMap((id2) => cache.get(id2)?.devices ?? []);
    },
    forget(userId) {
      cache.delete(userId);
    }
  };
}
async function membership(db2, conversationId, userId, active = true) {
  const row = await db2.one(
    `SELECT cm.conversation_id, c.kind, cm.user_id, cm.role, cm.joined_at, cm.left_at, cm.last_read_message_id,
            cm.last_delivered_message_id, cm.cleared_before_message_id, c.disappearing_seconds
     FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.conversation_id = ? AND cm.user_id = ?`,
    [conversationId, userId]
  );
  if (!row) fail("not_found", "Conversation not found.");
  if (active && row.left_at) fail("forbidden", "You are no longer a member of this group.");
  return row;
}
async function activeMemberIds(db2, conversationId) {
  const rows = await db2.query("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL", [conversationId]);
  return rows.map((row) => row.user_id);
}
var isAdmin = (member) => member.role === "admin" || member.role === "owner";
async function emit(tx, ctx2, type, conversationId, recipients, payload = {}) {
  await writeOutbox(tx, { id: ctx2.ids.next(), type, key: conversationId, payload: { conversationId, recipients, ...payload } });
}
async function systemMessage(tx, ctx2, conversationId, actor, event) {
  const id2 = ctx2.ids.next();
  await tx.run(
    `INSERT INTO messages (id, conversation_id, sender_id, sender_device_id, kind, system_event, client_message_id)
     VALUES (?, ?, ?, ?, 'system', ?, ?)`,
    [id2, conversationId, actor.userId, actor.deviceId, JSON.stringify(event), `sys${id2}`.slice(0, 26).padEnd(26, "0")]
  );
  return id2;
}
var MESSAGE_COLUMNS = `m.id, m.conversation_id, m.sender_id, m.sender_device_id, m.kind, m.ciphertext, m.nonce, k.sealed_key, k.wrap_device_id,
  m.system_event, m.reply_to_id, m.forwarded_count, m.edited_at, m.deleted_at, m.expires_at, m.created_at`;
async function toWire(db2, rows, viewerId) {
  if (!rows.length) return [];
  const ids2 = rows.map((row) => row.id);
  const marks = ids2.map(() => "?").join(",");
  const polls = rows.filter((row) => row.kind === "poll").map((row) => row.id);
  const votes = polls.length ? await db2.query(
    `SELECT message_id, user_id, option_index FROM poll_votes WHERE message_id IN (${polls.map(() => "?").join(",")}) ORDER BY voted_at`,
    polls
  ) : [];
  const [reactions, stars] = await Promise.all([
    db2.query(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${marks}) ORDER BY created_at`, ids2),
    db2.query(`SELECT message_id FROM message_stars WHERE user_id = ? AND message_id IN (${marks})`, [viewerId, ...ids2])
  ]);
  const starred = new Set(stars.map((row) => row.message_id));
  const byMessage = /* @__PURE__ */ new Map();
  for (const reaction of reactions) {
    const emojis = byMessage.get(reaction.message_id) ?? /* @__PURE__ */ new Map();
    emojis.set(reaction.emoji, [...emojis.get(reaction.emoji) ?? [], reaction.user_id]);
    byMessage.set(reaction.message_id, emojis);
  }
  return rows.map((row) => {
    const wireReactions = [...byMessage.get(row.id)?.entries() ?? []].map(([emoji, userIds]) => ({ emoji, userIds }));
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderDeviceId: row.sender_device_id,
      kind: row.kind,
      ciphertext: row.ciphertext ? row.ciphertext.toString("base64url") : null,
      nonce: row.nonce ? row.nonce.toString("base64url") : null,
      sealedKey: row.sealed_key ? row.sealed_key.toString("base64url") : null,
      ...row.wrap_device_id ? { keySenderDeviceId: row.wrap_device_id } : {},
      systemEvent: row.system_event ? JSON.parse(row.system_event) : null,
      replyToId: row.reply_to_id,
      forwardedCount: row.forwarded_count,
      editedAt: row.edited_at?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      reactions: wireReactions,
      starred: starred.has(row.id),
      ...row.kind === "poll" ? {
        pollVotes: [...new Set(votes.filter((v) => v.message_id === row.id).map((v) => v.option_index))].sort().map((option) => ({
          option,
          userIds: votes.filter((v) => v.message_id === row.id && v.option_index === option).map((v) => v.user_id)
        }))
      } : {}
    };
  });
}
async function receiptsFor(db2, conversationId, viewerId, kind) {
  const others = await db2.query(
    `SELECT cm.user_id, cm.last_read_message_id, cm.last_delivered_message_id, f.read_receipts
     FROM conversation_members cm LEFT JOIN user_flags f ON f.user_id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.user_id <> ? AND cm.left_at IS NULL`,
    [conversationId, viewerId]
  );
  if (!others.length) return { delivered: "0", read: "0" };
  const min = (values) => values.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
  const delivered = min(others.map((row) => row.last_delivered_message_id));
  let read = min(others.map((row) => row.last_read_message_id));
  if (kind === "direct") {
    const mine = await db2.one("SELECT read_receipts FROM user_flags WHERE user_id = ?", [viewerId]);
    const peerOff = others[0].read_receipts !== null && Number(others[0].read_receipts) === 0;
    const meOff = mine !== void 0 && Number(mine.read_receipts) === 0;
    if (peerOff || meOff) read = "0";
  }
  return { delivered: BigInt(delivered) > BigInt(read) ? delivered : read, read };
}
var decode = (value) => Buffer.from(value, "base64url");

// services/chat/src/status.ts
import { z as z3 } from "zod";

// packages/contracts/src/index.ts
import { z as z2 } from "zod";
var USERNAME_MIN = 3;
var USERNAME_MAX = 32;
var DISPLAY_NAME_MAX = 64;
var ABOUT_MAX = 140;
var OTP_LENGTH = 6;
var MAX_LINKED_DEVICES = 5;
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
var otpRequest = z2.object({ email, locale: locale.default("bn") });
var otpVerify = z2.object({ challengeId: id, code: otpCode, device });
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
var MAX_PINS = 3;
var DISAPPEARING_OPTIONS = [86400, 604800, 7776e3];
var b64 = (maxChars) => z2.string().regex(/^[A-Za-z0-9_-]*$/, "Invalid encoding").max(maxChars);
var messageKind = z2.enum(["text", "image", "video", "audio", "voice", "document", "sticker", "location", "contact", "poll"]);
var clientMessageId = z2.string().regex(/^[0-9A-Za-z]{26}$/, "Invalid client message id");
var sealedKeys = z2.array(z2.object({ deviceId: id, sealedKey: b64(200) })).min(1).max(GROUP_MAX_MEMBERS * MAX_LINKED_DEVICES);
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

// services/chat/src/status.ts
var toWire2 = (row) => ({
  id: row.id,
  ownerId: row.owner_id,
  senderDeviceId: row.sender_device_id,
  kind: row.kind,
  ciphertext: row.ciphertext.toString("base64url"),
  nonce: row.nonce.toString("base64url"),
  sealedKey: row.sealed_key ? row.sealed_key.toString("base64url") : null,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  viewed: Number(row.viewed) === 1
});
function registerStatusRoutes(app, ctx2) {
  const { db: db2, guards: guards2 } = ctx2;
  const auth = { preHandler: guards2.requireAuth };
  app.post("/chat/status/devices", auth, async (request) => {
    const { userIds } = z3.object({ userIds: z3.array(id).max(5e3) }).parse(request.body);
    const me = caller(request);
    return { devices: await ctx2.devices.forUsers([.../* @__PURE__ */ new Set([...userIds, me.userId])]) };
  });
  app.post("/chat/status", { ...auth, bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const input = createStatus.parse(request.body);
    if (input.kind !== "text" && !input.mediaId) fail("bad_request", "Attach the photo or video.");
    if (input.mediaId && !(await ctx2.media.verify(me.userId, [input.mediaId], ["status"])).length) fail("bad_request", "The file is still uploading.");
    const audience = [...new Set(input.audience)].filter((id3) => id3 !== me.userId);
    const relationships = audience.length ? await ctx2.users.relationships(me.userId, audience) : [];
    const allowed = audience.filter((id3) => relationships.find((r) => r.userId === id3 && !r.blocked));
    const devices = await ctx2.devices.forUsers([...allowed, me.userId]);
    const valid = new Set(devices.map((d) => d.deviceId));
    valid.add(me.deviceId);
    const keys = input.keys.filter((key) => valid.has(key.deviceId));
    const id2 = ctx2.ids.next();
    await db2.tx(async (tx) => {
      await tx.run("INSERT INTO statuses (id, owner_id, sender_device_id, kind, ciphertext, nonce, media_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        id2,
        me.userId,
        me.deviceId,
        input.kind,
        decode(input.ciphertext),
        decode(input.nonce),
        input.mediaId ?? null,
        new Date(Date.now() + STATUS_TTL_MS)
      ]);
      for (let offset = 0; offset < allowed.length; offset += 500) {
        const batch2 = allowed.slice(offset, offset + 500);
        await tx.run(`INSERT INTO status_audience (status_id, user_id) VALUES ${batch2.map(() => "(?, ?)").join(",")}`, batch2.flatMap((user) => [id2, user]));
      }
      for (let offset = 0; offset < keys.length; offset += 500) {
        const batch2 = keys.slice(offset, offset + 500);
        await tx.run(`INSERT INTO status_keys (status_id, device_id, sealed_key) VALUES ${batch2.map(() => "(?, ?, ?)").join(",")}`, batch2.flatMap((key) => [id2, key.deviceId, decode(key.sealedKey)]));
      }
      await emit(tx, ctx2, "status.updated", id2, [me.userId, ...allowed], { statusId: id2, ownerId: me.userId, change: "posted" });
    });
    ctx2.relay.kick();
    reply.status(201);
    return { id: id2, sharedWith: allowed.length };
  });
  app.get("/chat/status/feed", auth, async (request) => {
    const me = caller(request);
    const columns = `s.id, s.owner_id, s.sender_device_id, s.kind, s.ciphertext, s.nonce, k.sealed_key, s.created_at, s.expires_at,
      EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = ?) AS viewed`;
    const [mine, others, muted] = await Promise.all([
      db2.query(
        `SELECT ${columns} FROM statuses s LEFT JOIN status_keys k ON k.status_id = s.id AND k.device_id = ?
         WHERE s.owner_id = ? AND s.expires_at > CURRENT_TIMESTAMP(3) ORDER BY s.id`,
        [me.userId, me.deviceId, me.userId]
      ),
      db2.query(
        `SELECT ${columns} FROM status_audience a JOIN statuses s ON s.id = a.status_id
         LEFT JOIN status_keys k ON k.status_id = s.id AND k.device_id = ?
         WHERE a.user_id = ? AND s.expires_at > CURRENT_TIMESTAMP(3) ORDER BY s.id LIMIT 2000`,
        [me.userId, me.deviceId, me.userId]
      ),
      db2.query("SELECT muted_id FROM status_mutes WHERE user_id = ?", [me.userId])
    ]);
    const viewCounts = mine.length ? await db2.query(
      `SELECT status_id, COUNT(*) AS total FROM status_views WHERE status_id IN (${mine.map(() => "?").join(",")}) GROUP BY status_id`,
      mine.map((s) => s.id)
    ) : [];
    const counts = new Map(viewCounts.map((row) => [row.status_id, Number(row.total)]));
    return {
      mine: mine.map((row) => ({ ...toWire2(row), viewCount: counts.get(row.id) ?? 0 })),
      others: others.map(toWire2),
      mutedOwnerIds: muted.map((row) => row.muted_id)
    };
  });
  app.post("/chat/status/:id/view", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const { reaction } = z3.object({ reaction: z3.string().min(1).max(16).nullable().default(null) }).parse(request.body ?? {});
    const status = await db2.one(
      "SELECT s.owner_id FROM statuses s JOIN status_audience a ON a.status_id = s.id AND a.user_id = ? WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP(3)",
      [me.userId, id2]
    );
    if (!status) fail("not_found", "This status is no longer available.");
    await db2.tx(async (tx) => {
      const result = await tx.run(
        `INSERT INTO status_views (status_id, viewer_id, reaction) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE reaction = COALESCE(VALUES(reaction), reaction)`,
        [id2, me.userId, reaction]
      );
      if (result.affectedRows) await emit(tx, ctx2, "status.updated", id2, [status.owner_id], { statusId: id2, ownerId: status.owner_id, change: "view", by: me.userId });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.get("/chat/status/:id/viewers", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const status = await db2.one("SELECT owner_id FROM statuses WHERE id = ?", [id2]);
    if (!status || status.owner_id !== me.userId) fail("not_found", "Status not found.");
    const rows = await db2.query(
      "SELECT viewer_id, viewed_at, reaction FROM status_views WHERE status_id = ? ORDER BY viewed_at DESC",
      [id2]
    );
    const viewers = rows.map((row) => ({ userId: row.viewer_id, viewedAt: row.viewed_at.toISOString(), reaction: row.reaction }));
    return { viewers };
  });
  app.delete("/chat/status/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const status = await db2.one("SELECT owner_id, media_id FROM statuses WHERE id = ?", [id2]);
    if (!status || status.owner_id !== me.userId) fail("not_found", "Status not found.");
    const audience = (await db2.query("SELECT user_id FROM status_audience WHERE status_id = ?", [id2])).map((a) => a.user_id);
    await db2.tx(async (tx) => {
      await tx.run("DELETE FROM statuses WHERE id = ?", [id2]);
      await emit(tx, ctx2, "status.updated", id2, [me.userId, ...audience], { statusId: id2, ownerId: me.userId, change: "deleted" });
    });
    ctx2.relay.kick();
    if (status.media_id) await ctx2.media.release([status.media_id]);
    return { ok: true };
  });
  app.put("/chat/status/mutes/:userId", auth, async (request) => {
    const me = caller(request);
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { muted } = z3.object({ muted: z3.boolean() }).parse(request.body);
    if (muted) await db2.run("INSERT IGNORE INTO status_mutes (user_id, muted_id) VALUES (?, ?)", [me.userId, userId]);
    else await db2.run("DELETE FROM status_mutes WHERE user_id = ? AND muted_id = ?", [me.userId, userId]);
    return { ok: true };
  });
}

// services/chat/src/conversations.ts
import { z as z4 } from "zod";
var SUMMARY_SQL = `
  SELECT c.id, c.kind, c.disappearing_seconds, c.updated_at,
         (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id) AS last_message_id,
         cm.role, cm.left_at, cm.muted_until, cm.archived_at, cm.pinned_at, cm.marked_unread,
         (SELECT o.user_id FROM conversation_members o WHERE o.conversation_id = c.id AND o.user_id <> cm.user_id AND c.kind = 'direct' LIMIT 1) AS peer_id,
         g.name, g.description, g.avatar_media_id, g.send_policy, g.edit_info_policy, g.add_member_policy, g.approval_required,
         (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS member_count
  FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  LEFT JOIN \`groups\` g ON g.conversation_id = c.id`;
function registerConversationRoutes(app, ctx2) {
  const { db: db2, guards: guards2 } = ctx2;
  const auth = { preHandler: guards2.requireAuth };
  const avatar = (mediaId) => mediaId ? `${ctx2.env.MEDIA_PUBLIC_URL}/avatars/${mediaId}` : null;
  const summaries = async (userId, deviceId, rows) => {
    if (!rows.length) return [];
    const lastIds = rows.map((row) => row.last_message_id).filter((id2) => !!id2);
    const lastRows = lastIds.length ? await db2.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
           WHERE m.id IN (${lastIds.map(() => "?").join(",")})`,
      [deviceId, ...lastIds]
    ) : [];
    const last = new Map((await toWire(db2, lastRows, userId)).map((message) => [message.id, message]));
    const unread = await db2.query(
      `SELECT m.conversation_id, COUNT(*) AS total
       FROM conversation_members cm
       JOIN messages m ON m.conversation_id = cm.conversation_id AND m.id > cm.last_read_message_id
                       AND m.sender_id <> cm.user_id AND m.kind <> 'system' AND m.deleted_at IS NULL
       WHERE cm.user_id = ? AND cm.left_at IS NULL
       GROUP BY m.conversation_id`,
      [userId]
    );
    const unreadBy = new Map(unread.map((row) => [row.conversation_id, Number(row.total)]));
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        kind: row.kind,
        peerId: row.peer_id,
        group: row.kind === "group" ? {
          name: row.name ?? "",
          description: row.description ?? "",
          avatarUrl: avatar(row.avatar_media_id),
          memberCount: Number(row.member_count ?? 0),
          sendPolicy: row.send_policy ?? "all",
          editInfoPolicy: row.edit_info_policy ?? "admins",
          addMemberPolicy: row.add_member_policy ?? "admins",
          approvalRequired: Number(row.approval_required) === 1
        } : null,
        role: row.role,
        active: !row.left_at,
        lastMessage: row.last_message_id && last.get(row.last_message_id) || null,
        unreadCount: unreadBy.get(row.id) ?? 0,
        mutedUntil: row.muted_until && row.muted_until.getTime() > Date.now() ? row.muted_until.toISOString() : null,
        archived: !!row.archived_at,
        pinned: !!row.pinned_at,
        markedUnread: Number(row.marked_unread) === 1,
        disappearingSeconds: row.disappearing_seconds,
        receipts: await receiptsFor(db2, row.id, userId, row.kind),
        updatedAt: last.get(row.last_message_id ?? "")?.createdAt ?? row.updated_at.toISOString()
      }))
    );
  };
  const one = async (userId, deviceId, conversationId) => {
    const rows = await db2.query(`${SUMMARY_SQL} WHERE cm.user_id = ? AND c.id = ?`, [userId, conversationId]);
    if (!rows.length) fail("not_found", "Conversation not found.");
    return (await summaries(userId, deviceId, rows))[0];
  };
  app.get("/chat/conversations", auth, async (request) => {
    const me = caller(request);
    const rows = await db2.query(`${SUMMARY_SQL} WHERE cm.user_id = ?
         AND (cm.deleted_before_message_id = 0 OR EXISTS (SELECT 1 FROM messages d WHERE d.conversation_id = c.id AND d.id >= cm.deleted_before_message_id))
       ORDER BY COALESCE(last_message_id, 0) DESC, c.id DESC LIMIT 500`, [me.userId]);
    return { conversations: await summaries(me.userId, me.deviceId, rows) };
  });
  app.get("/chat/conversations/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    await membership(db2, id2, me.userId, false);
    const members = await db2.query(
      "SELECT user_id, role, joined_at FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL ORDER BY FIELD(role, 'owner', 'admin', 'member'), joined_at",
      [id2]
    );
    const pins = await db2.query(
      "SELECT message_id FROM conversation_pins WHERE conversation_id = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3)) ORDER BY pinned_at DESC",
      [id2]
    );
    return {
      conversation: await one(me.userId, me.deviceId, id2),
      members: members.map((m) => ({ userId: m.user_id, role: m.role, joinedAt: m.joined_at.toISOString() })),
      pinnedMessageIds: pins.map((p) => p.message_id)
    };
  });
  app.get("/chat/conversations/:id/devices", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    await membership(db2, id2, me.userId);
    return { devices: await ctx2.devices.forUsers(await activeMemberIds(db2, id2)) };
  });
  app.post("/chat/conversations/direct", auth, async (request) => {
    const me = caller(request);
    const { userId } = z4.object({ userId: id }).parse(request.body);
    if (userId === me.userId) fail("bad_request", "Choose someone else.");
    const [relationship] = await ctx2.users.relationships(me.userId, [userId]);
    if (!relationship) fail("not_found", "This person is not on Talkie.");
    const [low, high] = BigInt(me.userId) < BigInt(userId) ? [me.userId, userId] : [userId, me.userId];
    const existing = await db2.one("SELECT conversation_id FROM direct_pairs WHERE user_low = ? AND user_high = ?", [low, high]);
    if (existing) {
      await db2.run("UPDATE conversation_members SET deleted_before_message_id = 0 WHERE conversation_id = ? AND user_id = ?", [existing.conversation_id, me.userId]);
      return { conversation: await one(me.userId, me.deviceId, existing.conversation_id) };
    }
    if (relationship.blocked) fail("blocked", "You cannot message this person.");
    const conversationId = ctx2.ids.next();
    try {
      await db2.tx(async (tx) => {
        await tx.run("INSERT INTO conversations (id, kind, created_by) VALUES (?, 'direct', ?)", [conversationId, me.userId]);
        await tx.run("INSERT INTO direct_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)", [low, high, conversationId]);
        await tx.run("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)", [conversationId, me.userId, conversationId, userId]);
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await db2.one("SELECT conversation_id FROM direct_pairs WHERE user_low = ? AND user_high = ?", [low, high]);
      return { conversation: await one(me.userId, me.deviceId, raced.conversation_id) };
    }
    return { conversation: await one(me.userId, me.deviceId, conversationId) };
  });
  const addable = async (actorId, userIds) => {
    const unique = [...new Set(userIds)].filter((id2) => id2 !== actorId);
    if (!unique.length) return { allowed: [], refused: [] };
    const relationships = await ctx2.users.relationships(actorId, unique);
    const known = new Map(relationships.map((r) => [r.userId, r]));
    const allowed = unique.filter((id2) => known.get(id2) && !known.get(id2).blocked && known.get(id2).canAddToGroup);
    return { allowed, refused: unique.filter((id2) => !allowed.includes(id2)) };
  };
  app.post("/chat/groups", auth, async (request, reply) => {
    const me = caller(request);
    const input = createGroup.parse(request.body);
    const { allowed, refused } = await addable(me.userId, input.memberIds);
    const conversationId = ctx2.ids.next();
    await db2.tx(async (tx) => {
      await tx.run("INSERT INTO conversations (id, kind, created_by) VALUES (?, 'group', ?)", [conversationId, me.userId]);
      await tx.run("INSERT INTO `groups` (conversation_id, name, description) VALUES (?, ?, ?)", [conversationId, input.name, input.description]);
      await tx.run("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')", [conversationId, me.userId]);
      for (const userId of allowed)
        await tx.run("INSERT INTO conversation_members (conversation_id, user_id, added_by) VALUES (?, ?, ?)", [conversationId, userId, me.userId]);
      await systemMessage(tx, ctx2, conversationId, me, { type: "group_created", actorId: me.userId, value: input.name });
      if (allowed.length) await systemMessage(tx, ctx2, conversationId, me, { type: "members_added", actorId: me.userId, targetIds: allowed });
      await emit(tx, ctx2, "conversation.updated", conversationId, [me.userId, ...allowed], { change: "created" });
    });
    ctx2.relay.kick();
    reply.status(201);
    return { conversation: await one(me.userId, me.deviceId, conversationId), notAdded: refused };
  });
  const groupRow = async (conversationId) => {
    const row = await db2.one(
      "SELECT name, edit_info_policy, add_member_policy, approval_required, invite_code, max_members FROM `groups` WHERE conversation_id = ?",
      [conversationId]
    );
    if (!row) fail("not_found", "Group not found.");
    return row;
  };
  app.patch("/chat/groups/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const input = updateGroup.parse(request.body);
    const member = await membership(db2, id2, me.userId);
    const group = await groupRow(id2);
    const changesInfo = input.name !== void 0 || input.description !== void 0 || input.avatarMediaId !== void 0;
    if (input.avatarMediaId) {
      const valid = await ctx2.media.verify(me.userId, [input.avatarMediaId], ["group_avatar"]);
      if (!valid.length) fail("bad_request", "Upload the photo first.");
    }
    const changesSettings = input.sendPolicy !== void 0 || input.editInfoPolicy !== void 0 || input.addMemberPolicy !== void 0 || input.approvalRequired !== void 0;
    if (changesSettings && !isAdmin(member)) fail("forbidden", "Only group admins can change group settings.");
    if (changesInfo && group.edit_info_policy === "admins" && !isAdmin(member)) fail("forbidden", "Only group admins can edit group info.");
    await db2.tx(async (tx) => {
      await tx.run(
        `UPDATE \`groups\` SET name = COALESCE(?, name), description = COALESCE(?, description), send_policy = COALESCE(?, send_policy),
           edit_info_policy = COALESCE(?, edit_info_policy), add_member_policy = COALESCE(?, add_member_policy),
           approval_required = COALESCE(?, approval_required),
           avatar_media_id = IF(?, ?, avatar_media_id) WHERE conversation_id = ?`,
        [
          input.name ?? null,
          input.description ?? null,
          input.sendPolicy ?? null,
          input.editInfoPolicy ?? null,
          input.addMemberPolicy ?? null,
          input.approvalRequired === void 0 ? null : input.approvalRequired ? 1 : 0,
          input.avatarMediaId !== void 0 ? 1 : 0,
          input.avatarMediaId ?? null,
          id2
        ]
      );
      if (input.name !== void 0 && input.name !== group.name) await systemMessage(tx, ctx2, id2, me, { type: "name_changed", actorId: me.userId, value: input.name });
      if (input.description !== void 0) await systemMessage(tx, ctx2, id2, me, { type: "description_changed", actorId: me.userId });
      if (changesSettings) await systemMessage(tx, ctx2, id2, me, { type: "settings_changed", actorId: me.userId });
      await emit(tx, ctx2, "conversation.updated", id2, await activeMemberIds(tx, id2), { change: "group" });
    });
    ctx2.relay.kick();
    return { conversation: await one(me.userId, me.deviceId, id2) };
  });
  app.post("/chat/groups/:id/members", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const { userIds } = z4.object({ userIds: z4.array(id).min(1).max(256) }).parse(request.body);
    const member = await membership(db2, id2, me.userId);
    const group = await groupRow(id2);
    if (group.add_member_policy === "admins" && !isAdmin(member)) fail("forbidden", "Only group admins can add members.");
    const { allowed, refused } = await addable(me.userId, userIds);
    const added = await db2.tx(async (tx) => {
      const current = await activeMemberIds(tx, id2);
      const fresh = allowed.filter((userId) => !current.includes(userId));
      if (current.length + fresh.length > group.max_members) fail("conflict", `A group can have up to ${group.max_members} members.`);
      for (const userId of fresh)
        await tx.run(
          `INSERT INTO conversation_members (conversation_id, user_id, added_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP(3), added_by = VALUES(added_by),
             cleared_before_message_id = 0`,
          [id2, userId, me.userId]
        );
      if (fresh.length) {
        await tx.run(`DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id IN (${fresh.map(() => "?").join(",")})`, [id2, ...fresh]);
        await systemMessage(tx, ctx2, id2, me, { type: "members_added", actorId: me.userId, targetIds: fresh });
        await emit(tx, ctx2, "conversation.updated", id2, [...current, ...fresh], { change: "members" });
      }
      return fresh;
    });
    ctx2.relay.kick();
    return { added, notAdded: refused };
  });
  app.delete("/chat/groups/:id/members/:userId", auth, async (request) => {
    const me = caller(request);
    const { id: id2, userId } = z4.object({ id, userId: id }).parse(request.params);
    const member = await membership(db2, id2, me.userId);
    if (member.kind !== "group") fail("bad_request", "This is not a group.");
    const leaving = userId === me.userId;
    if (!leaving) {
      if (!isAdmin(member)) fail("forbidden", "Only group admins can remove members.");
      const target2 = await membership(db2, id2, userId);
      if (target2.role === "owner") fail("forbidden", "The group owner cannot be removed.");
    }
    await db2.tx(async (tx) => {
      const before = await activeMemberIds(tx, id2);
      await tx.run("UPDATE conversation_members SET left_at = CURRENT_TIMESTAMP(3), role = 'member' WHERE conversation_id = ? AND user_id = ?", [id2, userId]);
      if (leaving && member.role === "owner") {
        const heir = await tx.one(
          "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL ORDER BY FIELD(role, 'admin', 'member'), joined_at LIMIT 1",
          [id2]
        );
        if (heir) await tx.run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [id2, heir.user_id]);
      }
      await systemMessage(tx, ctx2, id2, me, leaving ? { type: "member_left", actorId: me.userId } : { type: "member_removed", actorId: me.userId, targetIds: [userId] });
      await emit(tx, ctx2, "conversation.updated", id2, before, { change: "members" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.put("/chat/groups/:id/members/:userId/role", auth, async (request) => {
    const me = caller(request);
    const { id: id2, userId } = z4.object({ id, userId: id }).parse(request.params);
    const { role } = z4.object({ role: z4.enum(["admin", "member"]) }).parse(request.body);
    const member = await membership(db2, id2, me.userId);
    if (!isAdmin(member)) fail("forbidden", "Only group admins can change roles.");
    const target2 = await membership(db2, id2, userId);
    if (target2.role === "owner") fail("forbidden", "The group owner\u2019s role cannot be changed.");
    if (target2.role === role) return { ok: true };
    await db2.tx(async (tx) => {
      await tx.run("UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?", [role, id2, userId]);
      await systemMessage(tx, ctx2, id2, me, { type: role === "admin" ? "admin_promoted" : "admin_demoted", actorId: me.userId, targetIds: [userId] });
      await emit(tx, ctx2, "conversation.updated", id2, await activeMemberIds(tx, id2), { change: "members" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.post("/chat/groups/:id/invite-link", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const { reset } = z4.object({ reset: z4.boolean().default(false) }).parse(request.body ?? {});
    const member = await membership(db2, id2, me.userId);
    if (!isAdmin(member)) fail("forbidden", "Only group admins can share the invite link.");
    const group = await groupRow(id2);
    let code = group.invite_code;
    if (!code || reset) {
      code = randomToken(16);
      await db2.run("UPDATE `groups` SET invite_code = ? WHERE conversation_id = ?", [code, id2]);
    }
    return { code };
  });
  app.get("/chat/invites/:code", auth, async (request) => {
    const { code } = z4.object({ code: z4.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(request.params);
    const group = await db2.one(
      "SELECT conversation_id, name, description, avatar_media_id, approval_required FROM `groups` WHERE invite_code = ?",
      [code]
    );
    if (!group) fail("not_found", "This invite link is no longer valid.");
    const count = await db2.one("SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL", [group.conversation_id]);
    return {
      group: { id: group.conversation_id, name: group.name, description: group.description, avatarUrl: avatar(group.avatar_media_id), memberCount: Number(count?.total ?? 0), approvalRequired: Number(group.approval_required) === 1 }
    };
  });
  app.post("/chat/invites/:code/join", auth, async (request) => {
    const me = caller(request);
    const { code } = z4.object({ code: z4.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(request.params);
    const group = await db2.one(
      "SELECT conversation_id, approval_required, max_members FROM `groups` WHERE invite_code = ?",
      [code]
    );
    if (!group) fail("not_found", "This invite link is no longer valid.");
    const id2 = group.conversation_id;
    const existing = await db2.one("SELECT left_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [id2, me.userId]);
    if (existing && !existing.left_at) return { status: "joined", conversationId: id2 };
    if (Number(group.approval_required) === 1) {
      await db2.tx(async (tx) => {
        await tx.run("INSERT IGNORE INTO group_join_requests (conversation_id, user_id) VALUES (?, ?)", [id2, me.userId]);
        const admins = await tx.query("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL AND role IN ('admin','owner')", [id2]);
        await emit(tx, ctx2, "conversation.updated", id2, admins.map((a) => a.user_id), { change: "join_requests" });
      });
      ctx2.relay.kick();
      return { status: "requested", conversationId: id2 };
    }
    await db2.tx(async (tx) => {
      const current = await activeMemberIds(tx, id2);
      if (current.length >= group.max_members) fail("conflict", "This group is full.");
      await tx.run(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP(3), cleared_before_message_id = 0`,
        [id2, me.userId]
      );
      await systemMessage(tx, ctx2, id2, me, { type: "member_joined", actorId: me.userId });
      await emit(tx, ctx2, "conversation.updated", id2, [...current, me.userId], { change: "members" });
    });
    ctx2.relay.kick();
    return { status: "joined", conversationId: id2 };
  });
  app.get("/chat/groups/:id/join-requests", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    if (!isAdmin(await membership(db2, id2, me.userId))) fail("forbidden", "Only group admins can see join requests.");
    const rows = await db2.query("SELECT user_id, created_at FROM group_join_requests WHERE conversation_id = ? ORDER BY created_at", [id2]);
    return { requests: rows.map((row) => ({ userId: row.user_id, requestedAt: row.created_at.toISOString() })) };
  });
  app.delete("/chat/groups/:id/join-requests/:userId", auth, async (request) => {
    const me = caller(request);
    const { id: id2, userId } = z4.object({ id, userId: id }).parse(request.params);
    if (!isAdmin(await membership(db2, id2, me.userId))) fail("forbidden", "Only group admins can manage join requests.");
    await db2.run("DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id = ?", [id2, userId]);
    return { ok: true };
  });
  app.patch("/chat/conversations/:id/settings", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const input = conversationSettings.parse(request.body);
    await membership(db2, id2, me.userId, false);
    const sets = [];
    const values = [];
    if (input.mutedUntil !== void 0) {
      sets.push("muted_until = ?");
      values.push(input.mutedUntil ? new Date(input.mutedUntil) : null);
    }
    if (input.archived !== void 0) sets.push(input.archived ? "archived_at = CURRENT_TIMESTAMP(3)" : "archived_at = NULL");
    if (input.pinned !== void 0) {
      if (input.pinned) {
        const pinned = await db2.one("SELECT COUNT(*) AS total FROM conversation_members WHERE user_id = ? AND pinned_at IS NOT NULL AND conversation_id <> ?", [me.userId, id2]);
        if (Number(pinned?.total ?? 0) >= 3) fail("conflict", "You can pin up to 3 chats.");
      }
      sets.push(input.pinned ? "pinned_at = CURRENT_TIMESTAMP(3)" : "pinned_at = NULL");
    }
    if (input.markedUnread !== void 0) {
      sets.push("marked_unread = ?");
      values.push(input.markedUnread ? 1 : 0);
    }
    await db2.tx(async (tx) => {
      await tx.run(`UPDATE conversation_members SET ${sets.join(", ")} WHERE conversation_id = ? AND user_id = ?`, [...values, id2, me.userId]);
      await emit(tx, ctx2, "conversation.updated", id2, [me.userId], { change: "settings" });
    });
    ctx2.relay.kick();
    return { conversation: await one(me.userId, me.deviceId, id2) };
  });
  app.put("/chat/conversations/:id/disappearing", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const { seconds } = z4.object({ seconds: z4.union([z4.literal(null), ...DISAPPEARING_OPTIONS.map((v) => z4.literal(v))]) }).parse(request.body);
    const member = await membership(db2, id2, me.userId);
    if (member.kind === "group") {
      const group = await groupRow(id2);
      if (group.edit_info_policy === "admins" && !isAdmin(member)) fail("forbidden", "Only group admins can change this.");
    }
    await db2.tx(async (tx) => {
      await tx.run("UPDATE conversations SET disappearing_seconds = ? WHERE id = ?", [seconds, id2]);
      await systemMessage(tx, ctx2, id2, me, { type: "disappearing_changed", actorId: me.userId, value: seconds });
      await emit(tx, ctx2, "conversation.updated", id2, await activeMemberIds(tx, id2), { change: "disappearing" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.post("/chat/conversations/:id/clear", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    await membership(db2, id2, me.userId, false);
    const latest = await db2.one("SELECT COALESCE(MAX(id), 0) AS last FROM messages WHERE conversation_id = ?", [id2]);
    const last = latest?.last ?? "0";
    await db2.run(
      `UPDATE conversation_members SET cleared_before_message_id = ? + 1, last_read_message_id = GREATEST(last_read_message_id, ?)
       WHERE conversation_id = ? AND user_id = ?`,
      [last, last, id2, me.userId]
    );
    return { ok: true };
  });
  app.delete("/chat/conversations/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const member = await membership(db2, id2, me.userId, false);
    if (member.kind === "group" && !member.left_at) fail("conflict", "Exit the group before deleting it.");
    await db2.tx(async (tx) => {
      const latest = await tx.one("SELECT COALESCE(MAX(id), 0) AS last FROM messages WHERE conversation_id = ?", [id2]);
      const last = latest?.last ?? "0";
      await tx.run(
        `UPDATE conversation_members SET cleared_before_message_id = ? + 1, deleted_before_message_id = ? + 1,
           last_read_message_id = GREATEST(last_read_message_id, ?), pinned_at = NULL, archived_at = NULL, marked_unread = 0
         WHERE conversation_id = ? AND user_id = ?`,
        [last, last, last, id2, me.userId]
      );
      await emit(tx, ctx2, "conversation.updated", id2, [me.userId], { change: "deleted" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.get("/internal/conversations/:id/members", { preHandler: guards2.requireInternal }, async (request) => {
    const { id: id2 } = z4.object({ id }).parse(request.params);
    const conversation = await db2.one("SELECT kind FROM conversations WHERE id = ?", [id2]);
    if (!conversation) fail("not_found", "Conversation not found.");
    return { memberIds: await activeMemberIds(db2, id2), kind: conversation.kind };
  });
  app.get("/internal/users/:userId/peers", { preHandler: guards2.requireInternal }, async (request) => {
    const { userId } = z4.object({ userId: id }).parse(request.params);
    const rows = await db2.query(
      `SELECT DISTINCT o.user_id FROM conversation_members me
       JOIN conversation_members o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id AND o.left_at IS NULL
       WHERE me.user_id = ? AND me.left_at IS NULL LIMIT 5000`,
      [userId]
    );
    return { userIds: rows.map((row) => row.user_id) };
  });
}

// services/chat/src/messages.ts
import { z as z5 } from "zod";
var REACTION_MAX_LENGTH = 16;
function registerMessageRoutes(app, ctx2) {
  const { db: db2, guards: guards2 } = ctx2;
  const auth = { preHandler: guards2.requireAuth };
  const checkKeys = async (conversationId, me, keys) => {
    const devices = await ctx2.devices.forUsers(await activeMemberIds(db2, conversationId));
    const given = new Set(keys.map((key) => key.deviceId));
    const required = devices.filter((device2) => device2.deviceId !== me.deviceId);
    if (required.some((device2) => !given.has(device2.deviceId)))
      throw new AppError("devices_changed", "Encryption keys changed. Re-encrypting\u2026", { devices });
    const valid = new Set(devices.map((device2) => device2.deviceId));
    return keys.filter((key) => valid.has(key.deviceId) || key.deviceId === me.deviceId);
  };
  const canSend = async (member, me) => {
    if (member.kind === "group") {
      const group = await db2.one("SELECT send_policy FROM `groups` WHERE conversation_id = ?", [member.conversation_id]);
      if (group?.send_policy === "admins" && !isAdmin(member)) fail("forbidden", "Only admins can send messages to this group.");
      return;
    }
    const peers = (await activeMemberIds(db2, member.conversation_id)).filter((id2) => id2 !== me.userId);
    const relationships = await ctx2.users.relationships(me.userId, peers);
    if (relationships.some((r) => r.blocked)) fail("blocked", "You cannot message this person.");
  };
  const insertKeys = async (tx, messageId, keys) => {
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch2 = keys.slice(offset, offset + 500);
      await tx.run(
        `INSERT INTO message_keys (message_id, device_id, sealed_key) VALUES ${batch2.map(() => "(?, ?, ?)").join(",")}`,
        batch2.flatMap((key) => [messageId, key.deviceId, decode(key.sealedKey)])
      );
    }
  };
  const loadOne = async (messageId, me) => {
    const row = await db2.one(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ? WHERE m.id = ?`,
      [me.deviceId, messageId]
    );
    if (!row) fail("not_found", "Message not found.");
    const member = await membership(db2, row.conversation_id, me.userId, false);
    if (row.created_at < member.joined_at || member.left_at && row.created_at > member.left_at) fail("not_found", "Message not found.");
    return { row, member };
  };
  app.get("/chat/conversations/:id/messages", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const query = z5.object({ before: id.optional(), after: id.optional(), limit: z5.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const member = await membership(db2, id2, me.userId, false);
    const newer = query.after !== void 0;
    const rows = await db2.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
       WHERE m.conversation_id = ? AND m.id >= ? AND m.created_at >= ? ${member.left_at ? "AND m.created_at <= ?" : ""}
         AND ${newer ? "m.id > ?" : "m.id < ?"}
         AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP(3))
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = ? AND h.message_id = m.id)
       ORDER BY m.id ${newer ? "ASC" : "DESC"} LIMIT ${query.limit + 1}`,
      [
        me.deviceId,
        id2,
        member.cleared_before_message_id,
        member.joined_at,
        ...member.left_at ? [member.left_at] : [],
        newer ? query.after : query.before ?? "18446744073709551615",
        me.userId
      ]
    );
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!newer) page.reverse();
    return { messages: await toWire(db2, page, me.userId), hasMore: more, receipts: await receiptsFor(db2, id2, me.userId, member.kind) };
  });
  app.get("/chat/messages/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { row } = await loadOne(id2, me);
    return { message: (await toWire(db2, [row], me.userId))[0] };
  });
  app.get("/chat/messages/:id/info", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { row } = await loadOne(id2, me);
    if (row.sender_id !== me.userId) fail("forbidden", "You can only see info for your own messages.");
    const members = await db2.query(
      "SELECT user_id, last_read_message_id, last_delivered_message_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? AND left_at IS NULL",
      [row.conversation_id, me.userId]
    );
    const reached = (mark) => BigInt(mark) >= BigInt(id2);
    return {
      readBy: members.filter((m) => reached(m.last_read_message_id)).map((m) => m.user_id),
      deliveredTo: members.filter((m) => !reached(m.last_read_message_id) && reached(m.last_delivered_message_id)).map((m) => m.user_id)
    };
  });
  app.post("/chat/conversations/:id/messages", { ...auth, bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const input = sendMessage.parse(request.body);
    const earlier = await db2.one("SELECT id FROM messages WHERE sender_id = ? AND client_message_id = ?", [me.userId, input.clientMessageId]);
    if (earlier) return { message: (await toWire(db2, [(await loadOne(earlier.id, me)).row], me.userId))[0] };
    const member = await membership(db2, id2, me.userId);
    await canSend(member, me);
    const keys = await checkKeys(id2, me, input.keys);
    const mediaIds = [...new Set(input.mediaIds)];
    if (mediaIds.length) {
      const valid = await ctx2.media.verify(me.userId, mediaIds, ["message"]);
      if (valid.length !== mediaIds.length) fail("bad_request", "A file is still uploading. Try again in a moment.");
    }
    if (input.kind !== "text" && input.kind !== "poll" && input.kind !== "location" && input.kind !== "contact" && !mediaIds.length)
      fail("bad_request", "Attach the file to send.");
    if (input.replyToId) {
      const original = await db2.one("SELECT conversation_id FROM messages WHERE id = ?", [input.replyToId]);
      if (original?.conversation_id !== id2) fail("bad_request", "The message you replied to is not in this chat.");
    }
    const messageId = ctx2.ids.next();
    try {
      await db2.tx(async (tx) => {
        await tx.run(
          `INSERT INTO messages (id, conversation_id, sender_id, sender_device_id, kind, ciphertext, nonce, reply_to_id, forwarded_count, client_message_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            messageId,
            id2,
            me.userId,
            me.deviceId,
            input.kind,
            decode(input.ciphertext),
            decode(input.nonce),
            input.replyToId ?? null,
            input.forwardedCount,
            input.clientMessageId,
            member.disappearing_seconds ? new Date(Date.now() + member.disappearing_seconds * 1e3) : null
          ]
        );
        await insertKeys(tx, messageId, keys);
        for (const [ordinal, mediaId] of mediaIds.entries())
          await tx.run("INSERT INTO message_attachments (message_id, ordinal, media_id) VALUES (?, ?, ?)", [messageId, ordinal, mediaId]);
        await tx.run(
          "UPDATE conversation_members SET last_read_message_id = ?, last_delivered_message_id = ?, marked_unread = 0 WHERE conversation_id = ? AND user_id = ?",
          [messageId, messageId, id2, me.userId]
        );
        await tx.run("UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ? AND archived_at IS NOT NULL AND (muted_until IS NULL OR muted_until < CURRENT_TIMESTAMP(3))", [id2]);
        const muted = await tx.query(
          "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL AND muted_until > CURRENT_TIMESTAMP(3)",
          [id2]
        );
        const group = await tx.one("SELECT name FROM `groups` WHERE conversation_id = ?", [id2]);
        await emit(tx, ctx2, "message.sent", id2, await activeMemberIds(tx, id2), {
          messageId,
          senderId: me.userId,
          kind: input.kind,
          mutedBy: muted.map((row) => row.user_id),
          groupName: group?.name ?? null
        });
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await db2.one("SELECT id FROM messages WHERE sender_id = ? AND client_message_id = ?", [me.userId, input.clientMessageId]);
      return { message: (await toWire(db2, [(await loadOne(raced.id, me)).row], me.userId))[0] };
    }
    ctx2.relay.kick();
    reply.status(201);
    return { message: (await toWire(db2, [(await loadOne(messageId, me)).row], me.userId))[0] };
  });
  app.patch("/chat/messages/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const input = editMessage.parse(request.body);
    const { row } = await loadOne(id2, me);
    if (row.sender_id !== me.userId) fail("forbidden", "You can only edit your own messages.");
    if (row.kind !== "text" || row.deleted_at) fail("bad_request", "This message cannot be edited.");
    if (Date.now() - row.created_at.getTime() > EDIT_WINDOW_MS) fail("forbidden", "Messages can be edited for 15 minutes after sending.");
    await membership(db2, row.conversation_id, me.userId);
    const keys = await checkKeys(row.conversation_id, me, input.keys);
    await db2.tx(async (tx) => {
      await tx.run("UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [decode(input.ciphertext), decode(input.nonce), id2]);
      await tx.run("DELETE FROM message_keys WHERE message_id = ?", [id2]);
      await insertKeys(tx, id2, keys);
      await emit(tx, ctx2, "message.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id2, change: "edit" });
    });
    ctx2.relay.kick();
    return { message: (await toWire(db2, [(await loadOne(id2, me)).row], me.userId))[0] };
  });
  app.delete("/chat/messages/:id", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { scope } = z5.object({ scope: z5.enum(["me", "everyone"]).default("me") }).parse(request.query);
    const { row, member } = await loadOne(id2, me);
    if (scope === "me") {
      await db2.run("INSERT IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)", [me.userId, id2]);
      return { ok: true };
    }
    if (row.kind === "system" || row.deleted_at) fail("bad_request", "This message cannot be deleted for everyone.");
    const own = row.sender_id === me.userId;
    if (own && Date.now() - row.created_at.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) fail("forbidden", "Messages can be deleted for everyone within 48 hours.");
    if (!own && !(member.kind === "group" && isAdmin(member) && !member.left_at)) fail("forbidden", "You can only delete your own messages for everyone.");
    const files = (await db2.query("SELECT media_id FROM message_attachments WHERE message_id = ?", [id2])).map((a) => a.media_id);
    await db2.tx(async (tx) => {
      await tx.run("UPDATE messages SET ciphertext = NULL, nonce = NULL, deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id2]);
      await tx.run("DELETE FROM poll_votes WHERE message_id = ?", [id2]);
      await tx.run("DELETE FROM message_keys WHERE message_id = ?", [id2]);
      await tx.run("DELETE FROM message_reactions WHERE message_id = ?", [id2]);
      await tx.run("DELETE FROM message_attachments WHERE message_id = ?", [id2]);
      await tx.run("DELETE FROM conversation_pins WHERE message_id = ?", [id2]);
      await emit(tx, ctx2, "message.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id2, change: "delete", by: me.userId });
    });
    ctx2.relay.kick();
    await ctx2.media.release(files);
    return { ok: true };
  });
  app.put("/chat/messages/:id/reaction", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { emoji } = z5.object({ emoji: z5.string().min(1).max(REACTION_MAX_LENGTH).nullable() }).parse(request.body);
    const { row } = await loadOne(id2, me);
    await membership(db2, row.conversation_id, me.userId);
    if (row.deleted_at || row.kind === "system") fail("bad_request", "You cannot react to this message.");
    await db2.tx(async (tx) => {
      if (emoji) await tx.run("INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP(3)", [id2, me.userId, emoji]);
      else await tx.run("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?", [id2, me.userId]);
      await emit(tx, ctx2, "message.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id2, change: "reaction", by: me.userId, emoji });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.put("/chat/messages/:id/vote", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { options } = pollVote.parse(request.body);
    const { row } = await loadOne(id2, me);
    await membership(db2, row.conversation_id, me.userId);
    if (row.kind !== "poll" || row.deleted_at) fail("bad_request", "This is not a poll.");
    const unique = [...new Set(options)];
    await db2.tx(async (tx) => {
      await tx.run("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?", [id2, me.userId]);
      for (const option of unique) await tx.run("INSERT INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)", [id2, me.userId, option]);
      await emit(tx, ctx2, "message.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: id2, change: "vote", by: me.userId });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  app.put("/chat/messages/:id/star", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { starred } = z5.object({ starred: z5.boolean() }).parse(request.body);
    await loadOne(id2, me);
    if (starred) await db2.run("INSERT IGNORE INTO message_stars (user_id, message_id) VALUES (?, ?)", [me.userId, id2]);
    else await db2.run("DELETE FROM message_stars WHERE user_id = ? AND message_id = ?", [me.userId, id2]);
    return { ok: true };
  });
  app.get("/chat/starred", auth, async (request) => {
    const me = caller(request);
    const rows = await db2.query(
      `SELECT ${MESSAGE_COLUMNS} FROM message_stars s JOIN messages m ON m.id = s.message_id
       LEFT JOIN message_keys k ON k.message_id = m.id AND k.device_id = ?
       WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 200`,
      [me.deviceId, me.userId]
    );
    return { messages: await toWire(db2, rows, me.userId) };
  });
  app.put("/chat/messages/:id/pin", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { pinned, seconds } = z5.object({ pinned: z5.boolean(), seconds: z5.union([z5.literal(86400), z5.literal(604800), z5.literal(2592e3), z5.null()]).default(604800) }).parse(request.body);
    const { row } = await loadOne(id2, me);
    const member = await membership(db2, row.conversation_id, me.userId);
    if (member.kind === "group" && !isAdmin(member)) {
      const group = await db2.one("SELECT edit_info_policy FROM `groups` WHERE conversation_id = ?", [row.conversation_id]);
      if (group?.edit_info_policy === "admins") fail("forbidden", "Only group admins can pin messages.");
    }
    if (row.deleted_at || row.kind === "system") fail("bad_request", "This message cannot be pinned.");
    await db2.tx(async (tx) => {
      if (pinned) {
        await tx.run("DELETE FROM conversation_pins WHERE conversation_id = ? AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP(3)", [row.conversation_id]);
        const count = await tx.one("SELECT COUNT(*) AS total FROM conversation_pins WHERE conversation_id = ? AND message_id <> ?", [row.conversation_id, id2]);
        if (Number(count?.total ?? 0) >= MAX_PINS) {
          await tx.run("DELETE FROM conversation_pins WHERE conversation_id = ? ORDER BY pinned_at ASC LIMIT 1", [row.conversation_id]);
        }
        await tx.run(
          `INSERT INTO conversation_pins (conversation_id, message_id, pinned_by, expires_at) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE pinned_by = VALUES(pinned_by), pinned_at = CURRENT_TIMESTAMP(3), expires_at = VALUES(expires_at)`,
          [row.conversation_id, id2, me.userId, seconds ? new Date(Date.now() + seconds * 1e3) : null]
        );
      } else await tx.run("DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?", [row.conversation_id, id2]);
      await emit(tx, ctx2, "conversation.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { change: "pins" });
    });
    ctx2.relay.kick();
    return { ok: true };
  });
  const advance = async (conversationId, me, messageId, read) => {
    const member = await membership(db2, conversationId, me.userId, false);
    const target2 = await db2.one("SELECT id FROM messages WHERE id = ? AND conversation_id = ?", [messageId, conversationId]);
    if (!target2) fail("not_found", "Message not found.");
    const changed = await db2.tx(async (tx) => {
      const result = read ? await tx.run(
        `UPDATE conversation_members SET last_read_message_id = GREATEST(last_read_message_id, ?),
               last_delivered_message_id = GREATEST(last_delivered_message_id, ?), marked_unread = 0
             WHERE conversation_id = ? AND user_id = ? AND (last_read_message_id < ? OR marked_unread = 1)`,
        [messageId, messageId, conversationId, me.userId, messageId]
      ) : await tx.run(
        "UPDATE conversation_members SET last_delivered_message_id = GREATEST(last_delivered_message_id, ?) WHERE conversation_id = ? AND user_id = ? AND last_delivered_message_id < ?",
        [messageId, conversationId, me.userId, messageId]
      );
      if (result.affectedRows > 0)
        await emit(tx, ctx2, "receipt.updated", conversationId, await activeMemberIds(tx, conversationId), { userId: me.userId, kind: read ? "read" : "delivered", messageId });
      return result.affectedRows > 0;
    });
    if (changed) ctx2.relay.kick();
    return member;
  };
  app.post("/chat/conversations/:id/read", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { messageId } = z5.object({ messageId: id }).parse(request.body);
    await advance(id2, me, messageId, true);
    return { ok: true };
  });
  app.post("/chat/conversations/:id/delivered", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const { messageId } = z5.object({ messageId: id }).parse(request.body);
    await advance(id2, me, messageId, false);
    return { ok: true };
  });
  app.get("/chat/conversations/:id/receipts", auth, async (request) => {
    const me = caller(request);
    const { id: id2 } = z5.object({ id }).parse(request.params);
    const member = await membership(db2, id2, me.userId, false);
    return { receipts: await receiptsFor(db2, id2, me.userId, member.kind) };
  });
}

// services/chat/src/history.ts
import { z as z6 } from "zod";
var BATCH_SIZE = 100;
var target = z6.object({ deviceId: id, identityKey: publicKey });
var batch = z6.object({
  target,
  keys: z6.array(z6.object({
    messageId: id,
    nonce: z6.string().regex(/^[A-Za-z0-9_-]{32}$/),
    sealedKey: z6.string().regex(/^[A-Za-z0-9_-]{96}$/)
  })).min(1).max(BATCH_SIZE)
});
var ELIGIBLE = `FROM message_keys source
  JOIN messages m ON m.id = source.message_id
  JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
  WHERE source.device_id = ? AND m.ciphertext IS NOT NULL AND m.nonce IS NOT NULL
    AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP(3))
    AND m.id >= cm.cleared_before_message_id AND m.created_at >= cm.joined_at
    AND (cm.left_at IS NULL OR m.created_at <= cm.left_at)
    AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = cm.user_id AND h.message_id = m.id)`;
function registerHistoryRoutes(app, { db: db2, devices, guards: guards2 }) {
  const auth = { preHandler: guards2.requireAuth };
  const verifyDevices = async (me, destination) => {
    const owned = await devices.forUsers([me.userId], true);
    if (destination.deviceId === me.deviceId || !owned.some((d) => d.deviceId === me.deviceId) || !owned.some((d) => d.deviceId === destination.deviceId && d.identityKey === destination.identityKey))
      fail("forbidden", "History can only be transferred between your active devices.");
  };
  app.get("/chat/history/transfer", auth, async (request) => {
    const me = caller(request);
    const query = target.extend({ before: id.optional() }).parse(request.query);
    await verifyDevices(me, query);
    const rows = await db2.query(
      `SELECT m.id, m.nonce, COALESCE(source.wrap_device_id, m.sender_device_id) AS key_sender, source.sealed_key
       ${ELIGIBLE}
       AND NOT EXISTS (SELECT 1 FROM message_keys destination WHERE destination.message_id = m.id AND destination.device_id = ?)
       ${query.before ? "AND source.message_id < ?" : ""}
       ORDER BY source.message_id DESC LIMIT ${BATCH_SIZE}`,
      [me.userId, me.deviceId, query.deviceId, ...query.before ? [query.before] : []]
    );
    return {
      keys: rows.map((row) => ({ messageId: row.id, nonce: row.nonce.toString("base64url"), keySenderDeviceId: row.key_sender, sealedKey: row.sealed_key.toString("base64url") })),
      nextBefore: rows.length === BATCH_SIZE ? rows.at(-1).id : null
    };
  });
  app.post("/chat/history/transfer", auth, async (request) => {
    const me = caller(request);
    const input = batch.parse(request.body);
    await verifyDevices(me, input.target);
    const submitted = new Map(input.keys.map((key) => [key.messageId, key]));
    const added = await db2.tx(async (tx) => {
      const rows = await tx.query(
        `SELECT m.id, m.nonce ${ELIGIBLE} AND m.id IN (${[...submitted].map(() => "?").join(",")}) ORDER BY m.id FOR UPDATE`,
        [me.userId, me.deviceId, ...submitted.keys()]
      );
      const valid = rows.filter((row) => row.nonce.toString("base64url") === submitted.get(row.id).nonce);
      if (!valid.length) return 0;
      const result = await tx.run(
        `INSERT IGNORE INTO message_keys (message_id, device_id, sealed_key, wrap_device_id)
         VALUES ${valid.map(() => "(?, ?, ?, ?)").join(",")}`,
        valid.flatMap(({ id: messageId }) => [messageId, input.target.deviceId, Buffer.from(submitted.get(messageId).sealedKey, "base64url"), me.deviceId])
      );
      return result.affectedRows;
    });
    return { added };
  });
}

// services/chat/src/admin.ts
import { z as z7 } from "zod";
function registerAdminRoutes(app, { db: db2, guards: guards2 }) {
  const internal2 = { preHandler: guards2.requireInternal };
  app.get("/internal/admin/stats", internal2, async (request) => {
    const { days } = z7.object({ days: z7.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const from = Snowflake.floor(seriesStart(days));
    const today = Snowflake.floor(seriesStart(1));
    const [conversations, messages, daily, statuses] = await Promise.all([
      db2.query("SELECT kind, COUNT(*) AS total FROM conversations GROUP BY kind"),
      db2.one(
        "SELECT COUNT(*) AS total, COALESCE(SUM(id >= ?), 0) AS today FROM messages WHERE kind NOT IN ('system')",
        [today]
      ),
      db2.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM messages
         WHERE id >= ? AND kind NOT IN ('system') GROUP BY day`,
        [from]
      ),
      db2.one("SELECT COUNT(*) AS live FROM statuses WHERE expires_at > CURRENT_TIMESTAMP(3)")
    ]);
    const kinds = Object.fromEntries(conversations.map((row) => [row.kind, Number(row.total)]));
    return {
      directChats: kinds.direct ?? 0,
      groups: kinds.group ?? 0,
      messages: { total: Number(messages?.total ?? 0), today: Number(messages?.today ?? 0) },
      liveStatuses: Number(statuses?.live ?? 0),
      messagesDaily: dailySeries(daily, days)
    };
  });
  app.get("/internal/admin/users/:userId", internal2, async (request) => {
    const { userId } = z7.object({ userId: id }).parse(request.params);
    const [membership2, sent] = await Promise.all([
      db2.one(
        `SELECT COALESCE(SUM(c.kind = 'direct'), 0) AS direct, COALESCE(SUM(c.kind = 'group'), 0) AS \`groups\`,
                COALESCE(SUM(c.kind = 'group' AND cm.role = 'owner'), 0) AS owned
         FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = ? AND cm.left_at IS NULL`,
        [userId]
      ),
      db2.one(
        "SELECT COUNT(*) AS total, MAX(id) AS last FROM messages WHERE sender_id = ? AND kind <> 'system'",
        [userId]
      )
    ]);
    return {
      directChats: Number(membership2?.direct ?? 0),
      groups: Number(membership2?.groups ?? 0),
      groupsOwned: Number(membership2?.owned ?? 0),
      messagesSent: Number(sent?.total ?? 0),
      lastMessageAt: sent?.last ? Snowflake.timeOf(sent.last).toISOString() : null
    };
  });
  app.get("/internal/admin/groups/:id", internal2, async (request) => {
    const { id: id2 } = z7.object({ id }).parse(request.params);
    const group = await db2.one(
      `SELECT g.name, g.description, c.created_by, c.created_at,
              (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.left_at IS NULL) AS members
       FROM \`groups\` g JOIN conversations c ON c.id = g.conversation_id WHERE g.conversation_id = ?`,
      [id2]
    );
    if (!group) throw new AppError("not_found", "Group not found.");
    return { group: { id: id2, name: group.name, description: group.description, createdBy: group.created_by, createdAt: group.created_at.toISOString(), members: Number(group.members) } };
  });
}

// services/chat/src/main.ts
var env = loadConfig({
  PORT: z8.coerce.number().int().positive().default(4103),
  DB_NAME: z8.string().default("talkie_chat"),
  USERS_URL: z8.url().default("http://127.0.0.1:4102"),
  AUTH_URL: z8.url().default("http://127.0.0.1:4101"),
  MEDIA_PUBLIC_URL: z8.string().default("/api/media"),
  MEDIA_URL: z8.url().default("http://127.0.0.1:4105")
});
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "chat", env, ready: () => db.ping(), rateLimitPerMinute: 600, bodyLimit: 4 * 1024 * 1024 });
var ids = new Snowflake(env.WORKER_ID);
var guards = installAuth(service.app, await createVerifier(env), env);
var bus = createBus(env, service.log, "chat");
var relay = startOutboxRelay(db, bus, service.log);
var ctx = { db, ids, relay, guards, env, devices: deviceDirectory(env), users: usersClient(env), media: mediaClient(env) };
registerConversationRoutes(service.app, ctx);
registerMessageRoutes(service.app, ctx);
registerHistoryRoutes(service.app, ctx);
registerStatusRoutes(service.app, ctx);
registerAdminRoutes(service.app, ctx);
bus.subscribe("chat-devices", ["device.linked", "device.revoked"], async (event) => {
  ctx.devices.forget(String(event.payload.userId));
});
bus.subscribe("chat-flags", ["privacy.updated"], async (event) => {
  const { userId, readReceipts } = event.payload;
  if (readReceipts === void 0) return;
  await db.run("INSERT INTO user_flags (user_id, read_receipts) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_receipts = VALUES(read_receipts)", [userId, readReceipts ? 1 : 0]);
});
bus.subscribe("chat-calls", ["call.ended"], async (event) => {
  const call = event.payload;
  const conversationId = call.conversationId;
  if (!conversationId) return;
  const handled = await db.tx(async (tx) => {
    const first = await tx.run("INSERT IGNORE INTO processed_events (consumer_group, event_id) VALUES (?, ?)", ["chat-calls", event.id]);
    if (!first.affectedRows) return false;
    if (!await tx.one("SELECT 1 FROM conversations WHERE id = ?", [conversationId])) return false;
    const messageId = await systemMessage(tx, ctx, conversationId, { userId: call.initiatorId, deviceId: "0" }, {
      type: "call",
      actorId: call.initiatorId,
      call: { callId: call.callId, media: call.media, outcome: call.outcome, durationSeconds: call.durationSeconds, joinedIds: call.joinedIds }
    });
    await tx.run('UPDATE messages SET kind = "call" WHERE id = ?', [messageId]);
    await emit(tx, ctx, "message.sent", conversationId, await activeMemberIds(tx, conversationId), { messageId, senderId: call.initiatorId, kind: "call" });
    return true;
  });
  if (handled) relay.kick();
});
var sweep = setInterval(async () => {
  try {
    const expired = await db.query("SELECT id, conversation_id FROM messages WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP(3) LIMIT 500");
    const files = [];
    for (const row of expired)
      await db.tx(async (tx) => {
        files.push(...(await tx.query("SELECT media_id FROM message_attachments WHERE message_id = ?", [row.id])).map((a) => a.media_id));
        await tx.run("DELETE FROM messages WHERE id = ?", [row.id]);
        await emit(tx, ctx, "message.updated", row.conversation_id, await activeMemberIds(tx, row.conversation_id), { messageId: row.id, change: "expired" });
      });
    if (expired.length) relay.kick();
    await ctx.media.release(files);
    const statuses = await db.query("SELECT id, media_id FROM statuses WHERE expires_at < CURRENT_TIMESTAMP(3) LIMIT 500");
    if (statuses.length) {
      await db.run(`DELETE FROM statuses WHERE id IN (${statuses.map(() => "?").join(",")})`, statuses.map((s) => s.id));
      await ctx.media.release(statuses.map((s) => s.media_id).filter((id2) => !!id2));
    }
  } catch (error) {
    service.log.error({ err: error }, "expiry sweep failed");
  }
}, 6e4);
sweep.unref();
service.onShutdown(async () => {
  clearInterval(sweep);
  relay.stop();
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
