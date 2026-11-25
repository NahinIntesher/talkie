import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, fail, ipToBuffer, type Snowflake } from '@talkie/core';
import type { installAuth } from '@talkie/auth-kit';
import type { Database, Executor } from '@talkie/db';
import * as contract from '@talkie/contracts';
import { rank, type Account, type Clients, type Profile, type Role } from './clients.ts';

type Guards = ReturnType<typeof installAuth>;

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: 'user' | 'group' | 'meeting';
  target_id: string;
  reason: string;
  note: string;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  assigned_to: string | null;
  resolution: string | null;
  action: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

interface AuditRow {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: string | null;
  created_at: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: { userId: string; role: Role };
  }
}

const ACCESS_CACHE_MS = 15_000;

export function registerRoutes(app: FastifyInstance, db: Database, ids: Snowflake, guards: Guards, services: Clients) {
  // ───────── Access ─────────

  // The access token's role can be up to 15 minutes old, so every admin request re-checks the account's current role.
  const accessCache = new Map<string, { role: Role; status: string; at: number }>();
  const currentAccess = async (userId: string) => {
    const cached = accessCache.get(userId);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) return cached;
    const fresh = { ...(await services.auth.access(userId)), at: Date.now() };
    accessCache.set(userId, fresh);
    if (accessCache.size > 1000) accessCache.delete(accessCache.keys().next().value!);
    return fresh;
  };

  const staff = (minimum: Exclude<Role, 'user'>) => ({
    preHandler: async (request: FastifyRequest) => {
      if (!request.auth) throw new AppError('unauthorized', 'Please sign in.');
      const access = await currentAccess(request.auth.userId);
      if (access.status !== 'active' || rank[access.role] < rank[minimum]) throw new AppError('forbidden', 'You do not have access to this.');
      request.staff = { userId: request.auth.userId, role: access.role };
    },
  });
  const me = (request: FastifyRequest) => request.staff!;

  /** Staff may only act on people with a lower role than their own, and never on themselves. */
  const assertCanManage = (actor: { userId: string; role: Role }, target: Account) => {
    if (actor.userId === target.id) fail('forbidden', 'You cannot do this to your own account.');
    if (rank[target.role] >= rank[actor.role]) fail('forbidden', 'This person has the same or a higher role than you.');
  };

  const audit = (tx: Executor, request: FastifyRequest, action: string, targetType: string, targetId: string | null, details?: Record<string, unknown>) =>
    tx.run('INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      ids.next(),
      me(request).userId,
      action,
      targetType,
      targetId,
      details ? JSON.stringify(details) : null,
      ipToBuffer(request.ip),
    ]);

  // ───────── People ─────────

  const person = (account: Account | undefined, profile: Profile | undefined, id: string) => ({
    id,
    email: account?.email ?? null,
    status: account?.status ?? 'deleted',
    role: account?.role ?? 'user',
    createdAt: account?.createdAt ?? profile?.createdAt ?? null,
    lastActiveAt: account?.lastActiveAt ?? null,
    devices: account?.devices ?? 0,
    suspendedReason: account?.suspendedReason ?? null,
    username: profile?.username ?? null,
    displayName: profile?.displayName ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
  });

  /** Short "who is this" cards for ids mentioned in reports and the audit log. */
  const cards = async (userIds: string[]) => {
    const unique = [...new Set(userIds)];
    const profiles = await services.users.profiles(unique).catch(() => [] as Profile[]);
    return Object.fromEntries(profiles.map((p) => [p.id, { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl }]));
  };

  app.get('/admin/me', staff('moderator'), async (request) => ({ userId: me(request).userId, role: me(request).role }));

  app.get('/admin/overview', staff('moderator'), async () => {
    const [accounts, chat, meet, media] = await Promise.allSettled([services.auth.stats(), services.chat.stats(), services.meet.stats(), services.media.stats()]);
    const value = <T>(result: PromiseSettledResult<T>) => (result.status === 'fulfilled' ? result.value : null);
    const reports = await db.query<{ status: string; total: string }>('SELECT status, COUNT(*) AS total FROM reports GROUP BY status');
    const byStatus = Object.fromEntries(reports.map((row) => [row.status, Number(row.total)]));
    return {
      accounts: value(accounts),
      chat: value(chat),
      meet: value(meet),
      media: value(media),
      reports: { open: (byStatus.open ?? 0) + (byStatus.reviewing ?? 0), total: reports.reduce((sum, row) => sum + Number(row.total), 0) },
    };
  });

  app.get('/admin/users', staff('moderator'), async (request) => {
    const query = z
      .object({
        q: z.string().trim().max(254).optional(),
        status: z.enum(['active', 'suspended', 'pending_profile', 'deleted']).optional(),
        staff: z.enum(['true', 'false']).optional(),
        before: contract.id.optional(),
      })
      .parse(request.query);
    const isStaff = query.staff === 'true';
    let accounts: Account[];
    if (query.q) {
      // Search by username/name and by email together.
      const q = query.q.toLowerCase();
      const [byProfile, byEmail] = await Promise.all([
        services.users.search(q),
        services.auth.accounts({ email: q.replace(/^@/, ''), status: query.status, staff: isStaff, limit: 50 }),
      ]);
      const extra = byProfile.filter((id) => !byEmail.some((a) => a.id === id));
      const fromProfiles = extra.length ? await services.auth.accounts({ ids: extra.slice(0, 100), status: query.status, staff: isStaff, limit: 100 }) : [];
      accounts = [...byEmail, ...fromProfiles].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, 100);
    } else {
      accounts = await services.auth.accounts({ status: query.status, staff: isStaff, before: query.before, limit: 50 });
    }
    const profiles = await services.users.profiles(accounts.map((a) => a.id));
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return {
      users: accounts.map((account) => person(account, byId.get(account.id), account.id)),
      next: !query.q && accounts.length === 50 ? accounts.at(-1)!.id : null,
    };
  });

  app.get('/admin/users/:userId', staff('moderator'), async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const [{ account, devices }, profiles, activity, storage] = await Promise.all([
      services.auth.account(userId),
      services.users.profiles([userId]),
      services.chat.user(userId).catch(() => null),
      services.media.user(userId).catch(() => null),
    ]);
    const [against, by] = await Promise.all([
      db.query<ReportRow>("SELECT * FROM reports WHERE target_type = 'user' AND target_id = ? ORDER BY id DESC LIMIT 50", [userId]),
      db.one<{ total: string }>('SELECT COUNT(*) AS total FROM reports WHERE reporter_id = ?', [userId]),
    ]);
    const reporters = await cards(against.map((r) => r.reporter_id));
    return {
      user: { ...person(account, profiles[0], userId), about: profiles[0]?.about ?? '', lastSeenAt: profiles[0]?.lastSeenAt ?? null },
      devices,
      activity,
      storage,
      reportsFiled: Number(by?.total ?? 0),
      reports: against.map((row) => ({ ...reportView(row), reporter: reporters[row.reporter_id] ?? null })),
    };
  });

  const reasonBody = z.object({ reason: z.string().trim().min(1).max(255) });

  app.post('/admin/users/:userId/suspend', staff('moderator'), async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { reason } = reasonBody.parse(request.body);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== 'active') fail('conflict', 'Only an active account can be suspended.');
    await services.auth.setStatus(userId, 'suspended', reason);
    await audit(db, request, 'user.suspend', 'user', userId, { reason });
    return { ok: true };
  });

  app.post('/admin/users/:userId/restore', staff('moderator'), async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== 'suspended') fail('conflict', 'This account is not suspended.');
    await services.auth.setStatus(userId, 'active', '');
    await audit(db, request, 'user.restore', 'user', userId);
    return { ok: true };
  });

  app.post('/admin/users/:userId/sign-out', staff('admin'), async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    const { revoked } = await services.auth.signOut(userId);
    await audit(db, request, 'user.sign_out', 'user', userId, { devices: revoked });
    return { revoked };
  });

  app.put('/admin/users/:userId/role', staff('owner'), async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { role } = z.object({ role: z.enum(['user', 'moderator', 'admin']) }).parse(request.body);
    const { account } = await services.auth.account(userId);
    assertCanManage(me(request), account);
    if (account.status !== 'active') fail('conflict', 'Only an active account can be given a role.');
    if (account.role === role) return { ok: true };
    await services.auth.setRole(userId, role);
    accessCache.delete(userId);
    await audit(db, request, 'user.role', 'user', userId, { from: account.role, to: role });
    return { ok: true };
  });

  // ───────── Reports ─────────

  const reportView = (row: ReportRow) => ({
    id: row.id,
    reporterId: row.reporter_id,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    note: row.note,
    status: row.status,
    assignedTo: row.assigned_to,
    resolution: row.resolution,
    action: row.action,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  });

  app.get('/admin/reports', staff('moderator'), async (request) => {
    const query = z
      .object({ status: z.enum(['open', 'closed', 'all']).default('open'), before: contract.id.optional() })
      .parse(request.query);
    const where: string[] = [];
    const params: string[] = [];
    if (query.status === 'open') where.push("status IN ('open','reviewing')");
    if (query.status === 'closed') where.push("status IN ('actioned','dismissed')");
    if (query.before) {
      where.push('id < ?');
      params.push(query.before);
    }
    const rows = await db.query<ReportRow>(`SELECT * FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 50`, params);
    // How many open reports each reported person has, so repeat offenders stand out.
    const userTargets = [...new Set(rows.filter((r) => r.target_type === 'user').map((r) => r.target_id))];
    const counts = userTargets.length
      ? await db.query<{ target_id: string; total: string }>(
          `SELECT target_id, COUNT(*) AS total FROM reports WHERE target_type = 'user' AND status IN ('open','reviewing')
           AND target_id IN (${userTargets.map(() => '?').join(',')}) GROUP BY target_id`,
          userTargets,
        )
      : [];
    const openCount = new Map(counts.map((c) => [c.target_id, Number(c.total)]));
    const people = await cards([...rows.map((r) => r.reporter_id), ...userTargets, ...rows.flatMap((r) => (r.assigned_to ? [r.assigned_to] : []))]);
    const targetAccounts = userTargets.length ? await services.auth.accounts({ ids: userTargets, limit: 100 }).catch(() => [] as Account[]) : [];
    const statusOf = new Map(targetAccounts.map((a) => [a.id, a.status]));
    const groups = await Promise.all(
      [...new Set(rows.filter((r) => r.target_type === 'group').map((r) => r.target_id))].map((id) => services.chat.group(id).catch(() => null)),
    );
    const groupById = new Map(groups.filter((g) => g !== null).map((g) => [g.id, g]));
    return {
      reports: rows.map((row) => ({
        ...reportView(row),
        reporter: people[row.reporter_id] ?? null,
        assignee: row.assigned_to ? (people[row.assigned_to] ?? null) : null,
        target:
          row.target_type === 'user'
            ? { ...(people[row.target_id] ?? { id: row.target_id }), status: statusOf.get(row.target_id) ?? 'deleted', openReports: openCount.get(row.target_id) ?? 0 }
            : row.target_type === 'group'
              ? { id: row.target_id, name: groupById.get(row.target_id)?.name ?? null, members: groupById.get(row.target_id)?.members ?? 0 }
              : { id: row.target_id },
      })),
      next: rows.length === 50 ? rows.at(-1)!.id : null,
    };
  });

  app.post('/admin/reports/:id', staff('moderator'), async (request) => {
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const input = z
      .object({
        status: z.enum(['reviewing', 'actioned', 'dismissed', 'open']),
        resolution: z.string().trim().max(500).default(''),
        suspend: z.boolean().default(false),
      })
      .parse(request.body);
    const report = await db.one<ReportRow>('SELECT * FROM reports WHERE id = ?', [id]);
    if (!report) fail('not_found', 'Report not found.');
    let action: 'none' | 'suspended' = 'none';
    if (input.suspend) {
      if (report!.target_type !== 'user') fail('bad_request', 'Only people can be suspended.');
      if (input.status !== 'actioned') fail('bad_request', 'Suspending closes the report as actioned.');
      const { account } = await services.auth.account(report!.target_id);
      assertCanManage(me(request), account);
      if (account.status === 'active') {
        await services.auth.setStatus(account.id, 'suspended', input.resolution || `Report: ${report!.reason}`);
        action = 'suspended';
      }
    }
    const closing = input.status === 'actioned' || input.status === 'dismissed';
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE reports SET status = ?, resolution = ?, action = ?, assigned_to = ?, resolved_at = ${closing ? 'CURRENT_TIMESTAMP(3)' : 'NULL'} WHERE id = ?`,
        [input.status, input.resolution || null, closing ? action : null, me(request).userId, id],
      );
      await audit(tx, request, `report.${input.status}`, 'report', id, { resolution: input.resolution || undefined, action });
      if (action === 'suspended') await audit(tx, request, 'user.suspend', 'user', report!.target_id, { reason: input.resolution, reportId: id });
    });
    return { ok: true, action };
  });

  // ───────── Audit log ─────────

  app.get('/admin/audit', staff('admin'), async (request) => {
    const query = z.object({ before: contract.id.optional(), actorId: contract.id.optional() }).parse(request.query);
    const where: string[] = [];
    const params: string[] = [];
    if (query.before) {
      where.push('id < ?');
      params.push(query.before);
    }
    if (query.actorId) {
      where.push('actor_id = ?');
      params.push(query.actorId);
    }
    const rows = await db.query<AuditRow>(
      `SELECT id, actor_id, action, target_type, target_id, details, created_at FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 50`,
      params,
    );
    const people = await cards([...rows.map((r) => r.actor_id), ...rows.filter((r) => r.target_type === 'user' && r.target_id).map((r) => r.target_id!)]);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actor: people[row.actor_id] ?? { id: row.actor_id },
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        target: row.target_type === 'user' && row.target_id ? (people[row.target_id] ?? null) : null,
        details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
        createdAt: row.created_at.toISOString(),
      })),
      next: rows.length === 50 ? rows.at(-1)!.id : null,
    };
  });
}
