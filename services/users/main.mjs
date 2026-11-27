import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/users/src/main.ts
import { z as z4 } from "zod";

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

// packages/core/src/series.ts
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

// services/users/src/routes.ts
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

// services/users/src/routes.ts
var PROFILE_COLUMNS = "user_id, username, display_name, about, avatar_media_id, locale, last_seen_at, created_at";
var DEFAULT_AUDIENCE = {
  last_seen: "everyone",
  online: "everyone",
  profile_photo: "everyone",
  about: "everyone",
  status: "contacts",
  groups_add: "everyone"
};
function registerRoutes(app, db2, ids2, guards2, mediaUrl, ownsAvatar) {
  const avatarUrl = (mediaId) => mediaId ? `${mediaUrl}/avatars/${mediaId}` : null;
  const ownView = (row) => ({
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    about: row.about,
    avatarUrl: avatarUrl(row.avatar_media_id),
    locale: row.locale,
    createdAt: row.created_at.toISOString()
  });
  const privacyOf = async (userId) => {
    const rows = await db2.query(
      "SELECT setting_key, audience FROM privacy_settings WHERE user_id = ?",
      [userId]
    );
    return { ...DEFAULT_AUDIENCE, ...Object.fromEntries(rows.map((row) => [row.setting_key, row.audience])) };
  };
  const publicView = async (viewerId, row) => {
    if (viewerId === row.user_id) return { ...ownView(row), lastSeenAt: row.last_seen_at?.toISOString() ?? null, isContact: false, blockedByMe: false };
    const [privacy, relation] = await Promise.all([
      privacyOf(row.user_id),
      db2.one(
        `SELECT
           EXISTS(SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?) AS in_their_contacts,
           EXISTS(SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?) AS in_my_contacts,
           EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_by_me,
           EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_me,
           (SELECT nickname FROM contacts WHERE owner_id = ? AND contact_id = ?) AS nickname`,
        [row.user_id, viewerId, viewerId, row.user_id, viewerId, row.user_id, row.user_id, viewerId, viewerId, row.user_id]
      )
    ]);
    const blockedMe = Number(relation?.blocked_me) === 1;
    const allowed = (key) => !blockedMe && (privacy[key] === "everyone" || privacy[key] === "contacts" && Number(relation?.in_their_contacts) === 1);
    return {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      nickname: relation?.nickname ?? null,
      about: allowed("about") ? row.about : "",
      avatarUrl: allowed("profile_photo") ? avatarUrl(row.avatar_media_id) : null,
      lastSeenAt: allowed("last_seen") ? row.last_seen_at?.toISOString() ?? null : null,
      showsOnline: allowed("online"),
      createdAt: row.created_at.toISOString(),
      isContact: Number(relation?.in_my_contacts) === 1,
      blockedByMe: Number(relation?.blocked_by_me) === 1
    };
  };
  const activeProfile = async (userId, executor = db2) => {
    const row = await executor.one(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ? AND deleted_at IS NULL`, [userId]);
    if (!row) fail("not_found", "This person is not on Talkie.");
    return row;
  };
  const usernameState = async (username2, selfId) => {
    if (await db2.one("SELECT 1 FROM reserved_usernames WHERE username = ?", [username2])) return "reserved";
    const owner = await db2.one("SELECT user_id FROM profiles WHERE username = ?", [username2]);
    if (owner && owner.user_id !== selfId) return "taken";
    return "available";
  };
  app.get("/users/username-available", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const parsed = usernameCheck.safeParse(request.query);
    if (!parsed.success) return { available: false, reason: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid username" };
    const state = await usernameState(parsed.data.username, request.auth?.userId);
    return { available: state === "available", reason: state === "available" ? null : state };
  });
  app.get("/users/me", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const row = await activeProfile(auth.userId);
    const settings = await db2.one("SELECT read_receipts FROM user_settings WHERE user_id = ?", [auth.userId]);
    return { profile: ownView(row), privacy: await privacyOf(auth.userId), readReceipts: settings ? Number(settings.read_receipts) === 1 : true };
  });
  app.patch("/users/me", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const input = profileUpdate.parse(request.body);
    const username2 = z3.object({ username: username.optional() }).parse(request.body).username;
    const profile = await db2.tx(async (tx) => {
      const row = await activeProfile(auth.userId, tx);
      if (username2 && username2 !== row.username) {
        if (await tx.one("SELECT 1 FROM reserved_usernames WHERE username = ?", [username2])) fail("username_reserved", "This username is not available.");
      }
      try {
        await tx.run(
          `UPDATE profiles SET display_name = COALESCE(?, display_name), about = COALESCE(?, about),
             locale = COALESCE(?, locale), username = COALESCE(?, username) WHERE user_id = ?`,
          [input.displayName ?? null, input.about ?? null, input.locale ?? null, username2 ?? null, auth.userId]
        );
      } catch (error) {
        if (isDuplicate(error)) fail("username_taken", "This username is already taken.");
        throw error;
      }
      const next = await activeProfile(auth.userId, tx);
      await writeOutbox(tx, {
        id: ids2.next(),
        type: "profile.updated",
        key: auth.userId,
        payload: { userId: auth.userId, username: next.username, displayName: next.display_name, avatarMediaId: next.avatar_media_id }
      });
      return next;
    });
    return { profile: ownView(profile) };
  });
  app.put("/users/me/avatar", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { mediaId } = z3.object({ mediaId: id.nullable() }).parse(request.body);
    if (mediaId && !await ownsAvatar(auth.userId, mediaId)) fail("bad_request", "Upload the photo first.");
    await db2.tx(async (tx) => {
      await tx.run("UPDATE profiles SET avatar_media_id = ? WHERE user_id = ? AND deleted_at IS NULL", [mediaId, auth.userId]);
      await writeOutbox(tx, { id: ids2.next(), type: "profile.updated", key: auth.userId, payload: { userId: auth.userId, avatarMediaId: mediaId } });
    });
    return { avatarUrl: avatarUrl(mediaId) };
  });
  app.put("/users/me/privacy", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const input = privacyUpdate.parse(request.body);
    await db2.tx(async (tx) => {
      for (const setting of input.settings ?? [])
        await tx.run(
          "INSERT INTO privacy_settings (user_id, setting_key, audience) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE audience = VALUES(audience)",
          [auth.userId, setting.key, setting.audience]
        );
      if (input.readReceipts !== void 0)
        await tx.run("INSERT INTO user_settings (user_id, read_receipts) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_receipts = VALUES(read_receipts)", [
          auth.userId,
          input.readReceipts ? 1 : 0
        ]);
      const settings = await tx.one("SELECT read_receipts FROM user_settings WHERE user_id = ?", [auth.userId]);
      await writeOutbox(tx, {
        id: ids2.next(),
        type: "privacy.updated",
        key: auth.userId,
        payload: { userId: auth.userId, readReceipts: settings ? Number(settings.read_receipts) === 1 : true }
      });
    });
    return { privacy: await privacyOf(auth.userId) };
  });
  app.get("/users/by-username/:username", { preHandler: guards2.requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { username: username2 } = z3.object({ username }).parse(request.params);
    const row = await db2.one(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? AND deleted_at IS NULL`, [username2]);
    if (!row) fail("not_found", "No one on Talkie has this username.");
    return { user: await publicView(caller(request).userId, row) };
  });
  app.get("/users/:userId", { preHandler: guards2.requireAuth }, async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    return { user: await publicView(caller(request).userId, await activeProfile(userId)) };
  });
  app.post("/users/lookup", { preHandler: guards2.requireAuth }, async (request) => {
    const { ids: userIds } = z3.object({ ids: z3.array(id).min(1).max(200) }).parse(request.body);
    const rows = await db2.query(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id IN (${userIds.map(() => "?").join(",")}) AND deleted_at IS NULL`,
      userIds
    );
    const viewer = caller(request).userId;
    return { users: await Promise.all(rows.map((row) => publicView(viewer, row))) };
  });
  app.get("/users/me/contacts", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const rows = await db2.query(
      `SELECT ${PROFILE_COLUMNS.split(", ").map((c) => "p." + c).join(", ")}, c.nickname
       FROM contacts c JOIN profiles p ON p.user_id = c.contact_id AND p.deleted_at IS NULL
       WHERE c.owner_id = ? ORDER BY COALESCE(c.nickname, p.display_name)`,
      [auth.userId]
    );
    return { contacts: await Promise.all(rows.map((row) => publicView(auth.userId, row))) };
  });
  app.put("/users/me/contacts/:userId", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { nickname } = z3.object({ nickname: displayName.nullable().default(null) }).parse(request.body ?? {});
    if (userId === auth.userId) fail("bad_request", "You cannot add yourself.");
    await activeProfile(userId);
    await db2.run("INSERT INTO contacts (owner_id, contact_id, nickname) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)", [
      auth.userId,
      userId,
      nickname
    ]);
    return { ok: true };
  });
  app.delete("/users/me/contacts/:userId", { preHandler: guards2.requireAuth }, async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    await db2.run("DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?", [caller(request).userId, userId]);
    return { ok: true };
  });
  app.get("/users/me/blocks", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const rows = await db2.query(
      `SELECT ${PROFILE_COLUMNS.split(", ").map((c) => "p." + c).join(", ")} FROM blocks b
       JOIN profiles p ON p.user_id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
      [auth.userId]
    );
    return { blocked: rows.map((row) => ({ id: row.user_id, username: row.username, displayName: row.display_name, avatarUrl: avatarUrl(row.avatar_media_id) })) };
  });
  app.put("/users/me/blocks/:userId", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z3.object({ userId: id }).parse(request.params);
    if (userId === auth.userId) fail("bad_request", "You cannot block yourself.");
    await activeProfile(userId);
    await db2.tx(async (tx) => {
      await tx.run("INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", [auth.userId, userId]);
      await writeOutbox(tx, { id: ids2.next(), type: "user.blocked", key: auth.userId, payload: { blockerId: auth.userId, blockedId: userId } });
    });
    return { ok: true };
  });
  app.delete("/users/me/blocks/:userId", { preHandler: guards2.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z3.object({ userId: id }).parse(request.params);
    await db2.tx(async (tx) => {
      const removed = await tx.run("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", [auth.userId, userId]);
      if (removed.affectedRows)
        await writeOutbox(tx, { id: ids2.next(), type: "user.unblocked", key: auth.userId, payload: { blockerId: auth.userId, blockedId: userId } });
    });
    return { ok: true };
  });
  app.post("/users/:userId/report", { preHandler: guards2.requireAuth, config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request) => {
    const auth = caller(request);
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const input = userReport.extend({ block: z3.boolean().default(false) }).parse(request.body);
    await activeProfile(userId);
    await db2.tx(async (tx) => {
      if (input.block) await tx.run("INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", [auth.userId, userId]);
      await writeOutbox(tx, {
        id: ids2.next(),
        type: "report.created",
        key: userId,
        payload: { reportId: ids2.next(), reporterId: auth.userId, targetType: "user", targetId: userId, reason: input.reason, note: input.note }
      });
    });
    return { ok: true };
  });
  app.post("/internal/profiles", { preHandler: guards2.requireInternal }, async (request, reply) => {
    const input = z3.object({ userId: id, username, displayName, locale }).parse(request.body);
    const existing = await db2.one(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, [input.userId]);
    if (existing) {
      if (existing.username !== input.username) {
        const state2 = await usernameState(input.username, input.userId);
        if (state2 !== "available") fail(state2 === "reserved" ? "username_reserved" : "username_taken", "This username is not available.");
        await db2.run("UPDATE profiles SET username = ?, display_name = ? WHERE user_id = ?", [input.username, input.displayName, input.userId]);
      }
      return { profile: ownView(await activeProfile(input.userId)) };
    }
    const state = await usernameState(input.username);
    if (state === "reserved") fail("username_reserved", "This username is not available.");
    try {
      await db2.tx(async (tx) => {
        await tx.run("INSERT INTO profiles (user_id, username, display_name, locale) VALUES (?, ?, ?, ?)", [
          input.userId,
          input.username,
          input.displayName,
          input.locale
        ]);
        await tx.run("INSERT INTO user_settings (user_id) VALUES (?)", [input.userId]);
      });
    } catch (error) {
      if (isDuplicate(error)) fail("username_taken", "This username is already taken.");
      throw error;
    }
    reply.status(201);
    return { profile: ownView(await activeProfile(input.userId)) };
  });
  app.get("/internal/profiles/:userId", { preHandler: guards2.requireInternal }, async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    return { profile: ownView(await activeProfile(userId)) };
  });
  app.post("/internal/presence-visibility", { preHandler: guards2.requireInternal }, async (request) => {
    const { viewerId, userIds } = z3.object({ viewerId: id, userIds: z3.array(id).min(1).max(500) }).parse(request.body);
    const marks = userIds.map(() => "?").join(",");
    const [settings, contactsOf, blocks] = await Promise.all([
      db2.query(
        `SELECT user_id, audience FROM privacy_settings WHERE setting_key = 'online' AND user_id IN (${marks})`,
        userIds
      ),
      db2.query(`SELECT owner_id FROM contacts WHERE contact_id = ? AND owner_id IN (${marks})`, [viewerId, ...userIds]),
      db2.query(
        `SELECT blocked_id AS other FROM blocks WHERE blocker_id = ? AND blocked_id IN (${marks})
         UNION SELECT blocker_id AS other FROM blocks WHERE blocked_id = ? AND blocker_id IN (${marks})`,
        [viewerId, ...userIds, viewerId, ...userIds]
      )
    ]);
    const audience = new Map(settings.map((row) => [row.user_id, row.audience]));
    const knows = new Set(contactsOf.map((row) => row.owner_id));
    const blocked = new Set(blocks.map((row) => row.other));
    return {
      visible: userIds.filter((id2) => {
        if (blocked.has(id2)) return false;
        const level = audience.get(id2) ?? "everyone";
        return level === "everyone" || level === "contacts" && knows.has(id2);
      })
    };
  });
  app.post("/internal/relationships", { preHandler: guards2.requireInternal }, async (request) => {
    const { userId, otherIds } = z3.object({ userId: id, otherIds: z3.array(id).min(1).max(1024) }).parse(request.body);
    const marks = otherIds.map(() => "?").join(",");
    const [blocks, groupPrivacy, theirContacts] = await Promise.all([
      db2.query(
        `SELECT blocker_id, blocked_id FROM blocks WHERE (blocker_id = ? AND blocked_id IN (${marks})) OR (blocked_id = ? AND blocker_id IN (${marks}))`,
        [userId, ...otherIds, userId, ...otherIds]
      ),
      db2.query(
        `SELECT user_id, audience FROM privacy_settings WHERE setting_key = 'groups_add' AND user_id IN (${marks})`,
        otherIds
      ),
      db2.query(`SELECT owner_id FROM contacts WHERE contact_id = ? AND owner_id IN (${marks})`, [userId, ...otherIds])
    ]);
    const audience = new Map(groupPrivacy.map((row) => [row.user_id, row.audience]));
    const knowsMe = new Set(theirContacts.map((row) => row.owner_id));
    return {
      relationships: otherIds.map((otherId) => {
        const level = audience.get(otherId) ?? "everyone";
        return {
          userId: otherId,
          blocked: blocks.some((b) => b.blocker_id === userId && b.blocked_id === otherId || b.blocker_id === otherId && b.blocked_id === userId),
          canAddToGroup: level === "everyone" || level === "contacts" && knowsMe.has(otherId)
        };
      })
    };
  });
  app.post("/internal/admin/profiles", { preHandler: guards2.requireInternal }, async (request) => {
    const { ids: ids3 } = z3.object({ ids: z3.array(id).max(500) }).parse(request.body);
    if (!ids3.length) return { profiles: [] };
    const rows = await db2.query(
      `SELECT ${PROFILE_COLUMNS}, deleted_at FROM profiles WHERE user_id IN (${ids3.map(() => "?").join(",")})`,
      ids3
    );
    return {
      profiles: rows.map((row) => ({
        ...ownView(row),
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        deletedAt: row.deleted_at?.toISOString() ?? null
      }))
    };
  });
  app.get("/internal/admin/profiles/search", { preHandler: guards2.requireInternal }, async (request) => {
    const { q } = z3.object({ q: z3.string().trim().min(1).max(64) }).parse(request.query);
    const term = likeEscape(q.replace(/^@/, "").toLowerCase());
    const rows = await db2.query(
      "SELECT user_id FROM profiles WHERE username LIKE ? OR display_name LIKE ? ORDER BY user_id DESC LIMIT 100",
      [`${term}%`, `%${term}%`]
    );
    return { ids: rows.map((row) => row.user_id) };
  });
}

// services/users/src/main.ts
var env = loadConfig({
  PORT: z4.coerce.number().int().positive().default(4102),
  DB_NAME: z4.string().default("talkie_users"),
  /** Public base URL for avatar downloads (media service). */
  MEDIA_PUBLIC_URL: z4.string().default("/api/media"),
  MEDIA_URL: z4.url().default("http://127.0.0.1:4105")
});
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "users", env, ready: () => db.ping() });
var ids = new Snowflake(env.WORKER_ID);
var guards = installAuth(service.app, await createVerifier(env), env);
registerRoutes(service.app, db, ids, guards, env.MEDIA_PUBLIC_URL, async (ownerId, mediaId) => {
  const response = await fetch(`${env.MEDIA_URL}/internal/media/verify`, {
    method: "POST",
    headers: { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ ownerId, mediaIds: [mediaId], purposes: ["avatar"] }),
    signal: AbortSignal.timeout(5e3)
  });
  return response.ok && (await response.json()).valid.includes(mediaId);
});
var bus = createBus(env, service.log, "users");
var relay = startOutboxRelay(db, bus, service.log);
bus.subscribe("users", ["presence.offline"], async (event) => {
  const { userId, at } = event.payload;
  await db.run("UPDATE profiles SET last_seen_at = ? WHERE user_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)", [
    new Date(at),
    userId,
    new Date(at)
  ]);
});
service.onShutdown(async () => {
  relay.stop();
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
