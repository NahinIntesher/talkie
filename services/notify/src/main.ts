import nodemailer from 'nodemailer';
import { z } from 'zod';
import { AppError, createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createVerifier, installAuth, caller } from '@talkie/auth-kit';
import * as contract from '@talkie/contracts';
import { otpEmail } from './email.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4107),
  DB_NAME: z.string().default('talkie_notify'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Talkie <no-reply@talkie.kodofact.com>'),
});

const db = connectDatabase(env, env.DB_NAME);
const service = await createService({ name: 'notify', env, ready: () => db.ping() });
const ids = new Snowflake(env.WORKER_ID);
const guards = installAuth(service.app, await createVerifier(env), env);

const mailer = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      pool: true,
      maxConnections: 5,
    })
  : null;

/** Sign-in code email. Called synchronously by the auth service; the code is not stored anywhere. */
service.app.post('/internal/email/otp', { preHandler: guards.requireInternal }, async (request) => {
  const input = z.object({ to: contract.email, code: contract.otpCode, locale: contract.locale }).parse(request.body);
  if (!mailer) throw new AppError('unavailable', 'Email delivery is not configured.');
  const message = otpEmail(input.code, input.locale);
  const id = ids.next();
  try {
    const sent = await mailer.sendMail({ from: env.MAIL_FROM, to: input.to, subject: message.subject, html: message.html, text: message.text });
    await db.run("INSERT INTO email_deliveries (id, recipient, template, status, provider_message_id) VALUES (?, ?, 'otp', 'sent', ?)", [
      id,
      input.to,
      sent.messageId ?? null,
    ]);
    return { ok: true };
  } catch (error) {
    request.log.error({ err: error }, 'otp email failed');
    await db.run("INSERT INTO email_deliveries (id, recipient, template, status, error) VALUES (?, ?, 'otp', 'failed', ?)", [
      id,
      input.to,
      String((error as Error).message).slice(0, 500),
    ]);
    throw new AppError('unavailable', 'We could not send the email. Please try again.');
  }
});

/** The device's push token (Firebase Cloud Messaging). */
service.app.put('/notify/push-token', { preHandler: guards.requireAuth }, async (request) => {
  const auth = caller(request);
  const input = z.object({ provider: z.enum(['fcm', 'webpush']), token: z.string().min(10).max(1024) }).parse(request.body);
  await db.run(
    `INSERT INTO push_tokens (device_id, user_id, provider, token) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), token = VALUES(token), user_id = VALUES(user_id)`,
    [auth.deviceId, auth.userId, input.provider, input.token],
  );
  return { ok: true };
});

service.onShutdown(async () => {
  mailer?.close();
  await db.close();
});

await service.listen(env.PORT);
