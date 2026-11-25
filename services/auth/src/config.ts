import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configPath, loadConfig } from '@talkie/core';

export const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4101),
  DB_NAME: z.string().default('talkie_auth'),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PRIVATE_KEY_FILE: z.string().optional(),
  /** HMAC key for one-time codes, at least 32 characters. */
  OTP_PEPPER: z.string().min(32).default('development-otp-pepper-change-me-000000'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  NOTIFY_URL: z.url().default('http://127.0.0.1:4107'),
  /** Development only: print one-time codes in the auth service log when email delivery is not configured. */
  DEV_LOG_OTP: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Development only: every sign-in code is this value (6 digits), for scripted tests. Refused in production. */
  DEV_FIXED_OTP: z.string().regex(/^\d{6}$/).optional(),
  /** Emails (comma separated) that become the platform owner on first sign-up. */
  OWNER_EMAILS: z.string().default(''),
});

if (env.NODE_ENV === 'production' && env.DEV_FIXED_OTP)
  throw new Error('Invalid configuration:\n  DEV_FIXED_OTP must not be set in production');
if (env.NODE_ENV === 'production' && env.OTP_PEPPER.startsWith('development-'))
  throw new Error('Invalid configuration:\n  OTP_PEPPER must be set in production');

export function privateKeyPem(): string {
  if (env.JWT_PRIVATE_KEY) return env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.JWT_PRIVATE_KEY_FILE) return readFileSync(configPath(env.JWT_PRIVATE_KEY_FILE), 'utf8');
  throw new Error('JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_FILE is required (run `npm run keys:generate`)');
}

export const ownerEmails = new Set(
  env.OWNER_EMAILS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
);

export const OTP = {
  ttlMinutes: 10,
  maxAttempts: 5,
  resendAfterSeconds: 60,
  perEmailPerHour: 5,
  perIpPerHour: 30,
  /** After a verified code, a new user has this long to choose a username. */
  signupWindowMinutes: 30,
} as const;
