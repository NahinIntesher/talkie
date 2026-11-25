import { AppError, ipToBuffer, randomToken, sha256, type Snowflake } from '@talkie/core';
import { writeOutbox, type Database, type Executor } from '@talkie/db';
import { MAX_LINKED_DEVICES, type DeviceInfo, type Platform, type SessionTokens } from '@talkie/contracts';
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

async function issueRefresh(tx: Executor, sessionId: string): Promise<string> {
  const token = randomToken(32);
  await tx.run('INSERT INTO refresh_tokens (token_hash, session_id) VALUES (?, ?)', [sha256(token), sessionId]);
  return token;
}

/**
 * Registers a new device for the account and opens its session.
 * When the account already has the maximum number of linked devices, the least recently active one is signed out.
 */
export async function openSession(
  db: Database,
  ids: Snowflake,
  account: AccountRow,
  device: DeviceInput,
  client: ClientInfo,
): Promise<IssuedSession> {
  const result = await db.tx(async (tx) => {
    const active = await tx.query<{ id: string }>(
      'SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY last_active_at ASC FOR UPDATE',
      [account.id],
    );
    let revokedDeviceId: string | null = null;
    if (active.length >= MAX_LINKED_DEVICES) {
      revokedDeviceId = active[0]!.id;
      await revokeDevice(tx, ids, account.id, revokedDeviceId, 'device_removed');
    }
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
      [sessionId, deviceId, refreshExpiry(), client.userAgent?.slice(0, 255) ?? null, ipToBuffer(client.ip)],
    );
    await tx.run('UPDATE accounts SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [account.id]);
    const refreshToken = await issueRefresh(tx, sessionId);
    await writeOutbox(tx, {
      id: ids.next(),
      type: 'device.linked',
      key: account.id,
      payload: { userId: account.id, deviceId, platform: device.platform, name: device.name },
    });
    return { deviceId, sessionId, refreshToken, revokedDeviceId };
  });
  const access = await signAccessToken({
    userId: account.id,
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    role: account.role,
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
  await tx.run(
    'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = ? WHERE device_id = ? AND revoked_at IS NULL',
    [reason, deviceId],
  );
  if (updated.affectedRows > 0)
    await writeOutbox(tx, { id: ids.next(), type: 'device.revoked', key: accountId, payload: { userId: accountId, deviceId, reason } });
  return updated.affectedRows > 0;
}

/**
 * Exchanges a refresh token for a new pair. Each refresh token works once; presenting an already-used token
 * means it was copied, so the whole session is revoked.
 */
export async function rotate(db: Database, ids: Snowflake, refreshToken: string): Promise<{ tokens: IssuedSession['tokens']; accountId: string; deviceId: string }> {
  const hash = sha256(refreshToken);
  const outcome = await db.tx(async (tx) => {
    const row = await tx.one<{
      session_id: string;
      used_at: Date | null;
      account_id: string;
      device_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      status: AccountRow['status'];
      role: AccountRow['role'];
    }>(
      `SELECT r.session_id, r.used_at, d.account_id, s.device_id, s.expires_at, s.revoked_at, a.status, a.role
       FROM refresh_tokens r
       JOIN sessions s ON s.id = r.session_id
       JOIN devices d ON d.id = s.device_id
       JOIN accounts a ON a.id = d.account_id
       WHERE r.token_hash = ? FOR UPDATE`,
      [hash],
    );
    if (!row) return { kind: 'invalid' as const };
    if (row.revoked_at) return { kind: 'revoked' as const };
    if (row.used_at) {
      await revokeDevice(tx, ids, row.account_id, row.device_id, 'token_reuse');
      return { kind: 'reused' as const };
    }
    if (row.expires_at.getTime() < Date.now()) return { kind: 'expired' as const };
    if (row.status !== 'active') return { kind: 'suspended' as const };
    await tx.run('UPDATE refresh_tokens SET used_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ?', [hash]);
    await tx.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [refreshExpiry(), row.session_id]);
    await tx.run('UPDATE devices SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [row.device_id]);
    const next = await issueRefresh(tx, row.session_id);
    return { kind: 'ok' as const, row, next };
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
