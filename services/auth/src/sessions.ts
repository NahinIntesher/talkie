import { createHmac } from 'node:crypto';
import { AppError, ipToBuffer, randomToken, sha256, type Snowflake } from '@talkie/core';
import { writeOutbox, type Database, type Executor } from '@talkie/db';
import { MAX_LINKED_DEVICES, type DeviceInfo, type Platform, type SessionTokens } from '@talkie/contracts';
import type { AuthContext } from '@talkie/auth-kit';
import { env } from './config.ts';
import { signAccessToken } from './tokens.ts';

export interface AccountRow {
  id: string;
  email: string;
  status: 'pending_profile' | 'active' | 'suspended' | 'deleted';
  role: 'user' | 'moderator' | 'admin' | 'owner';
}

export interface DeviceInput {
  name: string;
  platform: Platform;
  identityKey?: string | undefined;
}

export interface ClientInfo {
  ip: string;
  userAgent: string | undefined;
}

export interface IssuedSession {
  deviceId: string;
  sessionId: string;
  tokens: SessionTokens & { refreshToken: string };
  revokedDeviceId: string | null;
}

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000);

export async function sessionIsActive(db: Database, auth: Pick<AuthContext, 'userId' | 'deviceId' | 'sessionId'>): Promise<boolean> {
  return !!await db.one(
    `SELECT 1 FROM sessions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id
     WHERE s.id = ? AND d.id = ? AND a.id = ? AND a.status = 'active'
       AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP(3))`,
    [auth.sessionId, auth.deviceId, auth.userId],
  );
}

async function issueRefresh(tx: Executor, sessionId: string, token = randomToken(32)): Promise<string> {
  await tx.run('INSERT INTO refresh_tokens (token_hash, session_id) VALUES (?, ?)', [sha256(token), sessionId]);
  return token;
}

async function trimDevices(tx: Executor, ids: Snowflake, accountId: string, keep: number) {
  const active = await tx.query<{ id: string }>(
    'SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at, id FOR UPDATE',
    [accountId],
  );
  const overflow = active.slice(0, Math.max(0, active.length - keep));
  for (const old of overflow) await revokeDevice(tx, ids, accountId, old.id, 'device_removed');
  return overflow[0]?.id ?? null;
}

/** Reconcile accounts already above the device limit when the server is upgraded. */
export async function enforceDeviceLimit(db: Database, ids: Snowflake) {
  const accounts = await db.query<{ account_id: string }>('SELECT account_id FROM devices WHERE revoked_at IS NULL GROUP BY account_id HAVING COUNT(*) > ?', [MAX_LINKED_DEVICES]);
  for (const { account_id } of accounts) {
    await db.tx(async (tx) => {
      if (await tx.one('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [account_id])) await trimDevices(tx, ids, account_id, MAX_LINKED_DEVICES);
    });
  }
}

/**
 * Registers a new device for the account and opens its session.
 * Keep the three most recently linked devices, including this sign-in.
 */
export async function openSession(
  db: Database,
  ids: Snowflake,
  account: AccountRow,
  device: DeviceInput,
  client: ClientInfo,
): Promise<IssuedSession> {
  const result = await db.tx(async (tx) => {
    const fresh = await tx.one<AccountRow>('SELECT id, email, status, role FROM accounts WHERE id = ? FOR UPDATE', [account.id]);
    if (fresh?.status !== 'active') throw new AppError('forbidden', 'This account cannot sign in.');
    const revokedDeviceId = await trimDevices(tx, ids, account.id, MAX_LINKED_DEVICES - 1);
    const deviceId = ids.next();
    const sessionId = ids.next();
    await tx.run('INSERT INTO devices (id, account_id, name, platform, identity_key) VALUES (?, ?, ?, ?, ?)', [
      deviceId,
      account.id,
      device.name,
      device.platform,
      device.identityKey ?? null,
    ]);
    await tx.run(
      'INSERT INTO sessions (id, device_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)',
      [sessionId, deviceId, device.platform === 'android' || device.platform === 'ios' ? null : refreshExpiry(), client.userAgent?.slice(0, 255) ?? null, ipToBuffer(client.ip)],
    );
    await tx.run('UPDATE accounts SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [account.id]);
    const refreshToken = await issueRefresh(tx, sessionId);
    await writeOutbox(tx, {
      id: ids.next(),
      type: 'device.linked',
      key: account.id,
      payload: { userId: account.id, deviceId, platform: device.platform, name: device.name },
    });
    return { deviceId, sessionId, refreshToken, revokedDeviceId, role: fresh.role };
  });
  const access = await signAccessToken({
    userId: account.id,
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    role: result.role,
  });
  return {
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    revokedDeviceId: result.revokedDeviceId,
    tokens: {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: result.refreshToken,
    },
  };
}

export async function revokeDevice(
  tx: Executor,
  ids: Snowflake,
  accountId: string,
  deviceId: string,
  reason: 'sign_out' | 'device_removed' | 'token_reuse' | 'account_suspended' | 'admin',
): Promise<boolean> {
  const updated = await tx.run(
    'UPDATE devices SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND account_id = ? AND revoked_at IS NULL',
    [deviceId, accountId],
  );
  if (updated.affectedRows === 0) return false;
  await tx.run(
    'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = ? WHERE device_id = ? AND revoked_at IS NULL',
    [reason, deviceId],
  );
  await writeOutbox(tx, { id: ids.next(), type: 'device.revoked', key: accountId, payload: { userId: accountId, deviceId, reason } });
  return true;
}

/**
 * Exchanges a refresh token for a new pair. Each refresh token works once; presenting an already-used token
 * means it was copied, so the whole session is revoked.
 */
export async function rotate(db: Database, ids: Snowflake, refreshToken: string, attempt?: string): Promise<{ tokens: IssuedSession['tokens']; accountId: string; deviceId: string }> {
  const hash = sha256(refreshToken);
  const outcome = await db.tx(async (tx) => {
    const row = await tx.one<{
      session_id: string;
      used_at: Date | null;
      rotation_attempt: Buffer | null;
      account_id: string;
      device_id: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      status: AccountRow['status'];
      role: AccountRow['role'];
    }>(
      `SELECT r.session_id, r.used_at, r.rotation_attempt, d.account_id, s.device_id, s.expires_at, s.revoked_at, a.status, a.role
       FROM refresh_tokens r
       JOIN sessions s ON s.id = r.session_id
       JOIN devices d ON d.id = s.device_id
       JOIN accounts a ON a.id = d.account_id
       WHERE r.token_hash = ? FOR UPDATE`,
      [hash],
    );
    if (!row) return { kind: 'invalid' as const };
    if (row.revoked_at) return { kind: 'revoked' as const };
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return { kind: 'expired' as const };
    if (row.status !== 'active') return { kind: 'suspended' as const };
    const retry = row.expires_at === null ? attempt : undefined;
    const attemptHash = retry ? sha256(retry) : null;
    const next = retry ? createHmac('sha256', env.OTP_PEPPER).update(`native-refresh:${refreshToken}:${retry}`).digest('base64url') : undefined;
    if (row.used_at) {
      // A client can lose the response after the transaction commits. Only its stored attempt can replay it.
      if (next && attemptHash && row.rotation_attempt?.equals(attemptHash)) {
        const successor = await tx.one('SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND session_id = ? AND used_at IS NULL', [sha256(next), row.session_id]);
        return successor ? { kind: 'ok' as const, row, next } : { kind: 'invalid' as const };
      }
      await revokeDevice(tx, ids, row.account_id, row.device_id, 'token_reuse');
      return { kind: 'reused' as const };
    }
    await tx.run('UPDATE refresh_tokens SET used_at = CURRENT_TIMESTAMP(3), rotation_attempt = ? WHERE token_hash = ?', [attemptHash, hash]);
    if (row.expires_at) await tx.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [refreshExpiry(), row.session_id]);
    await tx.run('UPDATE devices SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [row.device_id]);
    return { kind: 'ok' as const, row, next: await issueRefresh(tx, row.session_id, next) };
  });
  if (outcome.kind === 'reused') throw new AppError('session_revoked', 'This session was signed out for your safety. Please sign in again.');
  if (outcome.kind === 'suspended') throw new AppError('forbidden', 'This account is suspended.');
  if (outcome.kind !== 'ok') throw new AppError('unauthorized', 'Your session has expired. Please sign in again.');
  const access = await signAccessToken({
    userId: outcome.row.account_id,
    deviceId: outcome.row.device_id,
    sessionId: outcome.row.session_id,
    role: outcome.row.role,
  });
  return {
    accountId: outcome.row.account_id,
    deviceId: outcome.row.device_id,
    tokens: { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: outcome.next },
  };
}

export async function listDevices(db: Database, accountId: string, currentDeviceId: string): Promise<DeviceInfo[]> {
  const rows = await db.query<{ id: string; name: string; platform: DeviceInfo['platform']; created_at: Date; last_active_at: Date }>(
    `SELECT id, name, platform, created_at, last_active_at FROM devices
     WHERE account_id = ? AND revoked_at IS NULL ORDER BY last_active_at DESC`,
    [accountId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    current: row.id === currentDeviceId,
    createdAt: row.created_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString(),
  }));
}
