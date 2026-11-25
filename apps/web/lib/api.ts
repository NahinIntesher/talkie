import type { ErrorBody, SessionTokens } from '@talkie/contracts';

/** An API failure with the server's error code, ready to show to the user. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const tokenStore = {
  set(tokens: SessionTokens | null) {
    accessToken = tokens?.accessToken ?? null;
  },
  get: () => accessToken,
  onSignedOut(handler: () => void) {
    onSignedOut = handler;
  },
};

const BASE_HEADERS = { 'x-talkie-client': 'web' } as const;

/** Exchanges the HttpOnly refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', { method: 'POST', headers: BASE_HEADERS, credentials: 'include' });
      if (!response.ok) {
        accessToken = null;
        return false;
      }
      const body = (await response.json()) as { tokens: SessionTokens };
      accessToken = body.tokens.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'include',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'network');
  }
  if (response.status === 401 && !retried && !path.startsWith('/auth/otp') && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return api<T>(path, options, true);
    onSignedOut?.();
  }
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const error = (data as ErrorBody).error ?? { code: 'internal', message: 'error' };
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return data as T;
}
