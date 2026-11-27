import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/auth/src/main.ts
import cookie from "@fastify/cookie";

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
var sha256 = (value) => createHash("sha256").update(value).digest();
var hmac = (key2, value) => createHmac("sha256", key2).update(value).digest();
var randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
var randomDigits = (length = 6) => Array.from({ length }, () => randomInt(0, 10)).join("");
var safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// packages/core/src/net.ts
import { isIPv4, isIPv6 } from "node:net";
function ipToBuffer(ip) {
  if (!ip) return null;
  const value = ip.startsWith("::ffff:") && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(value)) return Buffer.from(value.split(".").map(Number));
  if (!isIPv6(value)) return null;
  const [head = "", tail = ""] = value.split("::");
  const part = (s) => s ? s.split(":") : [];
  const left = part(head);
  const right = part(tail);
  const groups = value.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || "0", 16), index * 2));
  return out;
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
var likeEscape = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  const key2 = /* @__PURE__ */ Symbol.for("talkie.bus.subscribers");
  const subscribers = registry[key2] ??= [];
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
  const key2 = await importSPKI(publicKeyPem, ACCESS_TOKEN_ALG);
  return {
    async verify(token) {
      let auth;
      try {
        const { payload } = await jwtVerify(token, key2, {
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

// services/auth/src/config.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { z as z2 } from "zod";
var env = loadConfig({
  PORT: z2.coerce.number().int().positive().default(4101),
  DB_NAME: z2.string().default("talkie_auth"),
  JWT_PRIVATE_KEY: z2.string().optional(),
  JWT_PRIVATE_KEY_FILE: z2.string().optional(),
  /** HMAC key for one-time codes, at least 32 characters. */
  OTP_PEPPER: z2.string().min(32).default("development-otp-pepper-change-me-000000"),
  ACCESS_TOKEN_MINUTES: z2.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_DAYS: z2.coerce.number().int().min(1).max(365).default(60),
  USERS_URL: z2.url().default("http://127.0.0.1:4102"),
  NOTIFY_URL: z2.url().default("http://127.0.0.1:4107"),
  /** Development only: print one-time codes in the auth service log when email delivery is not configured. */
  DEV_LOG_OTP: z2.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Development only: every sign-in code is this value (6 digits), for scripted tests. Refused in production. */
  DEV_FIXED_OTP: z2.string().regex(/^\d{6}$/).optional(),
  /** Emails (comma separated) that become the platform owner on first sign-up. */
  OWNER_EMAILS: z2.string().default("")
});
if (env.NODE_ENV === "production" && env.DEV_FIXED_OTP)
  throw new Error("Invalid configuration:\n  DEV_FIXED_OTP must not be set in production");
if (env.NODE_ENV === "production" && env.OTP_PEPPER.startsWith("development-"))
  throw new Error("Invalid configuration:\n  OTP_PEPPER must be set in production");
function privateKeyPem() {
  if (env.JWT_PRIVATE_KEY) return env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (env.JWT_PRIVATE_KEY_FILE) return readFileSync3(configPath(env.JWT_PRIVATE_KEY_FILE), "utf8");
  throw new Error("JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_FILE is required (run `npm run keys:generate`)");
}
var ownerEmails = new Set(
  env.OWNER_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
);
var OTP = {
  ttlMinutes: 10,
  maxAttempts: 5,
  resendAfterSeconds: 60,
  perEmailPerHour: 5,
  perIpPerHour: 30,
  /** After a verified code, a new user has this long to choose a username. */
  signupWindowMinutes: 30
};

// services/auth/src/routes.ts
import { z as z4 } from "zod";

// packages/contracts/src/index.ts
import { z as z3 } from "zod";
var USERNAME_MIN = 3;
var USERNAME_MAX = 32;
var DISPLAY_NAME_MAX = 64;
var ABOUT_MAX = 140;
var OTP_LENGTH = 6;
var MAX_LINKED_DEVICES = 3;
var id = z3.string().regex(/^[1-9]\d{0,19}$/, "Invalid id");
var email = z3.string().trim().toLowerCase().max(254).pipe(z3.email("Enter a valid email address"));
var username = z3.string().trim().toLowerCase().min(USERNAME_MIN, `At least ${USERNAME_MIN} characters`).max(USERNAME_MAX, `At most ${USERNAME_MAX} characters`).regex(/^[a-z0-9._]+$/, "Use only letters, numbers, dot and underscore").refine((value) => !value.startsWith(".") && !value.endsWith(".") && !value.includes(".."), "Dots cannot be at the start, end or next to each other").refine((value) => /[a-z]/.test(value), "Include at least one letter");
var displayName = z3.string().trim().min(1, "Enter your name").max(DISPLAY_NAME_MAX, `At most ${DISPLAY_NAME_MAX} characters`).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Remove special control characters");
var about = z3.string().trim().max(ABOUT_MAX, `At most ${ABOUT_MAX} characters`);
var otpCode = z3.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);
var platform = z3.enum(["web", "android", "ios", "desktop"]);
var locale = z3.enum(["bn", "en"]);
var publicKey = z3.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid public key");
var device = z3.object({
  name: z3.string().trim().min(1).max(80),
  platform,
  /** Device identity key for end-to-end encryption, generated on the device. */
  identityKey: publicKey.optional()
});
var otpRequestKey = z3.string().regex(/^[A-Za-z0-9_-]{22}$/);
var otpRequest = z3.object({ email, locale: locale.default("bn"), requestKey: otpRequestKey.optional() });
var otpVerify = z3.union([
  z3.object({ challengeId: id, code: otpCode, device }),
  z3.object({ requestKey: otpRequestKey, code: otpCode, device })
]);
var signupComplete = z3.object({ signupToken: z3.string().min(20).max(512), username, displayName, device });
var usernameCheck = z3.object({ username });
var privacyAudience = z3.enum(["everyone", "contacts", "nobody"]);
var privacyKey = z3.enum(["last_seen", "online", "profile_photo", "about", "status", "groups_add"]);
var profileUpdate = z3.object({ displayName: displayName.optional(), about: about.optional(), locale: locale.optional() }).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var privacyUpdate = z3.object({
  settings: z3.array(z3.object({ key: privacyKey, audience: privacyAudience })).min(1).max(6).optional(),
  readReceipts: z3.boolean().optional()
});
var userReport = z3.object({
  reason: z3.enum(["spam", "harassment", "impersonation", "inappropriate", "other"]),
  note: z3.string().trim().max(500).default("")
});
var GROUP_NAME_MAX = 100;
var GROUP_DESCRIPTION_MAX = 2048;
var GROUP_MAX_MEMBERS = 1024;
var EDIT_WINDOW_MS = 15 * 6e4;
var DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 36e5;
var b64 = (maxChars) => z3.string().regex(/^[A-Za-z0-9_-]*$/, "Invalid encoding").max(maxChars);
var messageKind = z3.enum(["text", "image", "video", "audio", "voice", "document", "sticker", "location", "contact", "poll"]);
var clientMessageId = z3.string().regex(/^[0-9A-Za-z]{26}$/, "Invalid client message id");
var sealedKeys = z3.array(z3.object({ deviceId: id, sealedKey: b64(200) })).min(1).max(GROUP_MAX_MEMBERS * 5);
var sendMessage = z3.object({
  clientMessageId,
  kind: messageKind,
  ciphertext: b64(14e4),
  nonce: b64(40),
  keys: sealedKeys,
  replyToId: id.optional(),
  forwardedCount: z3.number().int().min(0).max(255).default(0),
  /** Uploaded (encrypted) files this message carries; their keys travel inside the ciphertext. */
  mediaIds: z3.array(id).max(10).default([])
});
var editMessage = z3.object({ ciphertext: b64(14e4), nonce: b64(40), keys: sealedKeys });
var createGroup = z3.object({
  name: z3.string().trim().min(1).max(GROUP_NAME_MAX),
  description: z3.string().trim().max(GROUP_DESCRIPTION_MAX).default(""),
  memberIds: z3.array(id).max(GROUP_MAX_MEMBERS - 1).default([])
});
var updateGroup = z3.object({
  name: z3.string().trim().min(1).max(GROUP_NAME_MAX).optional(),
  description: z3.string().trim().max(GROUP_DESCRIPTION_MAX).optional(),
  sendPolicy: z3.enum(["all", "admins"]).optional(),
  editInfoPolicy: z3.enum(["all", "admins"]).optional(),
  addMemberPolicy: z3.enum(["all", "admins"]).optional(),
  approvalRequired: z3.boolean().optional(),
  avatarMediaId: id.nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var conversationSettings = z3.object({
  mutedUntil: z3.iso.datetime().nullable().optional(),
  archived: z3.boolean().optional(),
  pinned: z3.boolean().optional(),
  markedUnread: z3.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var MEDIA_PART_SIZE = 8 * 1024 * 1024;
var MEDIA_CHUNK_SIZE = 64 * 1024;
var MEDIA_LIMITS = {
  message: 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024,
  status: 64 * 1024 * 1024,
  avatar: 10 * 1024 * 1024,
  group_avatar: 10 * 1024 * 1024
};
var createUpload = z3.object({
  purpose: z3.enum(["message", "status", "avatar", "group_avatar"]),
  byteSize: z3.number().int().positive(),
  /** Encrypted media is always application/octet-stream on the server; avatars are images. */
  contentType: z3.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(127)
});
var pollVote = z3.object({ options: z3.array(z3.number().int().min(0).max(11)).max(12) });
var STATUS_TTL_MS = 24 * 36e5;
var createStatus = z3.object({
  kind: z3.enum(["text", "image", "video"]),
  ciphertext: b64(2e4),
  nonce: b64(40),
  keys: sealedKeys,
  audience: z3.array(id).max(5e3),
  mediaId: id.optional()
});
var startCall = z3.object({
  conversationId: id,
  media: z3.enum(["audio", "video"]),
  /** The call's media key sealed for every invited device (end-to-end encrypted calls). */
  keys: sealedKeys
});
var meetingAccess = z3.enum(["open", "trusted", "restricted"]);
var createMeeting = z3.object({
  title: z3.string().trim().max(160).default(""),
  description: z3.string().trim().max(2048).default(""),
  scheduledStartAt: z3.iso.datetime().nullable().default(null),
  scheduledEndAt: z3.iso.datetime().nullable().default(null),
  access: meetingAccess.default("trusted"),
  inviteeIds: z3.array(id).max(500).default([])
});
var meetingControls = z3.object({
  hostManagement: z3.boolean(),
  allowScreenShare: z3.boolean(),
  allowChat: z3.boolean(),
  allowReactions: z3.boolean(),
  allowUnmute: z3.boolean(),
  allowVideo: z3.boolean(),
  locked: z3.boolean()
}).partial();
var updateMeeting = z3.object({
  title: z3.string().trim().max(160).optional(),
  description: z3.string().trim().max(2048).optional(),
  access: meetingAccess.optional(),
  controls: meetingControls.optional(),
  scheduledStartAt: z3.iso.datetime().nullable().optional(),
  scheduledEndAt: z3.iso.datetime().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Nothing to update");
var meetingChat = z3.object({ body: z3.string().trim().min(1).max(2e3) });
var createMeetingPoll = z3.object({
  question: z3.string().trim().min(1).max(300),
  options: z3.array(z3.string().trim().min(1).max(120)).min(2).max(10),
  multipleChoice: z3.boolean().default(false),
  anonymous: z3.boolean().default(false)
});
var askQuestion = z3.object({ body: z3.string().trim().min(1).max(500), anonymous: z3.boolean().default(false) });
var breakoutPlan = z3.object({
  rooms: z3.array(z3.object({ name: z3.string().trim().min(1).max(60), participantIds: z3.array(id).max(500) })).min(1).max(50),
  minutes: z3.number().int().min(1).max(240).nullable().default(null)
});

// services/auth/src/clients.ts
var headers = { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" };
async function call(url, init, timeout = 5e3) {
  let response;
  try {
    response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new AppError("unavailable", "Talkie is busy right now. Please try again in a moment.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error && response.status < 500) throw new AppError(body.error.code, body.error.message);
    throw new AppError("unavailable", "Talkie is busy right now. Please try again in a moment.");
  }
  return body;
}
var usersClient = {
  create: (input) => call(`${env.USERS_URL}/internal/profiles`, { method: "POST", body: JSON.stringify(input) }),
  get: (userId) => call(`${env.USERS_URL}/internal/profiles/${userId}`, { method: "GET" })
};
async function sendOtpEmail(log, to, code, locale2) {
  try {
    await call(`${env.NOTIFY_URL}/internal/email/otp`, { method: "POST", body: JSON.stringify({ to, code, locale: locale2 }) }, 18e3);
  } catch (error) {
    if (env.NODE_ENV !== "production" && env.DEV_LOG_OTP) {
      log.warn({ to }, `email not delivered; development sign-in code for ${to}: ${code}`);
      return "sent";
    }
    log.warn({ err: error }, "could not confirm OTP delivery");
    return "uncertain";
  }
  if (env.NODE_ENV !== "production" && env.DEV_LOG_OTP) log.info(`development sign-in code for ${to}: ${code}`);
  return "sent";
}

// services/auth/src/sessions.ts
import { createHmac as createHmac2 } from "node:crypto";

// services/auth/src/tokens.ts
import { importPKCS8, SignJWT } from "jose";
var signingKey;
async function key() {
  signingKey ??= await importPKCS8(privateKeyPem(), ACCESS_TOKEN_ALG);
  return signingKey;
}
async function signAccessToken(context) {
  const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_MINUTES * 6e4);
  const token = await new SignJWT({ did: context.deviceId, sid: context.sessionId, role: context.role }).setProtectedHeader({ alg: ACCESS_TOKEN_ALG, typ: "JWT" }).setSubject(context.userId).setIssuer(env.JWT_ISSUER).setAudience(env.JWT_AUDIENCE).setIssuedAt().setExpirationTime(Math.floor(expiresAt.getTime() / 1e3)).sign(await key());
  return { token, expiresAt };
}

// services/auth/src/sessions.ts
var refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 864e5);
async function sessionIsActive(db2, auth) {
  return !!await db2.one(
    `SELECT 1 FROM sessions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id
     WHERE s.id = ? AND d.id = ? AND a.id = ? AND a.status = 'active'
       AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP(3))`,
    [auth.sessionId, auth.deviceId, auth.userId]
  );
}
async function issueRefresh(tx, sessionId, token = randomToken(32)) {
  await tx.run("INSERT INTO refresh_tokens (token_hash, session_id) VALUES (?, ?)", [sha256(token), sessionId]);
  return token;
}
async function trimDevices(tx, ids2, accountId, keep) {
  const active = await tx.query(
    "SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at, id FOR UPDATE",
    [accountId]
  );
  const overflow = active.slice(0, Math.max(0, active.length - keep));
  for (const old of overflow) await revokeDevice(tx, ids2, accountId, old.id, "device_removed");
  return overflow[0]?.id ?? null;
}
async function enforceDeviceLimit(db2, ids2) {
  const accounts = await db2.query("SELECT account_id FROM devices WHERE revoked_at IS NULL GROUP BY account_id HAVING COUNT(*) > ?", [MAX_LINKED_DEVICES]);
  for (const { account_id } of accounts) {
    await db2.tx(async (tx) => {
      if (await tx.one("SELECT id FROM accounts WHERE id = ? FOR UPDATE", [account_id])) await trimDevices(tx, ids2, account_id, MAX_LINKED_DEVICES);
    });
  }
}
async function openSession(db2, ids2, account, device2, client) {
  const result = await db2.tx(async (tx) => {
    const fresh = await tx.one("SELECT id, email, status, role FROM accounts WHERE id = ? FOR UPDATE", [account.id]);
    if (fresh?.status !== "active") throw new AppError("forbidden", "This account cannot sign in.");
    const revokedDeviceId = await trimDevices(tx, ids2, account.id, MAX_LINKED_DEVICES - 1);
    const deviceId = ids2.next();
    const sessionId = ids2.next();
    await tx.run("INSERT INTO devices (id, account_id, name, platform, identity_key) VALUES (?, ?, ?, ?, ?)", [
      deviceId,
      account.id,
      device2.name,
      device2.platform,
      device2.identityKey ?? null
    ]);
    await tx.run(
      "INSERT INTO sessions (id, device_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)",
      [sessionId, deviceId, device2.platform === "android" || device2.platform === "ios" ? null : refreshExpiry(), client.userAgent?.slice(0, 255) ?? null, ipToBuffer(client.ip)]
    );
    await tx.run("UPDATE accounts SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [account.id]);
    const refreshToken = await issueRefresh(tx, sessionId);
    await writeOutbox(tx, {
      id: ids2.next(),
      type: "device.linked",
      key: account.id,
      payload: { userId: account.id, deviceId, platform: device2.platform, name: device2.name }
    });
    return { deviceId, sessionId, refreshToken, revokedDeviceId, role: fresh.role };
  });
  const access = await signAccessToken({
    userId: account.id,
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    role: result.role
  });
  return {
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    revokedDeviceId: result.revokedDeviceId,
    tokens: {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: result.refreshToken
    }
  };
}
async function revokeDevice(tx, ids2, accountId, deviceId, reason) {
  const updated = await tx.run(
    "UPDATE devices SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    [deviceId, accountId]
  );
  if (updated.affectedRows === 0) return false;
  await tx.run(
    "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = ? WHERE device_id = ? AND revoked_at IS NULL",
    [reason, deviceId]
  );
  await writeOutbox(tx, { id: ids2.next(), type: "device.revoked", key: accountId, payload: { userId: accountId, deviceId, reason } });
  return true;
}
async function rotate(db2, ids2, refreshToken, attempt) {
  const hash = sha256(refreshToken);
  const outcome = await db2.tx(async (tx) => {
    const row = await tx.one(
      `SELECT r.session_id, r.used_at, r.rotation_attempt, d.account_id, s.device_id, s.expires_at, s.revoked_at, a.status, a.role
       FROM refresh_tokens r
       JOIN sessions s ON s.id = r.session_id
       JOIN devices d ON d.id = s.device_id
       JOIN accounts a ON a.id = d.account_id
       WHERE r.token_hash = ? FOR UPDATE`,
      [hash]
    );
    if (!row) return { kind: "invalid" };
    if (row.revoked_at) return { kind: "revoked" };
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return { kind: "expired" };
    if (row.status !== "active") return { kind: "suspended" };
    const retry = row.expires_at === null ? attempt : void 0;
    const attemptHash = retry ? sha256(retry) : null;
    const next = retry ? createHmac2("sha256", env.OTP_PEPPER).update(`native-refresh:${refreshToken}:${retry}`).digest("base64url") : void 0;
    if (row.used_at) {
      if (next && attemptHash && row.rotation_attempt?.equals(attemptHash)) {
        const successor = await tx.one("SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND session_id = ? AND used_at IS NULL", [sha256(next), row.session_id]);
        return successor ? { kind: "ok", row, next } : { kind: "invalid" };
      }
      await revokeDevice(tx, ids2, row.account_id, row.device_id, "token_reuse");
      return { kind: "reused" };
    }
    await tx.run("UPDATE refresh_tokens SET used_at = CURRENT_TIMESTAMP(3), rotation_attempt = ? WHERE token_hash = ?", [attemptHash, hash]);
    if (row.expires_at) await tx.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [refreshExpiry(), row.session_id]);
    await tx.run("UPDATE devices SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row.device_id]);
    return { kind: "ok", row, next: await issueRefresh(tx, row.session_id, next) };
  });
  if (outcome.kind === "reused") throw new AppError("session_revoked", "This session was signed out for your safety. Please sign in again.");
  if (outcome.kind === "suspended") throw new AppError("forbidden", "This account is suspended.");
  if (outcome.kind !== "ok") throw new AppError("unauthorized", "Your session has expired. Please sign in again.");
  const access = await signAccessToken({
    userId: outcome.row.account_id,
    deviceId: outcome.row.device_id,
    sessionId: outcome.row.session_id,
    role: outcome.row.role
  });
  return {
    accountId: outcome.row.account_id,
    deviceId: outcome.row.device_id,
    tokens: { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: outcome.next }
  };
}
async function listDevices(db2, accountId, currentDeviceId) {
  const rows = await db2.query(
    `SELECT id, name, platform, created_at, last_active_at FROM devices
     WHERE account_id = ? AND revoked_at IS NULL ORDER BY last_active_at DESC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    current: row.id === currentDeviceId,
    createdAt: row.created_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString()
  }));
}

// services/auth/src/routes.ts
var REFRESH_COOKIE = "talkie_rt";
var cookiePath = "/api/auth";
var isWeb = (request) => request.headers["x-talkie-client"] === "web";
function deliverTokens(request, reply, tokens) {
  if (isWeb(request)) {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict",
      path: cookiePath,
      maxAge: env.REFRESH_TOKEN_DAYS * 86400
    });
    return { accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt };
  }
  return tokens;
}
var codeHash = (challengeId, code) => hmac(env.OTP_PEPPER, `${challengeId}:${code}`);
function registerRoutes(app, db2, ids2, guards2) {
  const client = (request) => ({ ip: request.ip, userAgent: request.headers["user-agent"] });
  const me = async (account) => {
    const { profile } = await usersClient.get(account.id);
    return { ...profile, email: account.email, role: account.role };
  };
  app.post("/auth/otp/request", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const input = otpRequest.parse(request.body);
    const ip = ipToBuffer(request.ip);
    const recent = await db2.one(
      `SELECT COUNT(*) AS total, MAX(created_at) AS last FROM otp_challenges
       WHERE email = ? AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR`,
      [input.email]
    );
    if (recent?.last && Date.now() - recent.last.getTime() < OTP.resendAfterSeconds * 1e3)
      fail("rate_limited", "Please wait a moment before asking for a new code.", {
        retryAfterSeconds: Math.ceil(OTP.resendAfterSeconds - (Date.now() - recent.last.getTime()) / 1e3)
      });
    if (Number(recent?.total ?? 0) >= OTP.perEmailPerHour)
      fail("rate_limited", "Too many codes were requested for this email. Try again in an hour.", { retryAfterSeconds: 3600 });
    if (ip) {
      const fromIp = await db2.one(
        "SELECT COUNT(*) AS total FROM otp_challenges WHERE request_ip = ? AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR",
        [ip]
      );
      if (Number(fromIp?.total ?? 0) >= OTP.perIpPerHour)
        fail("rate_limited", "Too many sign-in attempts from this network. Try again later.", { retryAfterSeconds: 3600 });
    }
    const challengeId = ids2.next();
    const code = env.DEV_FIXED_OTP ?? randomDigits(OTP_LENGTH);
    const expiresAt = new Date(Date.now() + OTP.ttlMinutes * 6e4);
    await db2.run("INSERT INTO otp_challenges (id, email, code_hash, expires_at, request_ip, request_key_hash) VALUES (?, ?, ?, ?, ?, ?)", [
      challengeId,
      input.email,
      codeHash(challengeId, code),
      expiresAt,
      ip,
      input.requestKey ? sha256(input.requestKey) : null
    ]);
    const delivery = await sendOtpEmail(request.log, input.email, code, input.locale);
    const body = { challengeId, expiresAt: expiresAt.toISOString(), resendAfterSeconds: OTP.resendAfterSeconds, delivery };
    return body;
  });
  app.post("/auth/otp/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = otpVerify.parse(request.body);
    const check = await db2.tx(async (tx) => {
      const byId = "challengeId" in input;
      const challenge = await tx.one(
        `SELECT id, email, code_hash, attempts, expires_at, verified_at, consumed_at FROM otp_challenges WHERE ${byId ? "id" : "request_key_hash"} = ? FOR UPDATE`,
        [byId ? input.challengeId : sha256(input.requestKey)]
      );
      if (!challenge || challenge.consumed_at || challenge.verified_at) return { kind: "invalid" };
      if (challenge.expires_at.getTime() < Date.now()) return { kind: "expired" };
      if (challenge.attempts >= OTP.maxAttempts) return { kind: "attempts" };
      if (!safeEqual(codeHash(challenge.id, input.code), challenge.code_hash)) {
        await tx.run("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?", [challenge.id]);
        return { kind: "wrong", left: OTP.maxAttempts - challenge.attempts - 1 };
      }
      const account = await tx.one("SELECT id, email, status, role FROM accounts WHERE email = ?", [challenge.email]);
      if (account?.status === "active") {
        await tx.run("UPDATE otp_challenges SET verified_at = CURRENT_TIMESTAMP(3), consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [challenge.id]);
        if (ownerEmails.has(account.email) && account.role !== "owner") {
          await tx.run("UPDATE accounts SET role = 'owner' WHERE id = ?", [account.id]);
          account.role = "owner";
        }
        return { kind: "account", account };
      }
      if (account && account.status !== "pending_profile") return { kind: "blocked", status: account.status };
      const signupToken = randomToken(32);
      await tx.run("UPDATE otp_challenges SET verified_at = CURRENT_TIMESTAMP(3), signup_token_hash = ? WHERE id = ?", [
        sha256(signupToken),
        challenge.id
      ]);
      return { kind: "signup", signupToken, email: challenge.email };
    });
    switch (check.kind) {
      case "invalid":
        return fail("otp_invalid", "This code is no longer valid. Ask for a new one.");
      case "expired":
        return fail("otp_expired", "This code has expired. Ask for a new one.");
      case "attempts":
        return fail("otp_attempts_exceeded", "Too many wrong codes. Ask for a new one.");
      case "wrong":
        return fail("otp_invalid", "That code is not correct.", { attemptsLeft: check.left });
      case "blocked":
        return fail("forbidden", check.status === "suspended" ? "This account is suspended." : "This account was deleted.");
      case "signup": {
        const body = { status: "needs_signup", signupToken: check.signupToken, email: check.email };
        return body;
      }
      case "account": {
        const session = await openSession(db2, ids2, check.account, input.device, client(request));
        const body = {
          status: "signed_in",
          user: await me(check.account),
          tokens: deliverTokens(request, reply, session.tokens),
          deviceId: session.deviceId
        };
        return body;
      }
    }
  });
  app.post("/auth/signup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = signupComplete.parse(request.body);
    const locale2 = locale.catch("bn").parse(request.body.locale);
    const ticket = await db2.one(
      "SELECT id, email, verified_at, consumed_at FROM otp_challenges WHERE signup_token_hash = ?",
      [sha256(input.signupToken)]
    );
    if (!ticket?.verified_at || ticket.consumed_at || Date.now() - ticket.verified_at.getTime() > OTP.signupWindowMinutes * 6e4)
      fail("otp_expired", "Your sign-up time ran out. Please start again.");
    const email2 = ticket.email;
    let account = await db2.one("SELECT id, email, status, role FROM accounts WHERE email = ?", [email2]);
    if (!account) {
      const id2 = ids2.next();
      const role = ownerEmails.has(email2) ? "owner" : "user";
      await db2.run("INSERT IGNORE INTO accounts (id, email, status, role) VALUES (?, ?, 'pending_profile', ?)", [id2, email2, role]);
      account = await db2.one("SELECT id, email, status, role FROM accounts WHERE email = ?", [email2]);
    }
    if (!account) return fail("internal", "Could not create the account.");
    if (account.status === "active") fail("conflict", "This email already has an account. Sign in instead.");
    if (account.status !== "pending_profile") fail("forbidden", "This account cannot be used.");
    await usersClient.create({ userId: account.id, username: input.username, displayName: input.displayName, locale: locale2 });
    const activated = await db2.tx(async (tx) => {
      const consumed = await tx.run("UPDATE otp_challenges SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL", [ticket.id]);
      if (consumed.affectedRows === 0) return false;
      await tx.run("UPDATE accounts SET status = 'active' WHERE id = ?", [account.id]);
      await writeOutbox(tx, {
        id: ids2.next(),
        type: "account.created",
        key: account.id,
        payload: { userId: account.id, email: email2, username: input.username, displayName: input.displayName, locale: locale2 }
      });
      return true;
    });
    if (!activated) fail("otp_expired", "This sign-up was already completed. Sign in instead.");
    const active = { ...account, status: "active" };
    const session = await openSession(db2, ids2, active, input.device, client(request));
    reply.status(201);
    const body = {
      status: "signed_in",
      user: await me(active),
      tokens: deliverTokens(request, reply, session.tokens),
      deviceId: session.deviceId
    };
    return body;
  });
  app.post("/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const fromBody = z4.object({ refreshToken: z4.string().min(20).max(256), attempt: z4.string().regex(/^[a-f0-9]{32}$/).optional() }).safeParse(request.body ?? {});
    const token = isWeb(request) ? request.cookies[REFRESH_COOKIE] : fromBody.success ? fromBody.data.refreshToken : void 0;
    if (!token) fail("unauthorized", "Please sign in.");
    try {
      const result = await rotate(db2, ids2, token, fromBody.success ? fromBody.data.attempt : void 0);
      return { tokens: deliverTokens(request, reply, result.tokens), deviceId: result.deviceId };
    } catch (error) {
      if (isWeb(request) && error instanceof AppError && ["unauthorized", "session_revoked", "forbidden"].includes(error.code)) reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
      throw error;
    }
  });
  app.post("/auth/logout", { preHandler: guards2.requireAuth }, async (request, reply) => {
    const auth = caller(request);
    await db2.tx((tx) => revokeDevice(tx, ids2, auth.userId, auth.deviceId, "sign_out"));
    reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
    return { ok: true };
  });
  app.get("/auth/account", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const account = await db2.one("SELECT id, email, status, role, created_at FROM accounts WHERE id = ?", [auth.userId]);
    if (!account) fail("not_found", "Account not found.");
    return { email: account.email, role: account.role, deviceId: auth.deviceId, createdAt: account.created_at.toISOString() };
  });
  app.get("/auth/devices", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    return { devices: await listDevices(db2, auth.userId, auth.deviceId) };
  });
  app.delete("/auth/devices/:deviceId", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { deviceId } = z4.object({ deviceId: id }).parse(request.params);
    const removed = await db2.tx((tx) => revokeDevice(tx, ids2, auth.userId, deviceId, deviceId === auth.deviceId ? "sign_out" : "device_removed"));
    if (!removed) fail("not_found", "Device not found.");
    return { ok: true };
  });
  app.put("/auth/devices/current/identity-key", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { identityKey } = z4.object({ identityKey: publicKey }).parse(request.body);
    await db2.run("UPDATE devices SET identity_key = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL", [identityKey, auth.deviceId, auth.userId]);
    return { ok: true };
  });
  app.get("/auth/users/:userId/device-keys", { preHandler: guards2.requireAuth }, async (request) => {
    const { userId } = z4.object({ userId: id }).parse(request.params);
    const rows = await db2.query(
      "SELECT id, identity_key FROM devices WHERE account_id = ? AND revoked_at IS NULL AND identity_key IS NOT NULL",
      [userId]
    );
    return { devices: rows.map((row) => ({ deviceId: row.id, identityKey: row.identity_key })) };
  });
  app.post("/auth/device-keys/lookup", { preHandler: guards2.requireAuth }, async (request) => {
    const { deviceIds } = z4.object({ deviceIds: z4.array(id).min(1).max(200) }).parse(request.body);
    const rows = await db2.query(
      `SELECT id, account_id, identity_key FROM devices WHERE id IN (${deviceIds.map(() => "?").join(",")}) AND identity_key IS NOT NULL`,
      deviceIds
    );
    return { devices: rows.map((row) => ({ deviceId: row.id, userId: row.account_id, identityKey: row.identity_key })) };
  });
  app.post("/internal/sessions/check", { preHandler: guards2.requireInternal, config: { rateLimit: false } }, async (request) => {
    const auth = z4.object({ userId: id, deviceId: id, sessionId: id }).parse(request.body);
    return { active: await sessionIsActive(db2, auth) };
  });
  app.post("/internal/device-keys", { preHandler: guards2.requireInternal }, async (request) => {
    const { userIds } = z4.object({ userIds: z4.array(id).min(1).max(1024) }).parse(request.body);
    const rows = await db2.query(
      `SELECT id, account_id, identity_key FROM devices
       WHERE account_id IN (${userIds.map(() => "?").join(",")}) AND revoked_at IS NULL AND identity_key IS NOT NULL`,
      userIds
    );
    return { devices: rows.map((row) => ({ userId: row.account_id, deviceId: row.id, identityKey: row.identity_key })) };
  });
  app.post("/internal/accounts/:userId/status", { preHandler: guards2.requireInternal }, async (request) => {
    const { userId } = z4.object({ userId: id }).parse(request.params);
    const { status, reason } = z4.object({ status: z4.enum(["active", "suspended"]), reason: z4.string().max(255).default("") }).parse(request.body);
    await db2.tx(async (tx) => {
      const updated = await tx.run("UPDATE accounts SET status = ?, suspended_reason = ? WHERE id = ? AND status IN ('active','suspended')", [
        status,
        status === "suspended" ? reason : null,
        userId
      ]);
      if (updated.affectedRows === 0) throw new AppError("not_found", "Account not found.");
      if (status === "suspended") {
        const devices = await tx.query("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL", [userId]);
        for (const device2 of devices) await revokeDevice(tx, ids2, userId, device2.id, "account_suspended");
      }
      await writeOutbox(tx, { id: ids2.next(), type: "account.status_changed", key: userId, payload: { userId, status } });
    });
    return { ok: true };
  });
}

// services/auth/src/admin.ts
import { z as z5 } from "zod";
var accountView = (row) => ({
  id: row.id,
  email: row.email,
  status: row.status,
  role: row.role,
  createdAt: row.created_at.toISOString(),
  lastLoginAt: row.last_login_at?.toISOString() ?? null,
  lastActiveAt: row.last_active_at?.toISOString() ?? null,
  suspendedReason: row.suspended_reason,
  devices: Number(row.devices)
});
var LIST_SQL = `SELECT a.id, a.email, a.status, a.role, a.created_at, a.last_login_at, a.suspended_reason,
  (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
  (SELECT MAX(d.last_active_at) FROM devices d WHERE d.account_id = a.id) AS last_active_at
  FROM accounts a`;
function registerAdminRoutes(app, db2, ids2, guards2) {
  const internal = { preHandler: guards2.requireInternal };
  app.post("/internal/admin/accounts", internal, async (request) => {
    const input = z5.object({
      ids: z5.array(id).max(200).optional(),
      email: z5.string().trim().toLowerCase().max(254).optional(),
      status: z5.enum(["pending_profile", "active", "suspended", "deleted"]).optional(),
      staff: z5.boolean().optional(),
      before: id.optional(),
      limit: z5.number().int().min(1).max(100).default(50)
    }).parse(request.body);
    const where = [];
    const params = [];
    if (input.ids) {
      if (!input.ids.length) return { accounts: [] };
      where.push(`a.id IN (${input.ids.map(() => "?").join(",")})`);
      params.push(...input.ids);
    }
    if (input.email) {
      where.push("a.email LIKE ?");
      params.push(`%${likeEscape(input.email)}%`);
    }
    if (input.status) {
      where.push("a.status = ?");
      params.push(input.status);
    }
    if (input.staff) where.push("a.role <> 'user'");
    if (input.before) {
      where.push("a.id < ?");
      params.push(input.before);
    }
    const rows = await db2.query(
      `${LIST_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ${input.limit}`,
      params
    );
    return { accounts: rows.map(accountView) };
  });
  app.get("/internal/admin/accounts/:userId", internal, async (request) => {
    const { userId } = z5.object({ userId: id }).parse(request.params);
    const row = await db2.one(`${LIST_SQL} WHERE a.id = ?`, [userId]);
    if (!row) throw new AppError("not_found", "Account not found.");
    const devices = await db2.query(
      "SELECT id, name, platform, created_at, last_active_at, revoked_at FROM devices WHERE account_id = ? ORDER BY revoked_at IS NULL DESC, last_active_at DESC LIMIT 30",
      [userId]
    );
    return {
      account: accountView(row),
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        createdAt: d.created_at.toISOString(),
        lastActiveAt: d.last_active_at.toISOString(),
        revokedAt: d.revoked_at?.toISOString() ?? null
      }))
    };
  });
  app.get("/internal/admin/accounts/:userId/access", internal, async (request) => {
    const { userId } = z5.object({ userId: id }).parse(request.params);
    const row = await db2.one("SELECT role, status FROM accounts WHERE id = ?", [userId]);
    return { role: row?.role ?? "user", status: row?.status ?? "deleted" };
  });
  app.post("/internal/admin/accounts/:userId/role", internal, async (request) => {
    const { userId } = z5.object({ userId: id }).parse(request.params);
    const { role } = z5.object({ role: z5.enum(["user", "moderator", "admin"]) }).parse(request.body);
    await db2.tx(async (tx) => {
      const updated = await tx.run("UPDATE accounts SET role = ? WHERE id = ? AND role <> 'owner'", [role, userId]);
      if (!updated.affectedRows) throw new AppError("not_found", "Account not found.");
      await writeOutbox(tx, { id: ids2.next(), type: "account.role_changed", key: userId, payload: { userId, role } });
    });
    return { ok: true };
  });
  app.post("/internal/admin/accounts/:userId/sign-out", internal, async (request) => {
    const { userId } = z5.object({ userId: id }).parse(request.params);
    const revoked = await db2.tx(async (tx) => {
      const devices = await tx.query("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL FOR UPDATE", [userId]);
      for (const device2 of devices) await revokeDevice(tx, ids2, userId, device2.id, "admin");
      return devices.length;
    });
    return { revoked };
  });
  app.get("/internal/admin/stats", internal, async (request) => {
    const { days } = z5.object({ days: z5.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const start = seriesStart(days);
    const [totals, signups, active, platforms] = await Promise.all([
      db2.query("SELECT status, COUNT(*) AS total FROM accounts GROUP BY status"),
      db2.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM accounts
         WHERE id >= ? AND status <> 'pending_profile' GROUP BY day`,
        [Snowflake.floor(start)]
      ),
      db2.one(
        `SELECT
           COUNT(DISTINCT CASE WHEN last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY THEN account_id END) AS day1,
           COUNT(DISTINCT CASE WHEN last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 7 DAY THEN account_id END) AS day7,
           COUNT(DISTINCT account_id) AS day30
         FROM devices WHERE last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 30 DAY`
      ),
      db2.query("SELECT platform, COUNT(*) AS total FROM devices WHERE revoked_at IS NULL GROUP BY platform")
    ]);
    const byStatus = Object.fromEntries(totals.map((row) => [row.status, Number(row.total)]));
    return {
      accounts: {
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        pending: byStatus.pending_profile ?? 0,
        deleted: byStatus.deleted ?? 0
      },
      activeUsers: { day: Number(active?.day1 ?? 0), week: Number(active?.day7 ?? 0), month: Number(active?.day30 ?? 0) },
      devices: Object.fromEntries(platforms.map((row) => [row.platform, Number(row.total)])),
      signups: dailySeries(signups, days)
    };
  });
}

// services/auth/src/main.ts
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "auth", env, ready: () => db.ping(), rateLimitPerMinute: 120 });
var ids = new Snowflake(env.WORKER_ID);
await enforceDeviceLimit(db, ids);
await service.app.register(cookie);
var guards = installAuth(
  service.app,
  await createVerifier(env, void 0, (auth) => sessionIsActive(db, auth)),
  env,
  /* @__PURE__ */ new Set(["/auth/refresh", "/auth/otp/request", "/auth/otp/verify", "/auth/signup"])
);
registerRoutes(service.app, db, ids, guards);
registerAdminRoutes(service.app, db, ids, guards);
var bus = createBus(env, service.log, "auth");
var relay = startOutboxRelay(db, bus, service.log);
service.onShutdown(async () => {
  relay.stop();
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
