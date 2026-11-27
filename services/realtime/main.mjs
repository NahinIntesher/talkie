import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/realtime/src/main.ts
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis as Redis3 } from "ioredis";
import { z as z2 } from "zod";

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
  const origins2 = /* @__PURE__ */ new Set([env2.PUBLIC_ORIGIN, ...env2.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)]);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || origins2.has(origin)),
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
  static timeOf(id) {
    return new Date(Number((BigInt(id) >> WORKER_BITS + SEQUENCE_BITS) + EPOCH));
  }
};

// packages/bus/src/index.ts
import { Redis as Redis2 } from "ioredis";

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
function mysqlBus(db, log) {
  const timers = [];
  let closed = false;
  return {
    async publish(event) {
      await db.run(
        "INSERT IGNORE INTO events (id, event_type, event_key, payload, occurred_at) VALUES (?, ?, ?, ?, ?)",
        [event.id, event.type, event.key, JSON.stringify(event.payload), new Date(event.occurredAt)]
      );
    },
    subscribe(group, types, handler) {
      const placeholders = types.map(() => "?").join(",");
      const tick = async () => {
        if (closed) return;
        try {
          await db.run("INSERT IGNORE INTO consumer_offsets (consumer_group, last_event_id) VALUES (?, 0)", [group]);
          const offset = await db.one(
            "SELECT last_event_id FROM consumer_offsets WHERE consumer_group = ?",
            [group]
          );
          const rows = await db.query(
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
            await db.run("UPDATE consumer_offsets SET last_event_id = ? WHERE consumer_group = ?", [row.id, group]);
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
      await db.close();
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

// services/realtime/src/main.ts
var env = loadConfig({
  PORT: z2.coerce.number().int().positive().default(4104),
  USERS_URL: z2.url().default("http://127.0.0.1:4102"),
  CHAT_URL: z2.url().default("http://127.0.0.1:4103")
});
var service = await createService({ name: "realtime", env });
var verifier = await createVerifier(env);
var ids = new Snowflake(env.WORKER_ID);
var bus = createBus(env, service.log, "realtime");
var origins = /* @__PURE__ */ new Set([env.PUBLIC_ORIGIN, ...env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)]);
var io = new Server(service.app.server, {
  path: "/ws",
  serveClient: false,
  // WebSocket first. HTTP long-polling only as a fallback for networks or hosts that block WebSockets
  // (it needs every request of a client on one process: fine on cPanel's single process; with several realtime
  // replicas behind nginx, WebSocket is what clients get).
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 2e4,
  pingTimeout: 2e4,
  cors: { origin: (origin, callback) => callback(null, !origin || origins.has(origin)), credentials: true }
});
if (env.REDIS_URL) {
  const pub = new Redis3(env.REDIS_URL);
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  service.onShutdown(async () => {
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });
}
var internal = async (url, body) => {
  const response = await fetch(url, {
    method: body === void 0 ? "GET" : "POST",
    headers: { "x-internal-token": env.INTERNAL_TOKEN, ...body === void 0 ? {} : { "content-type": "application/json" } },
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(5e3)
  });
  if (!response.ok) throw new Error(`internal ${response.status}`);
  return await response.json();
};
var memberCache = /* @__PURE__ */ new Map();
var membersOf = async (conversationId) => {
  const hit = memberCache.get(conversationId);
  if (hit && Date.now() - hit.at < 6e4) return hit.members;
  const { memberIds } = await internal(`${env.CHAT_URL}/internal/conversations/${conversationId}/members`);
  const members = new Set(memberIds);
  memberCache.set(conversationId, { at: Date.now(), members });
  return members;
};
var userRoom = (id) => `user:${id}`;
var deviceRoom = (id) => `device:${id}`;
var presenceRoom = (id) => `presence:${id}`;
var onlineCount = async (userId) => (await io.in(userRoom(userId)).fetchSockets()).length;
var tokenExpiry = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return (payload.exp ?? 0) * 1e3;
  } catch {
    return 0;
  }
};
io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth.token ?? "");
    const auth = await verifier.verify(token);
    socket.data = { auth, expiresAt: tokenExpiry(token) };
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});
io.on("connection", async (raw) => {
  const socket = raw;
  const { auth } = socket.data;
  const firstDevice = await onlineCount(auth.userId) === 0;
  await socket.join([userRoom(auth.userId), deviceRoom(auth.deviceId)]);
  if (firstDevice) io.to(presenceRoom(auth.userId)).emit("presence", { userId: auth.userId, online: true });
  socket.on("auth", async (token, ack) => {
    try {
      const next = await verifier.verify(String(token));
      if (next.userId !== auth.userId || next.deviceId !== auth.deviceId) throw new Error("identity changed");
      socket.data.expiresAt = tokenExpiry(String(token));
      ack?.(true);
    } catch {
      ack?.(false);
      socket.disconnect(true);
    }
  });
  socket.on("presence:watch", async (userIds, ack) => {
    const parsed = z2.array(z2.string().regex(/^\d{1,20}$/)).max(300).safeParse(userIds);
    if (!parsed.success || !parsed.data.length) return ack?.([]);
    try {
      const { visible } = await internal(`${env.USERS_URL}/internal/presence-visibility`, { viewerId: auth.userId, userIds: parsed.data });
      for (const room of socket.rooms) if (room.startsWith("presence:")) await socket.leave(room);
      await socket.join(visible.map(presenceRoom));
      ack?.(await Promise.all(visible.map(async (userId) => ({ userId, online: await onlineCount(userId) > 0 }))));
    } catch (error) {
      service.log.warn({ err: error }, "presence watch failed");
      ack?.([]);
    }
  });
  let lastTyping = 0;
  socket.on("typing", async (input) => {
    const parsed = z2.object({ conversationId: z2.string().regex(/^\d{1,20}$/), active: z2.boolean(), recording: z2.boolean().optional() }).safeParse(input);
    if (!parsed.success) return;
    const now = Date.now();
    if (parsed.data.active && now - lastTyping < 1500) return;
    lastTyping = parsed.data.active ? now : 0;
    try {
      const members = await membersOf(parsed.data.conversationId);
      if (!members.has(auth.userId)) return;
      for (const member of members)
        if (member !== auth.userId)
          io.to(userRoom(member)).emit("typing", { ...parsed.data, userId: auth.userId });
    } catch (error) {
      service.log.warn({ err: error }, "typing relay failed");
    }
  });
  socket.on("disconnect", async () => {
    if (await onlineCount(auth.userId) > 0) return;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    io.to(presenceRoom(auth.userId)).emit("presence", { userId: auth.userId, online: false, lastSeenAt: at });
    await bus.publish({ id: ids.next(), type: "presence.offline", key: auth.userId, payload: { userId: auth.userId, at }, occurredAt: at }).catch(() => {
    });
  });
});
var expiryCheck = setInterval(async () => {
  for (const socket of await io.fetchSockets()) {
    const data = socket.data;
    if (data.expiresAt && data.expiresAt + 6e4 < Date.now()) socket.disconnect(true);
  }
}, 3e4);
expiryCheck.unref();
var toUsers = (userIds, event, payload) => {
  if (!Array.isArray(userIds)) return;
  for (const id of userIds) io.to(userRoom(String(id))).emit(event, payload);
};
bus.subscribe("realtime", ["message.sent", "message.updated", "conversation.updated", "receipt.updated", "history.synced", "status.updated", "device.revoked", "call.ringing", "call.updated", "call.ended", "meeting.updated", "meeting.admission"], async (event) => {
  const payload = event.payload;
  const { recipients, ...rest } = payload;
  switch (event.type) {
    case "message.sent":
      return toUsers(recipients, "chat:message", rest);
    case "message.updated":
      return toUsers(recipients, "chat:message-updated", rest);
    case "receipt.updated":
      return toUsers(recipients, "chat:receipt", rest);
    case "history.synced":
      io.to(deviceRoom(String(payload.deviceId))).emit("chat:history-synced", { deviceId: payload.deviceId });
      return;
    case "status.updated":
      return toUsers(recipients, "status:update", rest);
    case "call.ringing":
      return toUsers(recipients, "call:incoming", rest);
    case "call.updated":
      return toUsers(recipients, "call:update", rest);
    case "call.ended":
      return toUsers(recipients, "call:ended", rest);
    case "meeting.updated":
      return toUsers(recipients, "meeting:update", rest);
    case "meeting.admission":
      return toUsers(recipients, "meeting:admission", rest);
    case "conversation.updated":
      if (payload.conversationId) memberCache.delete(payload.conversationId);
      return toUsers(recipients, "chat:conversation", rest);
    case "device.revoked": {
      const { userId, deviceId } = payload;
      io.to(userRoom(userId)).emit("session:device-revoked", { deviceId });
      io.in(deviceRoom(deviceId)).disconnectSockets(true);
      return;
    }
  }
});
service.onShutdown(async () => {
  clearInterval(expiryCheck);
  io.close();
  await bus.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
