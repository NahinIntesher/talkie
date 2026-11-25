import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, dailySeries, likeEscape, seriesStart, Snowflake } from '@talkie/core';
import { writeOutbox, type Database } from '@talkie/db';
import type { installAuth } from '@talkie/auth-kit';
import * as contract from '@talkie/contracts';
import { revokeDevice } from './sessions.ts';

type Guards = ReturnType<typeof installAuth>;

interface AccountListRow {
  id: string;
  email: string;
  status: string;
  role: string;
  created_at: Date;
  last_login_at: Date | null;
  suspended_reason: string | null;
  devices: string;
  last_active_at: Date | null;
}

const accountView = (row: AccountListRow) => ({
  id: row.id,
  email: row.email,
  status: row.status,
  role: row.role,
  createdAt: row.created_at.toISOString(),
  lastLoginAt: row.last_login_at?.toISOString() ?? null,
  lastActiveAt: row.last_active_at?.toISOString() ?? null,
  suspendedReason: row.suspended_reason,
  devices: Number(row.devices),
});

const LIST_SQL = `SELECT a.id, a.email, a.status, a.role, a.created_at, a.last_login_at, a.suspended_reason,
  (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
  (SELECT MAX(d.last_active_at) FROM devices d WHERE d.account_id = a.id) AS last_active_at
  FROM accounts a`;

/** Service-to-service routes the admin service uses. Never reachable from the internet (nginx blocks /internal). */
export function registerAdminRoutes(app: FastifyInstance, db: Database, ids: Snowflake, guards: Guards) {
  const internal = { preHandler: guards.requireInternal };

  /** Accounts newest first, filtered by ids, an email fragment, status or staff. Keyset paging with `before`. */
  app.post('/internal/admin/accounts', internal, async (request) => {
    const input = z
      .object({
        ids: z.array(contract.id).max(200).optional(),
        email: z.string().trim().toLowerCase().max(254).optional(),
        status: z.enum(['pending_profile', 'active', 'suspended', 'deleted']).optional(),
        staff: z.boolean().optional(),
        before: contract.id.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .parse(request.body);
    const where: string[] = [];
    const params: string[] = [];
    if (input.ids) {
      if (!input.ids.length) return { accounts: [] };
      where.push(`a.id IN (${input.ids.map(() => '?').join(',')})`);
      params.push(...input.ids);
    }
    if (input.email) {
      where.push('a.email LIKE ?');
      params.push(`%${likeEscape(input.email)}%`);
    }
    if (input.status) {
      where.push('a.status = ?');
      params.push(input.status);
    }
    if (input.staff) where.push("a.role <> 'user'");
    if (input.before) {
      where.push('a.id < ?');
      params.push(input.before);
    }
    const rows = await db.query<AccountListRow>(
      `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${input.limit}`,
      params,
    );
    return { accounts: rows.map(accountView) };
  });

  app.get('/internal/admin/accounts/:userId', internal, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const row = await db.one<AccountListRow>(`${LIST_SQL} WHERE a.id = ?`, [userId]);
    if (!row) throw new AppError('not_found', 'Account not found.');
    const devices = await db.query<{ id: string; name: string; platform: string; created_at: Date; last_active_at: Date; revoked_at: Date | null }>(
      'SELECT id, name, platform, created_at, last_active_at, revoked_at FROM devices WHERE account_id = ? ORDER BY revoked_at IS NULL DESC, last_active_at DESC LIMIT 30',
      [userId],
    );
    return {
      account: accountView(row),
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        createdAt: d.created_at.toISOString(),
        lastActiveAt: d.last_active_at.toISOString(),
        revokedAt: d.revoked_at?.toISOString() ?? null,
      })),
    };
  });

  /** Current role and status, so the admin service never trusts a role that changed after the token was issued. */
  app.get('/internal/admin/accounts/:userId/access', internal, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const row = await db.one<{ role: string; status: string }>('SELECT role, status FROM accounts WHERE id = ?', [userId]);
    return { role: row?.role ?? 'user', status: row?.status ?? 'deleted' };
  });

  app.post('/internal/admin/accounts/:userId/role', internal, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { role } = z.object({ role: z.enum(['user', 'moderator', 'admin']) }).parse(request.body);
    await db.tx(async (tx) => {
      const updated = await tx.run("UPDATE accounts SET role = ? WHERE id = ? AND role <> 'owner'", [role, userId]);
      if (!updated.affectedRows) throw new AppError('not_found', 'Account not found.');
      await writeOutbox(tx, { id: ids.next(), type: 'account.role_changed', key: userId, payload: { userId, role } });
    });
    return { ok: true };
  });

  /** Signs the account out everywhere (every device must sign in again). */
  app.post('/internal/admin/accounts/:userId/sign-out', internal, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const revoked = await db.tx(async (tx) => {
      const devices = await tx.query<{ id: string }>('SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL FOR UPDATE', [userId]);
      for (const device of devices) await revokeDevice(tx, ids, userId, device.id, 'admin');
      return devices.length;
    });
    return { revoked };
  });

  app.get('/internal/admin/stats', internal, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const start = seriesStart(days);
    const [totals, signups, active, platforms] = await Promise.all([
      db.query<{ status: string; total: string }>('SELECT status, COUNT(*) AS total FROM accounts GROUP BY status'),
      db.query<{ day: string; total: string }>(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM accounts
         WHERE id >= ? AND status <> 'pending_profile' GROUP BY day`,
        [Snowflake.floor(start)],
      ),
      db.one<{ day1: string; day7: string; day30: string }>(
        `SELECT
           COUNT(DISTINCT CASE WHEN last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY THEN account_id END) AS day1,
           COUNT(DISTINCT CASE WHEN last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 7 DAY THEN account_id END) AS day7,
           COUNT(DISTINCT account_id) AS day30
         FROM devices WHERE last_active_at > CURRENT_TIMESTAMP(3) - INTERVAL 30 DAY`,
      ),
      db.query<{ platform: string; total: string }>('SELECT platform, COUNT(*) AS total FROM devices WHERE revoked_at IS NULL GROUP BY platform'),
    ]);
    const byStatus = Object.fromEntries(totals.map((row) => [row.status, Number(row.total)]));
    return {
      accounts: {
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        pending: byStatus.pending_profile ?? 0,
        deleted: byStatus.deleted ?? 0,
      },
      activeUsers: { day: Number(active?.day1 ?? 0), week: Number(active?.day7 ?? 0), month: Number(active?.day30 ?? 0) },
      devices: Object.fromEntries(platforms.map((row) => [row.platform, Number(row.total)])),
      signups: dailySeries(signups, days),
    };
  });
}
