import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/notify/src/main.ts
import nodemailer from "nodemailer";
import { z as z3 } from "zod";

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
  DB_POOL_SHARED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
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

// packages/db/src/index.ts
import mysql2 from "mysql2/promise";

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
var poolRegistryKey = /* @__PURE__ */ Symbol.for("talkie.database.pools");
var processGlobals = globalThis;
var pools = processGlobals[poolRegistryKey] ??= /* @__PURE__ */ new Map();
function createPool(env2, name) {
  const pool = mysql2.createPool({
    host: env2.DB_HOST,
    port: env2.DB_PORT,
    user: env2.DB_USER,
    password: env2.DB_PASSWORD,
    database: name,
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
  return pool;
}
function connectDatabase(env2, database) {
  const rewrite = tableRewriter(sharedTableNames(env2, database));
  const name = databaseName(env2, database);
  const key = env2.DB_POOL_SHARED && env2.DB_SHARED_NAME && name === env2.DB_SHARED_NAME ? JSON.stringify([env2.DB_HOST, env2.DB_PORT, env2.DB_USER, env2.DB_PASSWORD, name, env2.DB_SSL, env2.DB_POOL_SIZE]) : void 0;
  const shared = key === void 0 ? void 0 : pools.get(key);
  const entry = shared ?? { pool: createPool(env2, name), references: 0 };
  if (key !== void 0 && !shared) pools.set(key, entry);
  entry.references++;
  const { pool } = entry;
  let closed = false;
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
      if (closed) return;
      closed = true;
      if (--entry.references > 0) return;
      if (key !== void 0) pools.delete(key);
      await pool.end();
    }
  };
}

// packages/bus/src/index.ts
import { Redis as Redis2 } from "ioredis";
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
  return mysqlBus(connectDatabase(env2.DB_POOL_SHARED ? env2 : { ...env2, DB_POOL_SIZE: 2 }, "talkie_bus"), log);
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

// services/notify/src/email.ts
var escape = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
var copy = {
  en: {
    subject: (code) => `${code} is your Talkie code`,
    heading: "Your sign-in code",
    body: "Enter this code in Talkie to continue. It expires in 10 minutes.",
    ignore: "If you didn't ask for this code, you can ignore this email. Someone may have typed your address by mistake.",
    never: "Talkie will never ask you to share this code."
  },
  bn: {
    subject: (code) => `${code} \u0986\u09AA\u09A8\u09BE\u09B0 Talkie \u0995\u09CB\u09A1`,
    heading: "\u0986\u09AA\u09A8\u09BE\u09B0 \u09B8\u09BE\u0987\u09A8-\u0987\u09A8 \u0995\u09CB\u09A1",
    body: "\u098F\u0997\u09BF\u09AF\u09BC\u09C7 \u09AF\u09C7\u09A4\u09C7 Talkie-\u09A4\u09C7 \u098F\u0987 \u0995\u09CB\u09A1\u099F\u09BF \u09B2\u09BF\u0996\u09C1\u09A8\u0964 \u0995\u09CB\u09A1\u099F\u09BF \u09E7\u09E6 \u09AE\u09BF\u09A8\u09BF\u099F\u09C7\u09B0 \u09AE\u09A7\u09CD\u09AF\u09C7 \u09AE\u09C7\u09AF\u09BC\u09BE\u09A6\u09CB\u09A4\u09CD\u09A4\u09C0\u09B0\u09CD\u09A3 \u09B9\u09AC\u09C7\u0964",
    ignore: "\u0986\u09AA\u09A8\u09BF \u098F\u0987 \u0995\u09CB\u09A1 \u09A8\u09BE \u099A\u09BE\u0987\u09B2\u09C7 \u0987\u09AE\u09C7\u0987\u09B2\u099F\u09BF \u0989\u09AA\u09C7\u0995\u09CD\u09B7\u09BE \u0995\u09B0\u09C1\u09A8\u0964 \u09B9\u09AF\u09BC\u09A4\u09CB \u0995\u09C7\u0989 \u09AD\u09C1\u09B2 \u0995\u09B0\u09C7 \u0986\u09AA\u09A8\u09BE\u09B0 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE \u09B2\u09BF\u0996\u09C7\u099B\u09C7\u09A8\u0964",
    never: "Talkie \u0995\u0996\u09A8\u09CB \u0986\u09AA\u09A8\u09BE\u0995\u09C7 \u098F\u0987 \u0995\u09CB\u09A1 \u0995\u09BE\u0989\u0995\u09C7 \u099C\u09BE\u09A8\u09BE\u09A4\u09C7 \u09AC\u09B2\u09AC\u09C7 \u09A8\u09BE\u0964"
  }
};
function otpEmail(code, locale2) {
  const t = copy[locale2];
  const digits = escape(code);
  const html = `<!doctype html>
<html lang="${locale2}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escape(t.subject(code))}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,'Hind Siliguri',Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.08)">
<tr><td style="background:linear-gradient(135deg,#5b5bf7,#8b5cf6 55%,#ec4899);padding:28px 32px">
<div style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ffffff">Talkie</div></td></tr>
<tr><td style="padding:32px">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3">${t.heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569">${t.body}</p>
<div style="text-align:center;padding:18px 12px;border-radius:14px;background:#eef2ff;color:#3730a3"><code style="font-size:34px;font-weight:800;letter-spacing:.18em;font-family:'SF Mono',Consolas,monospace;-webkit-user-select:all;user-select:all">${digits}</code></div>
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b">${t.ignore}</p>
<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#64748b"><strong>${t.never}</strong></p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#94a3b8">talkie.kodofact.com</p>
</td></tr></table></body></html>`;
  const text = `${t.heading}

${code}

${t.body}

${t.ignore}
${t.never}`;
  return { subject: t.subject(code), html, text };
}

// services/notify/src/fcm.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { importPKCS8, SignJWT } from "jose";
function loadServiceAccount(env2) {
  let raw = env2.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw && env2.FIREBASE_SERVICE_ACCOUNT_FILE) raw = readFileSync3(configPath(env2.FIREBASE_SERVICE_ACCOUNT_FILE), "utf8");
  if (!raw) return null;
  if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
  const account2 = JSON.parse(raw);
  if (!account2.project_id || !account2.client_email || !account2.private_key) throw new Error("The Firebase service account JSON is incomplete");
  return account2;
}
function createFcm(account2, log) {
  const tokenUri = account2.token_uri ?? "https://oauth2.googleapis.com/token";
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account2.project_id}/messages:send`;
  let cached = null;
  let pending = null;
  const accessToken = async () => {
    if (cached && cached.expiresAt - 6e4 > Date.now()) return cached.token;
    pending ??= (async () => {
      try {
        const key = await importPKCS8(account2.private_key, "RS256");
        const now = Math.floor(Date.now() / 1e3);
        const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" }).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(account2.client_email).setAudience(tokenUri).setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
        const response = await fetch(tokenUri, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
          signal: AbortSignal.timeout(1e4)
        });
        if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
        const body = await response.json();
        cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1e3 };
        return body.access_token;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return {
    projectId: account2.project_id,
    /** Install check: does Google accept the service-account key? */
    async check() {
      try {
        await accessToken();
        return "ok";
      } catch (error) {
        return `rejected: ${String(error?.message ?? error).slice(0, 120)}`;
      }
    },
    async send(deviceToken, message, inlineReply = false) {
      const payload = {
        message: {
          token: deviceToken,
          ...!inlineReply ? { notification: { title: message.title, body: message.body } } : {},
          data: { ...message.data, title: message.title, body: message.body, ...message.link ? { link: message.link } : {} },
          android: {
            priority: "HIGH",
            ttl: `${message.ttlSeconds ?? 86400}s`,
            ...message.tag ? { collapse_key: message.tag } : {},
            ...!inlineReply ? { notification: {
              channel_id: message.channel,
              ...message.tag ? { tag: message.tag } : {},
              default_sound: true
            } } : {}
          },
          webpush: {
            headers: { Urgency: message.urgent ? "high" : "normal", TTL: String(message.ttlSeconds ?? 86400) },
            notification: { icon: "/icon.svg", ...message.tag ? { tag: message.tag, renotify: true } : {}, ...message.urgent ? { requireInteraction: true } : {} },
            ...message.link ? { fcm_options: { link: message.link } } : {}
          }
        }
      };
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(1e4)
        });
        if (response.ok) return "sent";
        const error = await response.json().catch(() => ({}));
        const code = error.error?.details?.find((d) => d.errorCode)?.errorCode ?? error.error?.status;
        if (code === "UNREGISTERED" || response.status === 404) return "invalid_token";
        if (response.status === 401) cached = null;
        log.warn({ status: response.status, code }, "push not delivered");
        return "failed";
      } catch (error) {
        log.warn({ err: error }, "push not delivered");
        return "failed";
      }
    }
  };
}

// services/notify/src/push.ts
var words = {
  en: {
    text: "New message",
    image: "\u{1F4F7} Photo",
    video: "\u{1F3A5} Video",
    voice: "\u{1F3A4} Voice message",
    audio: "\u{1F3B5} Audio",
    document: "\u{1F4C4} Document",
    poll: "\u{1F4CA} Poll",
    sticker: "Sticker",
    location: "\u{1F4CD} Location",
    contact: "\u{1F464} Contact",
    hidden: "New message",
    videoCall: "Incoming video call",
    voiceCall: "Incoming voice call",
    groupCall: "Group call"
  },
  bn: {
    text: "\u09A8\u09A4\u09C1\u09A8 \u09AE\u09C7\u09B8\u09C7\u099C",
    image: "\u{1F4F7} \u099B\u09AC\u09BF",
    video: "\u{1F3A5} \u09AD\u09BF\u09A1\u09BF\u0993",
    voice: "\u{1F3A4} \u09AD\u09AF\u09BC\u09C7\u09B8 \u09AE\u09C7\u09B8\u09C7\u099C",
    audio: "\u{1F3B5} \u0985\u09A1\u09BF\u0993",
    document: "\u{1F4C4} \u09A1\u0995\u09C1\u09AE\u09C7\u09A8\u09CD\u099F",
    poll: "\u{1F4CA} \u09AA\u09CB\u09B2",
    sticker: "\u09B8\u09CD\u099F\u09BF\u0995\u09BE\u09B0",
    location: "\u{1F4CD} \u09B2\u09CB\u0995\u09C7\u09B6\u09A8",
    contact: "\u{1F464} \u0995\u09A8\u09CD\u099F\u09BE\u0995\u09CD\u099F",
    hidden: "\u09A8\u09A4\u09C1\u09A8 \u09AE\u09C7\u09B8\u09C7\u099C",
    videoCall: "\u09AD\u09BF\u09A1\u09BF\u0993 \u0995\u09B2 \u0986\u09B8\u099B\u09C7",
    voiceCall: "\u09AD\u09AF\u09BC\u09C7\u09B8 \u0995\u09B2 \u0986\u09B8\u099B\u09C7",
    groupCall: "\u0997\u09CD\u09B0\u09C1\u09AA \u0995\u09B2"
  }
};
function pushHandlers({ origin, db: db2, fcm: fcm2, log, profiles, avatar }) {
  const placeholders = (list) => list.map(() => "?").join(",");
  const preferences = async (userIds) => {
    const rows = await db2.query(`SELECT * FROM notification_preferences WHERE user_id IN (${placeholders(userIds)})`, userIds);
    const byUser = new Map(rows.map((row) => [row.user_id, row]));
    return (id2) => byUser.get(id2) ?? { user_id: id2, messages: 1, groups_enabled: 1, calls: 1, show_preview: 1 };
  };
  const deliver = async (userIds, build) => {
    if (!userIds.length) return;
    const tokens = await db2.query(
      `SELECT device_id, user_id, token, inline_reply, phone_ringtone FROM push_tokens WHERE provider = 'fcm' AND user_id IN (${placeholders(userIds)})`,
      userIds
    );
    await Promise.all(
      tokens.map(async (row) => {
        const message = build(row.user_id);
        if (!message) return;
        if (message.channel === "calls" && row.phone_ringtone) message.channel = "incoming_calls";
        message.data = { ...message.data, deviceId: row.device_id, userId: row.user_id };
        const result = await fcm2.send(row.token, message, !!row.inline_reply && message.channel === "messages");
        if (result === "invalid_token") await db2.run("DELETE FROM push_tokens WHERE device_id = ? AND token = ?", [row.device_id, row.token]);
      })
    );
  };
  return {
    async messageSent(event) {
      const p = event.payload;
      if (p.kind === "system" || p.kind === "call") return;
      const muted = new Set(p.mutedBy ?? []);
      const targets = p.recipients.filter((id2) => id2 !== p.senderId && !muted.has(id2));
      if (!targets.length) return;
      const [people, prefer, photo] = await Promise.all([
        profiles([p.senderId, ...targets]),
        preferences(targets),
        avatar(p.senderId, targets).catch(() => null)
      ]);
      const photoRecipients = new Set(photo?.recipients);
      const byId = new Map(people.map((person) => [person.id, person]));
      const sender = byId.get(p.senderId)?.displayName ?? "Talkie";
      const group = p.groupName ?? null;
      await deliver(targets, (userId) => {
        const pref = prefer(userId);
        if (group ? !pref.groups_enabled : !pref.messages) return null;
        const w = words[byId.get(userId)?.locale ?? "bn"];
        const what = w[p.kind] ?? w.text;
        const preview = !!pref.show_preview;
        return {
          title: preview ? group ?? sender : "Talkie",
          body: preview ? group ? `${sender}: ${what}` : what : w.hidden,
          data: {
            type: "message",
            conversationId: p.conversationId,
            messageId: p.messageId,
            locale: byId.get(userId)?.locale ?? "bn",
            ...preview && photo?.avatarUrl && photoRecipients.has(userId) ? { avatarUrl: photo.avatarUrl, senderName: sender } : {}
          },
          channel: "messages",
          tag: p.conversationId,
          link: `${origin}/app?c=${p.conversationId}`
        };
      });
    },
    async callRinging(event) {
      const p = event.payload;
      const targets = p.recipients.filter((id2) => id2 !== p.initiatorId);
      if (!targets.length) return;
      const [people, prefer] = await Promise.all([profiles([p.initiatorId, ...targets]), preferences(targets)]);
      const byId = new Map(people.map((person) => [person.id, person]));
      const caller2 = byId.get(p.initiatorId)?.displayName ?? "Talkie";
      await deliver(targets, (userId) => {
        if (!prefer(userId).calls) return null;
        const w = words[byId.get(userId)?.locale ?? "bn"];
        return {
          title: caller2,
          body: `${p.media === "video" ? w.videoCall : w.voiceCall}${p.group ? ` \xB7 ${w.groupCall}` : ""}`,
          data: { type: "call", callId: p.callId, conversationId: p.conversationId, media: p.media },
          channel: "calls",
          tag: p.callId,
          // same tag as the web app's own call notification, so the browser shows one
          urgent: true,
          link: `${origin}/app`,
          // A ring is useless a minute later.
          ttlSeconds: 45
        };
      });
    },
    async deviceRevoked(event) {
      const { deviceId } = event.payload;
      await db2.run("DELETE FROM push_tokens WHERE device_id = ?", [deviceId]);
      log.debug({ deviceId }, "push token removed for signed-out device");
    }
  };
}

// services/notify/src/main.ts
var env = loadConfig({
  PORT: z3.coerce.number().int().positive().default(4107),
  DB_NAME: z3.string().default("talkie_notify"),
  SMTP_HOST: z3.string().optional(),
  SMTP_PORT: z3.coerce.number().int().positive().default(587),
  SMTP_SECURE: z3.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SMTP_USER: z3.string().optional(),
  SMTP_PASSWORD: z3.string().optional(),
  MAIL_FROM: z3.string().default("Talkie <no-reply@talkie.kodofact.com>"),
  USERS_URL: z3.url().default("http://127.0.0.1:4102"),
  /** Push notifications: a Firebase service account JSON (the JSON itself or base64 of it), or a path to the file. */
  FIREBASE_SERVICE_ACCOUNT: z3.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_FILE: z3.string().optional()
});
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "notify", env, ready: () => db.ping() });
var ids = new Snowflake(env.WORKER_ID);
var guards = installAuth(service.app, await createVerifier(env), env);
var mailer = env.SMTP_HOST ? nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : void 0,
  pool: true,
  maxConnections: 5,
  connectionTimeout: 5e3,
  greetingTimeout: 5e3,
  socketTimeout: 14e3
}) : null;
service.app.post("/internal/email/otp", { preHandler: guards.requireInternal }, async (request) => {
  const input = z3.object({ to: email, code: otpCode, locale }).parse(request.body);
  if (!mailer) throw new AppError("unavailable", "Email delivery is not configured.");
  const message = otpEmail(input.code, input.locale);
  const id2 = ids.next();
  const audit = (status, providerId, error) => {
    void db.run(
      "INSERT INTO email_deliveries (id, recipient, template, status, provider_message_id, error) VALUES (?, ?, ?, ?, ?, ?)",
      [id2, input.to, "otp", status, providerId, error]
    ).catch((err) => request.log.warn({ err }, "could not record OTP email delivery"));
  };
  try {
    const sent = await mailer.sendMail({ from: env.MAIL_FROM, to: input.to, subject: message.subject, html: message.html, text: message.text });
    audit("sent", sent.messageId ?? null, null);
    return { ok: true };
  } catch (error) {
    request.log.error({ err: error }, "otp email failed");
    audit("failed", null, String(error.message).slice(0, 500));
    throw new AppError("unavailable", "We could not send the email. Please try again.");
  }
});
service.app.put("/notify/push-token", { preHandler: guards.requireAuth }, async (request) => {
  const auth = caller(request);
  const input = z3.object({ provider: z3.enum(["fcm", "webpush"]), token: z3.string().min(10).max(1024), inlineReply: z3.boolean().default(false), phoneRingtone: z3.boolean().default(false) }).parse(request.body);
  await db.run(
    `INSERT INTO push_tokens (device_id, user_id, provider, token, inline_reply, phone_ringtone) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), token = VALUES(token), user_id = VALUES(user_id),
       inline_reply = VALUES(inline_reply), phone_ringtone = VALUES(phone_ringtone)`,
    [auth.deviceId, auth.userId, input.provider, input.token, input.inlineReply, input.phoneRingtone]
  );
  return { ok: true };
});
var bus = createBus(env, service.log, "notify");
var account = loadServiceAccount(env);
var fcm = account ? createFcm(account, service.log) : null;
if (!fcm) service.log.warn("FIREBASE_SERVICE_ACCOUNT is not set: push notifications are off");
else {
  const push = pushHandlers({
    origin: env.PUBLIC_ORIGIN.replace(/\/$/, ""),
    db,
    fcm,
    log: service.log,
    avatar: async (senderId, recipients) => {
      const response = await fetch(`${env.USERS_URL}/internal/notification-avatar`, {
        method: "POST",
        headers: { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ senderId, recipients }),
        signal: AbortSignal.timeout(1500)
      });
      if (!response.ok) throw new Error(`notification avatar lookup failed (${response.status})`);
      return await response.json();
    },
    profiles: async (userIds) => {
      const response = await fetch(`${env.USERS_URL}/internal/admin/profiles`, {
        method: "POST",
        headers: { "x-internal-token": env.INTERNAL_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ ids: [...new Set(userIds)] }),
        signal: AbortSignal.timeout(5e3)
      });
      if (!response.ok) throw new Error(`profile lookup failed (${response.status})`);
      return (await response.json()).profiles;
    }
  });
  bus.subscribe("notify-push", ["message.sent", "call.ringing", "device.revoked"], async (event) => {
    if (event.type === "message.sent") await push.messageSent(event);
    else if (event.type === "call.ringing") await push.callRinging(event);
    else await push.deviceRevoked(event);
  });
  service.log.info({ project: fcm.projectId }, "push notifications on");
}
service.app.get("/internal/selfcheck", { preHandler: guards.requireInternal }, async () => {
  let email2 = "not configured";
  if (mailer) {
    try {
      await mailer.verify();
      email2 = "ok";
    } catch (error) {
      email2 = `rejected: ${String(error?.message ?? error).slice(0, 120)}`;
    }
  }
  return { email: email2, push: fcm ? await fcm.check() : "not configured" };
});
service.app.delete("/notify/push-token", { preHandler: guards.requireAuth }, async (request) => {
  await db.run("DELETE FROM push_tokens WHERE device_id = ?", [caller(request).deviceId]);
  return { ok: true };
});
service.app.get("/notify/preferences", { preHandler: guards.requireAuth }, async (request) => {
  const row = await db.one(
    "SELECT messages, groups_enabled, calls, show_preview FROM notification_preferences WHERE user_id = ?",
    [caller(request).userId]
  );
  return {
    messages: row ? !!row.messages : true,
    groups: row ? !!row.groups_enabled : true,
    calls: row ? !!row.calls : true,
    showPreview: row ? !!row.show_preview : true
  };
});
service.app.put("/notify/preferences", { preHandler: guards.requireAuth }, async (request) => {
  const input = z3.object({ messages: z3.boolean(), groups: z3.boolean(), calls: z3.boolean(), showPreview: z3.boolean() }).parse(request.body);
  await db.run(
    `INSERT INTO notification_preferences (user_id, messages, groups_enabled, calls, show_preview) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE messages = VALUES(messages), groups_enabled = VALUES(groups_enabled), calls = VALUES(calls), show_preview = VALUES(show_preview)`,
    [caller(request).userId, input.messages, input.groups, input.calls, input.showPreview]
  );
  return { ok: true };
});
service.onShutdown(async () => {
  mailer?.close();
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
