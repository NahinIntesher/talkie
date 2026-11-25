import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dailySeries, seriesStart, Snowflake } from '@talkie/core';
import type { Context } from './context.ts';

/** Call and meeting numbers for the admin panel. */
export function registerAdminRoutes(app: FastifyInstance, { db, guards }: Context) {
  app.get('/internal/admin/stats', { preHandler: guards.requireInternal }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }).parse(request.query);
    const from = Snowflake.floor(seriesStart(days));
    const [calls, callsDaily, meetings, sessionsDaily, minutes] = await Promise.all([
      db.one<{ total: string; live: string; video: string }>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(state IN ('ringing','active')), 0) AS live, COALESCE(SUM(media = 'video'), 0) AS video FROM calls",
      ),
      db.query<{ day: string; total: string }>(
        "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM calls WHERE id >= ? GROUP BY day",
        [from],
      ),
      db.one<{ total: string; live: string }>("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'live'), 0) AS live FROM meetings"),
      db.query<{ day: string; total: string }>(
        "SELECT DATE_FORMAT(started_at, '%Y-%m-%d') AS day, COUNT(*) AS total FROM meeting_sessions WHERE id >= ? GROUP BY day",
        [from],
      ),
      db.one<{ calls: string | null; meetings: string | null }>(
        `SELECT
           (SELECT SUM(TIMESTAMPDIFF(SECOND, answered_at, ended_at)) FROM calls WHERE id >= ? AND answered_at IS NOT NULL AND ended_at IS NOT NULL) AS calls,
           (SELECT SUM(TIMESTAMPDIFF(SECOND, started_at, ended_at)) FROM meeting_sessions WHERE id >= ? AND ended_at IS NOT NULL) AS meetings`,
        [from, from],
      ),
    ]);
    return {
      calls: { total: Number(calls?.total ?? 0), live: Number(calls?.live ?? 0), video: Number(calls?.video ?? 0) },
      meetings: { total: Number(meetings?.total ?? 0), live: Number(meetings?.live ?? 0) },
      minutes: { calls: Math.round(Number(minutes?.calls ?? 0) / 60), meetings: Math.round(Number(minutes?.meetings ?? 0) / 60) },
      callsDaily: dailySeries(callsDaily, days),
      meetingsDaily: dailySeries(sessionsDaily, days),
    };
  });
}
