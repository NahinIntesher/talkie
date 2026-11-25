import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { importSPKI, jwtVerify, type CryptoKey, type JWTPayload } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, configPath, type BaseEnv } from '@talkie/core';

export const ACCESS_TOKEN_ALG = 'EdDSA';

/** What a verified access token says about the caller. */
export interface AuthContext {
  userId: string;
  deviceId: string;
  sessionId: string;
  /** Platform role: `user`, or an admin role for the admin panel. */
  role: 'user' | 'moderator' | 'admin' | 'owner';
}

export interface AccessClaims extends JWTPayload {
  sub: string;
  did: string;
  sid: string;
  role: AuthContext['role'];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function readPublicKey(env: BaseEnv): string {
  if (env.JWT_PUBLIC_KEY) return env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  if (env.JWT_PUBLIC_KEY_FILE) return readFileSync(configPath(env.JWT_PUBLIC_KEY_FILE), 'utf8');
  throw new Error('JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE is required');
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

export async function createVerifier(env: BaseEnv, publicKeyPem = readPublicKey(env)): Promise<TokenVerifier> {
  const key: CryptoKey = await importSPKI(publicKeyPem, ACCESS_TOKEN_ALG);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify<AccessClaims>(token, key, {
          algorithms: [ACCESS_TOKEN_ALG],
          issuer: env.JWT_ISSUER,
          audience: env.JWT_AUDIENCE,
          clockTolerance: 5,
        });
        if (!payload.sub || !payload.did || !payload.sid) throw new Error('incomplete token');
        return { userId: payload.sub, deviceId: payload.did, sessionId: payload.sid, role: payload.role ?? 'user' };
      } catch {
        throw new AppError('unauthorized', 'Your session has expired. Please sign in again.');
      }
    },
  };
}

const bearer = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
};

/**
 * Adds `request.auth` when a valid bearer token is present, and the `requireAuth` / `requireRole` / `requireInternal`
 * pre-handlers that routes opt into.
 */
export function installAuth(app: FastifyInstance, verifier: TokenVerifier, env: BaseEnv) {
  app.decorateRequest('auth', undefined);
  app.addHook('onRequest', async (request) => {
    const token = bearer(request);
    if (token) request.auth = await verifier.verify(token);
  });
  const internal = Buffer.from(env.INTERNAL_TOKEN);
  return {
    requireAuth: async (request: FastifyRequest, _reply: FastifyReply) => {
      if (!request.auth) throw new AppError('unauthorized', 'Please sign in.');
    },
    requireRole:
      (...roles: AuthContext['role'][]) =>
      async (request: FastifyRequest, _reply: FastifyReply) => {
        if (!request.auth) throw new AppError('unauthorized', 'Please sign in.');
        if (!roles.includes(request.auth.role)) throw new AppError('forbidden', 'You do not have access to this.');
      },
    /** Service-to-service routes. Nginx never forwards `/internal/*` from the internet. */
    requireInternal: async (request: FastifyRequest, _reply: FastifyReply) => {
      const given = Buffer.from(String(request.headers['x-internal-token'] ?? ''));
      if (given.length !== internal.length || !timingSafeEqual(given, internal))
        throw new AppError('forbidden', 'Internal route.');
    },
  };
}

/** The signed-in caller, for handlers behind `requireAuth`. */
export const caller = (request: FastifyRequest): AuthContext => {
  if (!request.auth) throw new AppError('unauthorized', 'Please sign in.');
  return request.auth;
};

/** Calls another service's internal API with the service token. */
export async function internalFetch<T>(env: BaseEnv, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'x-internal-token': env.INTERNAL_TOKEN,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new AppError('unavailable', `Internal call failed (${response.status})`);
  return (await response.json()) as T;
}
