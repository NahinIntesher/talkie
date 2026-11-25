import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from './errors.ts';
import { createLogger, type Logger } from './logger.ts';
import type { BaseEnv } from './config.ts';

export interface ServiceOptions {
  name: string;
  env: BaseEnv;
  /** Requests per minute per client for this service (route options can override). */
  rateLimitPerMinute?: number;
  /** Called by /readyz; throw when a dependency is not reachable. */
  ready?: () => Promise<void>;
  bodyLimit?: number;
}

export interface Service {
  app: FastifyInstance;
  log: Logger;
  redis: Redis | null;
  /** Registers a cleanup step run on SIGTERM/SIGINT, in reverse order. */
  onShutdown(step: () => Promise<void> | void): void;
  listen(port: number): Promise<void>;
}

/**
 * Creates a Fastify server with the same production defaults in every service:
 * request ids, security headers, CORS for the public origin, rate limiting (Redis-backed when available),
 * one JSON error shape, health/readiness probes and graceful shutdown.
 */
export async function createService(options: ServiceOptions): Promise<Service> {
  const { env, name } = options;
  const log = createLogger(name, env.LOG_LEVEL);
  const fastifyOptions: FastifyServerOptions = {
    loggerInstance: log,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w-]{8,64}$/.test(given) ? given : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: false } },
  };
  const app = Fastify(fastifyOptions);
  const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2, enableAutoPipelining: true }) : null;
  redis?.on('error', (error) => log.warn({ err: error }, 'redis error'));

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  const origins = new Set([env.PUBLIC_ORIGIN, ...env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)]);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || origins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: options.rateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    ...(redis ? { redis, nameSpace: `rl:${name}:` } : {}),
    keyGenerator: (request) => (request as { auth?: { userId: string } }).auth?.userId ?? request.ip,
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 'Too many requests. Please slow down.', { retryAfterSeconds: Math.ceil(context.ttl / 1000) }),
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'validation_failed',
          message: 'Some fields are not valid.',
          details: { fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
        },
      });
    }
    const err = error as { statusCode?: number; validation?: unknown; message?: string; code?: string };
    if (err.validation) {
      return reply.status(422).send({ error: { code: 'validation_failed', message: err.message ?? 'Invalid request.' } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message ?? 'Bad request.' } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
  );

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok', service: name }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await options.ready?.();
      if (redis) await redis.ping();
      return { status: 'ready', service: name };
    } catch (error) {
      log.warn({ err: error }, 'not ready');
      return reply.status(503).send({ status: 'not_ready', service: name });
    }
  });

  const steps: Array<() => Promise<void> | void> = [];
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    try {
      await app.close();
      for (const step of steps.reverse()) await step();
      await redis?.quit();
    } catch (error) {
      log.error({ err: error }, 'shutdown failed');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return {
    app,
    log,
    redis,
    onShutdown: (step) => void steps.push(step),
    listen: async (port) => {
      await app.listen({ port, host: env.HOST });
    },
  };
}
