import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, fail, hmac, ipToBuffer, randomDigits, randomToken, safeEqual, sha256, type Snowflake } from '@talkie/core';
import { caller, type installAuth } from '@talkie/auth-kit';
import { writeOutbox, type Database } from '@talkie/db';
import * as contract from '@talkie/contracts';
import { env, OTP, ownerEmails } from './config.ts';
import { sendOtpEmail, usersClient } from './clients.ts';
import { listDevices, openSession, revokeDevice, rotate, type AccountRow, type IssuedSession } from './sessions.ts';

type Guards = ReturnType<typeof installAuth>;

const REFRESH_COOKIE = 'talkie_rt';
const cookiePath = '/api/auth';

/** Web clients send `x-talkie-client: web`; it also forces a CORS preflight, blocking cross-site form posts. */
const isWeb = (request: FastifyRequest) => request.headers['x-talkie-client'] === 'web';

function deliverTokens(request: FastifyRequest, reply: FastifyReply, tokens: IssuedSession['tokens']): contract.SessionTokens {
  if (isWeb(request)) {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: cookiePath,
      maxAge: env.REFRESH_TOKEN_DAYS * 86_400,
    });
    return { accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt };
  }
  return tokens;
}

const codeHash = (challengeId: string, code: string) => hmac(env.OTP_PEPPER, `${challengeId}:${code}`);

export function registerRoutes(app: FastifyInstance, db: Database, ids: Snowflake, guards: Guards) {
  const client = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] });

  const me = async (account: AccountRow): Promise<contract.Me> => {
    const { profile } = await usersClient.get(account.id);
    return { ...profile, email: account.email, role: account.role };
  };

  // ───────── One-time code ─────────

  app.post('/auth/otp/request', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const input = contract.otpRequest.parse(request.body);
    const ip = ipToBuffer(request.ip);
    const recent = await db.one<{ total: number; last: Date | null }>(
      `SELECT COUNT(*) AS total, MAX(created_at) AS last FROM otp_challenges
       WHERE email = ? AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR`,
      [input.email],
    );
    if (recent?.last && Date.now() - recent.last.getTime() < OTP.resendAfterSeconds * 1000)
      fail('rate_limited', 'Please wait a moment before asking for a new code.', {
        retryAfterSeconds: Math.ceil(OTP.resendAfterSeconds - (Date.now() - recent.last.getTime()) / 1000),
      });
    if (Number(recent?.total ?? 0) >= OTP.perEmailPerHour)
      fail('rate_limited', 'Too many codes were requested for this email. Try again in an hour.', { retryAfterSeconds: 3600 });
    if (ip) {
      const fromIp = await db.one<{ total: number }>(
        'SELECT COUNT(*) AS total FROM otp_challenges WHERE request_ip = ? AND created_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR',
        [ip],
      );
      if (Number(fromIp?.total ?? 0) >= OTP.perIpPerHour)
        fail('rate_limited', 'Too many sign-in attempts from this network. Try again later.', { retryAfterSeconds: 3600 });
    }
    const challengeId = ids.next();
    const code = env.DEV_FIXED_OTP ?? randomDigits(contract.OTP_LENGTH);
    const expiresAt = new Date(Date.now() + OTP.ttlMinutes * 60_000);
    await db.run('INSERT INTO otp_challenges (id, email, code_hash, expires_at, request_ip) VALUES (?, ?, ?, ?, ?)', [
      challengeId,
      input.email,
      codeHash(challengeId, code),
      expiresAt,
      ip,
    ]);
    await sendOtpEmail(request.log, input.email, code, input.locale);
    const body: contract.OtpRequested = { challengeId, expiresAt: expiresAt.toISOString(), resendAfterSeconds: OTP.resendAfterSeconds };
    return body;
  });

  app.post('/auth/otp/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = contract.otpVerify.parse(request.body);
    const check = await db.tx(async (tx) => {
      const challenge = await tx.one<{ email: string; code_hash: Buffer; attempts: number; expires_at: Date; verified_at: Date | null; consumed_at: Date | null }>(
        'SELECT email, code_hash, attempts, expires_at, verified_at, consumed_at FROM otp_challenges WHERE id = ? FOR UPDATE',
        [input.challengeId],
      );
      if (!challenge || challenge.consumed_at || challenge.verified_at) return { kind: 'invalid' as const };
      if (challenge.expires_at.getTime() < Date.now()) return { kind: 'expired' as const };
      if (challenge.attempts >= OTP.maxAttempts) return { kind: 'attempts' as const };
      if (!safeEqual(codeHash(input.challengeId, input.code), challenge.code_hash)) {
        await tx.run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', [input.challengeId]);
        return { kind: 'wrong' as const, left: OTP.maxAttempts - challenge.attempts - 1 };
      }
      const account = await tx.one<AccountRow>('SELECT id, email, status, role FROM accounts WHERE email = ?', [challenge.email]);
      if (account?.status === 'active') {
        await tx.run('UPDATE otp_challenges SET verified_at = CURRENT_TIMESTAMP(3), consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [input.challengeId]);
        // An email added to OWNER_EMAILS after sign-up becomes the owner at its next sign-in.
        if (ownerEmails.has(account.email) && account.role !== 'owner') {
          await tx.run("UPDATE accounts SET role = 'owner' WHERE id = ?", [account.id]);
          account.role = 'owner';
        }
        return { kind: 'account' as const, account };
      }
      if (account && account.status !== 'pending_profile') return { kind: 'blocked' as const, status: account.status };
      const signupToken = randomToken(32);
      await tx.run('UPDATE otp_challenges SET verified_at = CURRENT_TIMESTAMP(3), signup_token_hash = ? WHERE id = ?', [
        sha256(signupToken),
        input.challengeId,
      ]);
      return { kind: 'signup' as const, signupToken, email: challenge.email };
    });
    switch (check.kind) {
      case 'invalid':
        return fail('otp_invalid', 'This code is no longer valid. Ask for a new one.');
      case 'expired':
        return fail('otp_expired', 'This code has expired. Ask for a new one.');
      case 'attempts':
        return fail('otp_attempts_exceeded', 'Too many wrong codes. Ask for a new one.');
      case 'wrong':
        return fail('otp_invalid', 'That code is not correct.', { attemptsLeft: check.left });
      case 'blocked':
        return fail('forbidden', check.status === 'suspended' ? 'This account is suspended.' : 'This account was deleted.');
      case 'signup': {
        const body: contract.OtpVerified = { status: 'needs_signup', signupToken: check.signupToken, email: check.email };
        return body;
      }
      case 'account': {
        const session = await openSession(db, ids, check.account, input.device, client(request));
        const body: contract.OtpVerified = {
          status: 'signed_in',
          user: await me(check.account),
          tokens: deliverTokens(request, reply, session.tokens),
          deviceId: session.deviceId,
        };
        return body;
      }
    }
  });

  // ───────── Sign-up: choose username and name ─────────

  app.post('/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = contract.signupComplete.parse(request.body);
    const locale = contract.locale.catch('bn').parse((request.body as { locale?: unknown }).locale);
    const ticket = await db.one<{ id: string; email: string; verified_at: Date | null; consumed_at: Date | null }>(
      'SELECT id, email, verified_at, consumed_at FROM otp_challenges WHERE signup_token_hash = ?',
      [sha256(input.signupToken)],
    );
    if (!ticket?.verified_at || ticket.consumed_at || Date.now() - ticket.verified_at.getTime() > OTP.signupWindowMinutes * 60_000)
      fail('otp_expired', 'Your sign-up time ran out. Please start again.');
    const email = ticket!.email;
    // The account exists as pending_profile until the profile (with its unique username) is created.
    let account = await db.one<AccountRow>('SELECT id, email, status, role FROM accounts WHERE email = ?', [email]);
    if (!account) {
      const id = ids.next();
      const role = ownerEmails.has(email) ? 'owner' : 'user';
      await db.run("INSERT IGNORE INTO accounts (id, email, status, role) VALUES (?, ?, 'pending_profile', ?)", [id, email, role]);
      account = await db.one<AccountRow>('SELECT id, email, status, role FROM accounts WHERE email = ?', [email]);
    }
    if (!account) return fail('internal', 'Could not create the account.');
    if (account.status === 'active') fail('conflict', 'This email already has an account. Sign in instead.');
    if (account.status !== 'pending_profile') fail('forbidden', 'This account cannot be used.');
    await usersClient.create({ userId: account.id, username: input.username, displayName: input.displayName, locale });
    const activated = await db.tx(async (tx) => {
      const consumed = await tx.run('UPDATE otp_challenges SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL', [ticket!.id]);
      if (consumed.affectedRows === 0) return false;
      await tx.run("UPDATE accounts SET status = 'active' WHERE id = ?", [account!.id]);
      await writeOutbox(tx, {
        id: ids.next(),
        type: 'account.created',
        key: account!.id,
        payload: { userId: account!.id, email, username: input.username, displayName: input.displayName, locale },
      });
      return true;
    });
    if (!activated) fail('otp_expired', 'This sign-up was already completed. Sign in instead.');
    const active: AccountRow = { ...account, status: 'active' };
    const session = await openSession(db, ids, active, input.device, client(request));
    reply.status(201);
    const body: contract.OtpVerified = {
      status: 'signed_in',
      user: await me(active),
      tokens: deliverTokens(request, reply, session.tokens),
      deviceId: session.deviceId,
    };
    return body;
  });

  // ───────── Session ─────────

  app.post('/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const fromBody = z.object({ refreshToken: z.string().min(20).max(256) }).safeParse(request.body ?? {});
    const token = isWeb(request) ? request.cookies[REFRESH_COOKIE] : fromBody.success ? fromBody.data.refreshToken : undefined;
    if (!token) fail('unauthorized', 'Please sign in.');
    try {
      const result = await rotate(db, ids, token!);
      return { tokens: deliverTokens(request, reply, result.tokens), deviceId: result.deviceId };
    } catch (error) {
      if (isWeb(request)) reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
      throw error;
    }
  });

  app.post('/auth/logout', { preHandler: guards.requireAuth }, async (request, reply) => {
    const auth = caller(request);
    await db.tx((tx) => revokeDevice(tx, ids, auth.userId, auth.deviceId, 'sign_out'));
    reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
    return { ok: true };
  });

  app.get('/auth/account', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const account = await db.one<AccountRow & { created_at: Date }>('SELECT id, email, status, role, created_at FROM accounts WHERE id = ?', [auth.userId]);
    if (!account) fail('not_found', 'Account not found.');
    return { email: account!.email, role: account!.role, deviceId: auth.deviceId, createdAt: account!.created_at.toISOString() };
  });

  // ───────── Linked devices ─────────

  app.get('/auth/devices', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    return { devices: await listDevices(db, auth.userId, auth.deviceId) };
  });

  app.delete('/auth/devices/:deviceId', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { deviceId } = z.object({ deviceId: contract.id }).parse(request.params);
    const removed = await db.tx((tx) => revokeDevice(tx, ids, auth.userId, deviceId, deviceId === auth.deviceId ? 'sign_out' : 'device_removed'));
    if (!removed) fail('not_found', 'Device not found.');
    return { ok: true };
  });

  app.put('/auth/devices/current/identity-key', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { identityKey } = z.object({ identityKey: contract.publicKey }).parse(request.body);
    await db.run('UPDATE devices SET identity_key = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL', [identityKey, auth.deviceId, auth.userId]);
    return { ok: true };
  });

  /** Public keys of a user's active devices, so a sender can encrypt for each of them. */
  app.get('/auth/users/:userId/device-keys', { preHandler: guards.requireAuth }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const rows = await db.query<{ id: string; identity_key: string }>(
      'SELECT id, identity_key FROM devices WHERE account_id = ? AND revoked_at IS NULL AND identity_key IS NOT NULL',
      [userId],
    );
    return { devices: rows.map((row) => ({ deviceId: row.id, identityKey: row.identity_key })) };
  });

  /**
   * Public keys of specific devices, including signed-out ones, so old messages from a device that was later
   * removed can still be opened. Public keys are not secret.
   */
  app.post('/auth/device-keys/lookup', { preHandler: guards.requireAuth }, async (request) => {
    const { deviceIds } = z.object({ deviceIds: z.array(contract.id).min(1).max(200) }).parse(request.body);
    const rows = await db.query<{ id: string; account_id: string; identity_key: string }>(
      `SELECT id, account_id, identity_key FROM devices WHERE id IN (${deviceIds.map(() => '?').join(',')}) AND identity_key IS NOT NULL`,
      deviceIds,
    );
    return { devices: rows.map((row) => ({ deviceId: row.id, userId: row.account_id, identityKey: row.identity_key })) };
  });

  // ───────── Internal (service-to-service) ─────────

  app.post('/internal/device-keys', { preHandler: guards.requireInternal }, async (request) => {
    const { userIds } = z.object({ userIds: z.array(contract.id).min(1).max(1024) }).parse(request.body);
    const rows = await db.query<{ id: string; account_id: string; identity_key: string }>(
      `SELECT id, account_id, identity_key FROM devices
       WHERE account_id IN (${userIds.map(() => '?').join(',')}) AND revoked_at IS NULL AND identity_key IS NOT NULL`,
      userIds,
    );
    return { devices: rows.map((row) => ({ userId: row.account_id, deviceId: row.id, identityKey: row.identity_key })) };
  });

  app.post('/internal/accounts/:userId/status', { preHandler: guards.requireInternal }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { status, reason } = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(255).default('') }).parse(request.body);
    await db.tx(async (tx) => {
      const updated = await tx.run("UPDATE accounts SET status = ?, suspended_reason = ? WHERE id = ? AND status IN ('active','suspended')", [
        status,
        status === 'suspended' ? reason : null,
        userId,
      ]);
      if (updated.affectedRows === 0) throw new AppError('not_found', 'Account not found.');
      if (status === 'suspended') {
        const devices = await tx.query<{ id: string }>('SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL', [userId]);
        for (const device of devices) await revokeDevice(tx, ids, userId, device.id, 'account_suspended');
      }
      await writeOutbox(tx, { id: ids.next(), type: 'account.status_changed', key: userId, payload: { userId, status } });
    });
    return { ok: true };
  });
}
