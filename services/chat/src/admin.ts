import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, dailySeries, seriesStart, Snowflake } from '@talkie/core';
import * as contract from '@talkie/contracts';
import type { Context } from './context.ts';

/**
 * Numbers for the admin panel. Message contents are end-to-end encrypted, so only counts and metadata leave here.
 * Ranges use the time-ordered primary keys (Snowflake ids) instead of scanning `created_at`.
 */
export function registerAdminRoutes(app: FastifyInstance, { db, guards }: Context) {
  const internal = { preHandler: guards.requireInternal };

  app.get('/internal/admin/stats', internal, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const from = Snowflake.floor(seriesStart(days));
    const today = Snowflake.floor(seriesStart(1));
    const [conversations, messages, daily, statuses] = await Promise.all([
      db.query<{ kind: string; total: string }>('SELECT kind, COUNT(*) AS total FROM conversations GROUP BY kind'),
      db.one<{ total: string; today: string }>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(id >= ?), 0) AS today FROM messages WHERE kind NOT IN ('system')",
        [today],
      ),
      db.query<{ day: string; total: string }>(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM messages
         WHERE id >= ? AND kind NOT IN ('system') GROUP BY day`,
        [from],
      ),
      db.one<{ live: string }>('SELECT COUNT(*) AS live FROM statuses WHERE expires_at > CURRENT_TIMESTAMP(3)'),
    ]);
    const kinds = Object.fromEntries(conversations.map((row) => [row.kind, Number(row.total)]));
    return {
      directChats: kinds.direct ?? 0,
      groups: kinds.group ?? 0,
      messages: { total: Number(messages?.total ?? 0), today: Number(messages?.today ?? 0) },
      liveStatuses: Number(statuses?.live ?? 0),
      messagesDaily: dailySeries(daily, days),
    };
  });

  /** One person's activity: how many chats and groups they are in and how many messages they sent. */
  app.get('/internal/admin/users/:userId', internal, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const [membership, sent] = await Promise.all([
      db.one<{ direct: string; groups: string; owned: string }>(
        `SELECT COALESCE(SUM(c.kind = 'direct'), 0) AS direct, COALESCE(SUM(c.kind = 'group'), 0) AS \`groups\`,
                COALESCE(SUM(c.kind = 'group' AND cm.role = 'owner'), 0) AS owned
         FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = ? AND cm.left_at IS NULL`,
        [userId],
      ),
      db.one<{ total: string; last: string | null }>(
        "SELECT COUNT(*) AS total, MAX(id) AS last FROM messages WHERE sender_id = ? AND kind <> 'system'",
        [userId],
      ),
    ]);
    return {
      directChats: Number(membership?.direct ?? 0),
      groups: Number(membership?.groups ?? 0),
      groupsOwned: Number(membership?.owned ?? 0),
      messagesSent: Number(sent?.total ?? 0),
      lastMessageAt: sent?.last ? Snowflake.timeOf(sent.last).toISOString() : null,
    };
  });

  /** A group's public facts, for reports about groups. */
  app.get('/internal/admin/groups/:id', internal, async (request) => {
    const { id } = z.object({ id: contract.id }).parse(request.params);
    const group = await db.one<{ name: string; description: string; created_by: string; created_at: Date; members: string }>(
      `SELECT g.name, g.description, c.created_by, c.created_at,
              (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.left_at IS NULL) AS members
       FROM \`groups\` g JOIN conversations c ON c.id = g.conversation_id WHERE g.conversation_id = ?`,
      [id],
    );
    if (!group) throw new AppError('not_found', 'Group not found.');
    return { group: { id, name: group.name, description: group.description, createdBy: group.created_by, createdAt: group.created_at.toISOString(), members: Number(group.members) } };
  });
}
