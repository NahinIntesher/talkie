import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// services/admin/src/main.ts
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

// services/admin/src/clients.ts
var rank = { user: 0, moderator: 1, admin: 2, owner: 3 };
function clients(env2) {
  const call = async (base, path, body) => {
    let response;
    try {
      response = await fetch(base + path, {
        method: body === void 0 ? "GET" : "POST",
        headers: { "x-internal-token": env2.INTERNAL_TOKEN, ...body === void 0 ? {} : { "content-type": "application/json" } },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: AbortSignal.timeout(8e3)
      });
    } catch {
      throw new AppError("unavailable", "A Talkie service is not responding. Try again in a moment.");
    }
    if (response.status === 404) throw new AppError("not_found", "Not found.");
    if (!response.ok) throw new AppError("unavailable", `A Talkie service failed (${response.status}).`);
    return await response.json();
  };
  return {
    auth: {
      access: (userId) => call(env2.AUTH_URL, `/internal/admin/accounts/${userId}/access`),
      accounts: (filter) => call(env2.AUTH_URL, "/internal/admin/accounts", filter).then((r) => r.accounts),
      account: (userId) => call(env2.AUTH_URL, `/internal/admin/accounts/${userId}`),
      setStatus: (userId, status, reason) => call(env2.AUTH_URL, `/internal/accounts/${userId}/status`, { status, reason }),
      setRole: (userId, role) => call(env2.AUTH_URL, `/internal/admin/accounts/${userId}/role`, { role }),
      signOut: (userId) => call(env2.AUTH_URL, `/internal/admin/accounts/${userId}/sign-out`, {}),
      stats: () => call(env2.AUTH_URL, "/internal/admin/stats")
    },
    users: {
      profiles: (ids2) => ids2.length ? call(env2.USERS_URL, "/internal/admin/profiles", { ids: ids2 }).then((r) => r.profiles) : Promise.resolve([]),
      search: (q) => call(env2.USERS_URL, `/internal/admin/profiles/search?q=${encodeURIComponent(q)}`).then((r) => r.ids)
    },
    chat: {
      stats: () => call(
        env2.CHAT_URL,
        "/internal/admin/stats"
      ),
      user: (userId) => call(
        env2.CHAT_URL,
        `/internal/admin/users/${userId}`
      ),
      group: (id2) => call(
        env2.CHAT_URL,
        `/internal/admin/groups/${id2}`
      ).then((r) => r.group)
    },
    meet: {
      stats: () => call(env2.MEET_URL, "/internal/admin/stats")
    },
    media: {
      stats: () => call(env2.MEDIA_URL, "/internal/admin/stats"),
      user: (userId) => call(env2.MEDIA_URL, `/internal/admin/users/${userId}`)
    }
  };
}

// services/admin/src/routes.ts
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

// services/admin/src/routes.ts
var ACCESS_CACHE_MS = 15e3;
function registerRoutes(app, db2, ids2, guards2, services) {
  const accessCache = /* @__PURE__ */ new Map();
  const currentAccess = async (userId) => {
    const cached = accessCache.get(userId);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) return cached;
    const fresh = { ...await services.auth.access(userId), at: Date.now() };
    accessCache.set(userId, fresh);
    if (accessCache.size > 1e3) accessCache.delete(accessCache.keys().next().value);
    return fresh;
  };
  const staff = (minimum) => ({
    preHandler: async (request) => {
      if (!request.auth) throw new AppError("unauthorized", "Please sign in.");
      const access = await currentAccess(request.auth.userId);
      if (access.status !== "active" || rank[access.role] < rank[minimum]) throw new AppError("forbidden", "You do not have access to this.");
      request.staff = { userId: request.auth.userId, role: access.role };
    }
  });
  const me = (request) => request.staff;
  const assertCanManage = (actor, target) => {
    if (actor.userId === target.id) fail("forbidden", "You cannot do this to your own account.");
    if (rank[target.role] >= rank[actor.role]) fail("forbidden", "This person has the same or a higher role than you.");
  };
  const audit = (tx, request, action, targetType, targetId, details) => tx.run("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    ids2.next(),
    me(request).userId,
    action,
    targetType,
    targetId,
    details ? JSON.stringify(details) : null,
    ipToBuffer(request.ip)
  ]);
  const person = (account, profile, id2) => ({
    id: id2,
    email: account?.email ?? null,
    status: account?.status ?? "deleted",
    role: account?.role ?? "user",
    createdAt: account?.createdAt ?? profile?.createdAt ?? null,
    lastActiveAt: account?.lastActiveAt ?? null,
    devices: account?.devices ?? 0,
    suspendedReason: account?.suspendedReason ?? null,
    username: profile?.username ?? null,
    displayName: profile?.displayName ?? null,
    avatarUrl: profile?.avatarUrl ?? null
  });
  const cards = async (userIds) => {
    const unique = [...new Set(userIds)];
    const profiles = await services.users.profiles(unique).catch(() => []);
    return Object.fromEntries(profiles.map((p) => [p.id, { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl }]));
  };
  app.get("/admin/me", staff("moderator"), async (request) => ({ userId: me(request).userId, role: me(request).role }));
  app.get("/admin/overview", staff("moderator"), async () => {
    const [accounts, chat, meet, media] = await Promise.allSettled([services.auth.stats(), services.chat.stats(), services.meet.stats(), services.media.stats()]);
    const value = (result) => result.status === "fulfilled" ? result.value : null;
    const reports = await db2.query("SELECT status, COUNT(*) AS total FROM reports GROUP BY status");
    const byStatus = Object.fromEntries(reports.map((row) => [row.status, Number(row.total)]));
    return {
      accounts: value(accounts),
      chat: value(chat),
      meet: value(meet),
      media: value(media),
      reports: { open: (byStatus.open ?? 0) + (byStatus.reviewing ?? 0), total: reports.reduce((sum, row) => sum + Number(row.total), 0) }
    };
  });
  app.get("/admin/users", staff("moderator"), async (request) => {
    const query = z3.object({
      q: z3.string().trim().max(254).optional(),
      status: z3.enum(["active", "suspended", "pending_profile", "deleted"]).optional(),
      staff: z3.enum(["true", "false"]).optional(),
      before: id.optional()
    }).parse(request.query);
    const isStaff = query.staff === "true";
    let accounts;
    if (query.q) {
      const q = query.q.toLowerCase();
      const [byProfile, byEmail] = await Promise.all([
        services.users.search(q),
        services.auth.accounts({ email: q.replace(/^@/, ""), status: query.status, staff: isStaff, limit: 50 })
      ]);
      const extra = byProfile.filter((id2) => !byEmail.some((a) => a.id === id2));
      const fromProfiles = extra.length ? await services.auth.accounts({ ids: extra.slice(0, 100), status: query.status, staff: isStaff, limit: 100 }) : [];
      accounts = [...byEmail, ...fromProfiles].sort((a, b) => BigInt(b.id) > BigInt(a.id) ? 1 : -1).slice(0, 100);
    } else {
      accounts = await services.auth.accounts({ status: query.status, staff: isStaff, before: query.before, limit: 50 });
    }
    const profiles = await services.users.profiles(accounts.map((a) => a.id));
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return {
      users: accounts.map((account) => person(account, byId.get(account.id), account.id)),
      next: !query.q && accounts.length === 50 ? accounts.at(-1).id : null
    };
  });
  app.get("/admin/users/:userId", staff("moderator"), async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const [{ account, devices }, profiles, activity, storage] = await Promise.all([
      services.auth.account(userId),
      services.users.profiles([userId]),
      services.chat.user(userId).catch(() => null),
      services.media.user(userId).catch(() => null)
    ]);
    const [against, by] = await Promise.all([
      db2.query("SELECT * FROM reports WHERE target_type = 'user' AND target_id = ? ORDER BY id DESC LIMIT 50", [userId]),
      db2.one("SELECT COUNT(*) AS total FROM reports WHERE reporter_id = ?", [userId])
    ]);
    const reporters = await cards(against.map((r) => r.reporter_id));
    return {
      user: { ...person(account, profiles[0], userId), about: profiles[0]?.about ?? "", lastSeenAt: profiles[0]?.lastSeenAt ?? null },
      devices,
      activity,
      storage,
      reportsFiled: Number(by?.total ?? 0),
      reports: against.map((row) => ({ ...reportView(row), reporter: reporters[row.reporter_id] ?? null }))
    };
  });
  const reasonBody = z3.object({ reason: z3.string().trim().min(1).max(255) });
  app.post("/admin/users/:userId/suspend", staff("moderator"), async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { reason } = reasonBody.parse(request.body);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== "active") fail("conflict", "Only an active account can be suspended.");
    await services.auth.setStatus(userId, "suspended", reason);
    await audit(db2, request, "user.suspend", "user", userId, { reason });
    return { ok: true };
  });
  app.post("/admin/users/:userId/restore", staff("moderator"), async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== "suspended") fail("conflict", "This account is not suspended.");
    await services.auth.setStatus(userId, "active", "");
    await audit(db2, request, "user.restore", "user", userId);
    return { ok: true };
  });
  app.post("/admin/users/:userId/sign-out", staff("admin"), async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    const { revoked } = await services.auth.signOut(userId);
    await audit(db2, request, "user.sign_out", "user", userId, { devices: revoked });
    return { revoked };
  });
  app.put("/admin/users/:userId/role", staff("owner"), async (request) => {
    const { userId } = z3.object({ userId: id }).parse(request.params);
    const { role } = z3.object({ role: z3.enum(["user", "moderator", "admin"]) }).parse(request.body);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== "active") fail("conflict", "Only an active account can be given a role.");
    if (account.role === role) return { ok: true };
    await services.auth.setRole(userId, role);
    accessCache.delete(userId);
    await audit(db2, request, "user.role", "user", userId, { from: account.role, to: role });
    return { ok: true };
  });
  const reportView = (row) => ({
    id: row.id,
    reporterId: row.reporter_id,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    note: row.note,
    status: row.status,
    assignedTo: row.assigned_to,
    resolution: row.resolution,
    action: row.action,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null
  });
  app.get("/admin/reports", staff("moderator"), async (request) => {
    const query = z3.object({ status: z3.enum(["open", "closed", "all"]).default("open"), before: id.optional() }).parse(request.query);
    const where = [];
    const params = [];
    if (query.status === "open") where.push("status IN ('open','reviewing')");
    if (query.status === "closed") where.push("status IN ('actioned','dismissed')");
    if (query.before) {
      where.push("id < ?");
      params.push(query.before);
    }
    const rows = await db2.query(`SELECT * FROM reports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 50`, params);
    const userTargets = [...new Set(rows.filter((r) => r.target_type === "user").map((r) => r.target_id))];
    const counts = userTargets.length ? await db2.query(
      `SELECT target_id, COUNT(*) AS total FROM reports WHERE target_type = 'user' AND status IN ('open','reviewing')
           AND target_id IN (${userTargets.map(() => "?").join(",")}) GROUP BY target_id`,
      userTargets
    ) : [];
    const openCount = new Map(counts.map((c) => [c.target_id, Number(c.total)]));
    const people = await cards([...rows.map((r) => r.reporter_id), ...userTargets, ...rows.flatMap((r) => r.assigned_to ? [r.assigned_to] : [])]);
    const targetAccounts = userTargets.length ? await services.auth.accounts({ ids: userTargets, limit: 100 }).catch(() => []) : [];
    const statusOf2 = new Map(targetAccounts.map((a) => [a.id, a.status]));
    const groups = await Promise.all(
      [...new Set(rows.filter((r) => r.target_type === "group").map((r) => r.target_id))].map((id2) => services.chat.group(id2).catch(() => null))
    );
    const groupById = new Map(groups.filter((g) => g !== null).map((g) => [g.id, g]));
    return {
      reports: rows.map((row) => ({
        ...reportView(row),
        reporter: people[row.reporter_id] ?? null,
        assignee: row.assigned_to ? people[row.assigned_to] ?? null : null,
        target: row.target_type === "user" ? { ...people[row.target_id] ?? { id: row.target_id }, status: statusOf2.get(row.target_id) ?? "deleted", openReports: openCount.get(row.target_id) ?? 0 } : row.target_type === "group" ? { id: row.target_id, name: groupById.get(row.target_id)?.name ?? null, members: groupById.get(row.target_id)?.members ?? 0 } : { id: row.target_id }
      })),
      next: rows.length === 50 ? rows.at(-1).id : null
    };
  });
  app.post("/admin/reports/:id", staff("moderator"), async (request) => {
    const { id: id2 } = z3.object({ id }).parse(request.params);
    const input = z3.object({
      status: z3.enum(["reviewing", "actioned", "dismissed", "open"]),
      resolution: z3.string().trim().max(500).default(""),
      suspend: z3.boolean().default(false)
    }).parse(request.body);
    const report = await db2.one("SELECT * FROM reports WHERE id = ?", [id2]);
    if (!report) fail("not_found", "Report not found.");
    let action = "none";
    if (input.suspend) {
      if (report.target_type !== "user") fail("bad_request", "Only people can be suspended.");
      if (input.status !== "actioned") fail("bad_request", "Suspending closes the report as actioned.");
      const { account } = await services.auth.account(report.target_id);
      assertCanManage(me(request), account);
      if (account.status === "active") {
        await services.auth.setStatus(account.id, "suspended", input.resolution || `Report: ${report.reason}`);
        action = "suspended";
      }
    }
    const closing = input.status === "actioned" || input.status === "dismissed";
    await db2.tx(async (tx) => {
      await tx.run(
        `UPDATE reports SET status = ?, resolution = ?, action = ?, assigned_to = ?, resolved_at = ${closing ? "CURRENT_TIMESTAMP(3)" : "NULL"} WHERE id = ?`,
        [input.status, input.resolution || null, closing ? action : null, me(request).userId, id2]
      );
      await audit(tx, request, `report.${input.status}`, "report", id2, { resolution: input.resolution || void 0, action });
      if (action === "suspended") await audit(tx, request, "user.suspend", "user", report.target_id, { reason: input.resolution, reportId: id2 });
    });
    return { ok: true, action };
  });
  app.get("/admin/audit", staff("admin"), async (request) => {
    const query = z3.object({ before: id.optional(), actorId: id.optional() }).parse(request.query);
    const where = [];
    const params = [];
    if (query.before) {
      where.push("id < ?");
      params.push(query.before);
    }
    if (query.actorId) {
      where.push("actor_id = ?");
      params.push(query.actorId);
    }
    const rows = await db2.query(
      `SELECT id, actor_id, action, target_type, target_id, details, created_at FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 50`,
      params
    );
    const people = await cards([...rows.map((r) => r.actor_id), ...rows.filter((r) => r.target_type === "user" && r.target_id).map((r) => r.target_id)]);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actor: people[row.actor_id] ?? { id: row.actor_id },
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        target: row.target_type === "user" && row.target_id ? people[row.target_id] ?? null : null,
        details: row.details ? JSON.parse(row.details) : null,
        createdAt: row.created_at.toISOString()
      })),
      next: rows.length === 50 ? rows.at(-1).id : null
    };
  });
}

// services/admin/src/main.ts
var env = loadConfig({
  PORT: z4.coerce.number().int().positive().default(4108),
  DB_NAME: z4.string().default("talkie_admin"),
  AUTH_URL: z4.url().default("http://127.0.0.1:4101"),
  USERS_URL: z4.url().default("http://127.0.0.1:4102"),
  CHAT_URL: z4.url().default("http://127.0.0.1:4103"),
  MEDIA_URL: z4.url().default("http://127.0.0.1:4105"),
  MEET_URL: z4.url().default("http://127.0.0.1:4106")
});
var db = connectDatabase(env, env.DB_NAME);
var service = await createService({ name: "admin", env, ready: () => db.ping(), rateLimitPerMinute: 300 });
var ids = new Snowflake(env.WORKER_ID);
var guards = installAuth(service.app, await createVerifier(env), env);
registerRoutes(service.app, db, ids, guards, clients(env));
var bus = createBus(env, service.log, "admin");
bus.subscribe("admin-reports", ["report.created"], async (event) => {
  const report = event.payload;
  await db.run(
    "INSERT IGNORE INTO reports (id, reporter_id, target_type, target_id, reason, note) VALUES (?, ?, ?, ?, ?, ?)",
    [report.reportId, report.reporterId, report.targetType, report.targetId, report.reason, report.note ?? ""]
  );
});
service.onShutdown(async () => {
  await bus.close();
  await db.close();
});
await service.listen(env.PORT);
//# sourceMappingURL=main.js.map
