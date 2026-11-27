import { isIPv4, isIPv6 } from 'node:net';
import { AppError } from './errors.ts';
import type { Logger } from './logger.ts';

/** Retry a temporary failure once for read-only service lookups, including lookups with JSON bodies. */
export async function lookupInternal<T>(token: string, log: Pick<Logger, 'warn'>, operation: string, url: string, body?: unknown, retry = true): Promise<T> {
  let status: number | undefined;
  for (let attempt = 0; ; attempt++) {
    status = undefined;
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-internal-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      });
      status = response.status;
      if (response.ok) return await response.json() as T;
      await response.body?.cancel();
    } catch {
      // A dropped connection, timed-out body or invalid response can be temporary.
    }
    if (status === 404) throw new AppError('not_found', 'Not found.');
    if (!retry || attempt > 0 || (status !== undefined && status >= 400 && status < 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log.warn({ operation, upstreamStatus: status }, 'internal service request failed');
  throw new AppError('unavailable', 'Talkie is busy right now. Please try again in a moment.');
}

/** Packs an IPv4/IPv6 address into 4 or 16 bytes for a VARBINARY(16) column. */
export function ipToBuffer(ip: string | undefined | null): Buffer | null {
  if (!ip) return null;
  const value = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(value)) return Buffer.from(value.split('.').map(Number));
  if (!isIPv6(value)) return null;
  const [head = '', tail = ''] = value.split('::');
  const part = (s: string) => (s ? s.split(':') : []);
  const left = part(head);
  const right = part(tail);
  const groups = value.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || '0', 16), index * 2));
  return out;
}
