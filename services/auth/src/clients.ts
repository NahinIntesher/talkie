import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '@talkie/core';
import type { Locale, PublicUser } from '@talkie/contracts';
import { env } from './config.ts';

const headers = { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' };

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new AppError('unavailable', 'Talkie is busy right now. Please try again in a moment.');
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!response.ok) {
    if (body.error && response.status < 500) throw new AppError(body.error.code as never, body.error.message);
    throw new AppError('unavailable', 'Talkie is busy right now. Please try again in a moment.');
  }
  return body;
}

export interface ProfileView extends PublicUser {
  locale: Locale;
}

export const usersClient = {
  create: (input: { userId: string; username: string; displayName: string; locale: Locale }) =>
    call<{ profile: ProfileView }>(`${env.USERS_URL}/internal/profiles`, { method: 'POST', body: JSON.stringify(input) }),
  get: (userId: string) => call<{ profile: ProfileView }>(`${env.USERS_URL}/internal/profiles/${userId}`, { method: 'GET' }),
};

/**
 * Sends the sign-in code through the notification service. In development, when email is not configured,
 * the code is written to this service's log instead so sign-in still works locally.
 */
export async function sendOtpEmail(log: FastifyBaseLogger, to: string, code: string, locale: Locale): Promise<void> {
  try {
    await call(`${env.NOTIFY_URL}/internal/email/otp`, { method: 'POST', body: JSON.stringify({ to, code, locale }) });
  } catch (error) {
    if (env.NODE_ENV !== 'production' && env.DEV_LOG_OTP) {
      log.warn({ to }, `email not delivered; development sign-in code for ${to}: ${code}`);
      return;
    }
    throw error;
  }
  if (env.NODE_ENV !== 'production' && env.DEV_LOG_OTP) log.info(`development sign-in code for ${to}: ${code}`);
}
