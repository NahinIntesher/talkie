import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export const hmac = (key: string, value: string): Buffer => createHmac('sha256', key).update(value).digest();

/** URL-safe random token (default 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Uniformly random numeric code, e.g. a 6-digit OTP. */
export const randomDigits = (length = 6): string =>
  Array.from({ length }, () => randomInt(0, 10)).join('');

export const safeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
