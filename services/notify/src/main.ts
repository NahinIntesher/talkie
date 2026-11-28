import nodemailer from 'nodemailer';
import { z } from 'zod';
import { AppError, createService, loadConfig, Snowflake } from '@talkie/core';
import { connectDatabase } from '@talkie/db';
import { createBus } from '@talkie/bus';
import { createVerifier, installAuth, caller } from '@talkie/auth-kit';
import * as contract from '@talkie/contracts';
import { otpEmail } from './email.ts';
import { createFcm, loadServiceAccount } from './fcm.ts';
import { pushHandlers } from './push.ts';

const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4107),
  DB_NAME: z.string().default('talkie_notify'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Talkie <no-reply@talkie.kodofact.com>'),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  /** Push notifications: a Firebase service account JSON (the JSON itself or base64 of it), or a path to the file. */
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_FILE: z.string().optional(),
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
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 14_000,
    })
  : null;

/** Sign-in code email. Called synchronously by the auth service; the code is not stored anywhere. */
service.app.post('/internal/email/otp', { preHandler: guards.requireInternal }, async (request) => {
  const input = z.object({ to: contract.email, code: contract.otpCode, locale: contract.locale }).parse(request.body);
  if (!mailer) throw new AppError('unavailable', 'Email delivery is not configured.');
  const message = otpEmail(input.code, input.locale);
  const id = ids.next();
  const audit = (status: 'sent' | 'failed', providerId: string | null, error: string | null) => {
    void db.run('INSERT INTO email_deliveries (id, recipient, template, status, provider_message_id, error) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.to, 'otp', status, providerId, error]).catch((err) => request.log.warn({ err }, 'could not record OTP email delivery'));
  };
  try {
    const sent = await mailer.sendMail({ from: env.MAIL_FROM, to: input.to, subject: message.subject, html: message.html, text: message.text });
    audit('sent', sent.messageId ?? null, null);
    return { ok: true };
  } catch (error) {
    request.log.error({ err: error }, 'otp email failed');
    audit('failed', null, String((error as Error).message).slice(0, 500));
    throw new AppError('unavailable', 'We could not send the email. Please try again.');
  }
});

/** The device's push token (Firebase Cloud Messaging). */
service.app.put('/notify/push-token', { preHandler: guards.requireAuth }, async (request) => {
  const auth = caller(request);
  const input = z.object({ provider: z.enum(['fcm', 'webpush']), token: z.string().min(10).max(1024), inlineReply: z.boolean().default(false), phoneRingtone: z.boolean().default(false) }).parse(request.body);
  await db.run(
    `INSERT INTO push_tokens (device_id, user_id, provider, token, inline_reply, phone_ringtone) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), token = VALUES(token), user_id = VALUES(user_id),
       inline_reply = VALUES(inline_reply), phone_ringtone = VALUES(phone_ringtone)`,
    [auth.deviceId, auth.userId, input.provider, input.token, input.inlineReply, input.phoneRingtone],
  );
  return { ok: true };
});

// ───────── Push notifications (Firebase Cloud Messaging) ─────────

const bus = createBus(env, service.log, 'notify');
const account = loadServiceAccount(env);
const fcm = account ? createFcm(account, service.log) : null;
if (!fcm) service.log.warn('FIREBASE_SERVICE_ACCOUNT is not set: push notifications are off');
else {
  const push = pushHandlers({
    origin: env.PUBLIC_ORIGIN.replace(/\/$/, ''),
    db,
    fcm,
    log: service.log,
    avatar: async (senderId, recipients) => {
      const response = await fetch(`${env.USERS_URL}/internal/notification-avatar`, {
        method: 'POST',
        headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ senderId, recipients }),
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`notification avatar lookup failed (${response.status})`);
      return await response.json() as { avatarUrl: string | null; recipients: string[] };
    },
    profiles: async (userIds) => {
      const response = await fetch(`${env.USERS_URL}/internal/admin/profiles`, {
        method: 'POST',
        headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...new Set(userIds)] }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`profile lookup failed (${response.status})`);
      return ((await response.json()) as { profiles: Array<{ id: string; displayName: string; locale: 'bn' | 'en' }> }).profiles;
    },
  });
  bus.subscribe('notify-push', ['message.sent', 'call.ringing', 'device.revoked'], async (event) => {
    if (event.type === 'message.sent') await push.messageSent(event);
    else if (event.type === 'call.ringing') await push.callRinging(event);
    else await push.deviceRevoked(event);
  });
  service.log.info({ project: fcm.projectId }, 'push notifications on');
}

/** Install check for /api/health (internal only): email login and the Firebase key. */
service.app.get('/internal/selfcheck', { preHandler: guards.requireInternal }, async () => {
  let email = 'not configured';
  if (mailer) {
    try {
      await mailer.verify();
      email = 'ok';
    } catch (error) {
      email = `rejected: ${String((error as Error)?.message ?? error).slice(0, 120)}`;
    }
  }
  return { email, push: fcm ? await fcm.check() : 'not configured' };
});

/** Turns push notifications off for this device (the app calls it when the person turns notifications off or signs out). */
service.app.delete('/notify/push-token', { preHandler: guards.requireAuth }, async (request) => {
  await db.run('DELETE FROM push_tokens WHERE device_id = ?', [caller(request).deviceId]);
  return { ok: true };
});

/** The person's notification switches. */
service.app.get('/notify/preferences', { preHandler: guards.requireAuth }, async (request) => {
  const row = await db.one<{ messages: number; groups_enabled: number; calls: number; show_preview: number }>(
    'SELECT messages, groups_enabled, calls, show_preview FROM notification_preferences WHERE user_id = ?',
    [caller(request).userId],
  );
  return {
    messages: row ? !!row.messages : true,
    groups: row ? !!row.groups_enabled : true,
    calls: row ? !!row.calls : true,
    showPreview: row ? !!row.show_preview : true,
  };
});

service.app.put('/notify/preferences', { preHandler: guards.requireAuth }, async (request) => {
  const input = z.object({ messages: z.boolean(), groups: z.boolean(), calls: z.boolean(), showPreview: z.boolean() }).parse(request.body);
  await db.run(
    `INSERT INTO notification_preferences (user_id, messages, groups_enabled, calls, show_preview) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE messages = VALUES(messages), groups_enabled = VALUES(groups_enabled), calls = VALUES(calls), show_preview = VALUES(show_preview)`,
    [caller(request).userId, input.messages, input.groups, input.calls, input.showPreview],
  );
  return { ok: true };
});

service.onShutdown(async () => {
  mailer?.close();
  await bus.close();
  await db.close();
});

await service.listen(env.PORT);
