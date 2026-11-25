import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from '@talkie/core';
import { caller, type AuthContext } from '@talkie/auth-kit';
import { isDuplicate, type Executor } from '@talkie/db';
import * as contract from '@talkie/contracts';
import { emit, type Context } from './context.ts';
import type { Sources } from './livekit.ts';

interface MeetingRow {
  id: string;
  code: string;
  title: string;
  description: string;
  host_id: string;
  scheduled_start_at: Date | null;
  scheduled_end_at: Date | null;
  access: 'open' | 'trusted' | 'restricted';
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  created_at: Date;
}
interface ControlsRow {
  host_management: number;
  allow_screen_share: number;
  allow_chat: number;
  allow_reactions: number;
  allow_unmute: number;
  allow_video: number;
  locked: number;
}
interface ParticipantRow {
  id: string;
  session_id: string;
  user_id: string;
  role: 'host' | 'cohost' | 'participant' | 'viewer';
  admission: contract.MeetingParticipantInfo['admission'];
  hand_raised_at: Date | null;
  first_joined_at: Date | null;
  last_joined_at: Date | null;
  last_left_at: Date | null;
  duration_seconds: number;
}
interface SessionRow {
  id: string;
  meeting_id: string;
  room_name: string;
  started_at: Date;
  ended_at: Date | null;
}

const LETTERS = 'abcdefghijkmnopqrstuvwxyz';
const code = () => [3, 4, 3].map((n) => Array.from({ length: n }, () => LETTERS[randomInt(LETTERS.length)]).join('')).join('-');
const codeSchema = z.string().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/, 'Invalid meeting code');

const controlsOf = (row: ControlsRow): contract.MeetingControls => ({
  hostManagement: Number(row.host_management) === 1,
  allowScreenShare: Number(row.allow_screen_share) === 1,
  allowChat: Number(row.allow_chat) === 1,
  allowReactions: Number(row.allow_reactions) === 1,
  allowUnmute: Number(row.allow_unmute) === 1,
  allowVideo: Number(row.allow_video) === 1,
  locked: Number(row.locked) === 1,
});

/** What a participant may send. With host management off, everyone may do everything. */
const sourcesFor = (role: contract.MeetingRole, controls: contract.MeetingControls): Sources =>
  role !== 'participant' || !controls.hostManagement
    ? { camera: true, microphone: true, screen: true, data: true }
    : { camera: controls.allowVideo, microphone: controls.allowUnmute, screen: controls.allowScreenShare, data: controls.allowChat || controls.allowReactions };

/**
 * Meetings (Meet-style): a reusable link, a waiting room, host and co-hosts with controls, in-meeting chat,
 * polls, Q&A, breakout rooms, recording, live streaming and attendance.
 */
export function registerMeetingRoutes(app: FastifyInstance, ctx: Context, hooks: { callRoomFinished?: (room: string) => Promise<void> } = {}) {
  const { db, guards, lk } = ctx;
  const auth = { preHandler: guards.requireAuth };

  const meetingByCode = async (value: string) => {
    const row = await db.one<MeetingRow>('SELECT * FROM meetings WHERE code = ?', [codeSchema.parse(value)]);
    if (!row) fail('not_found', 'There is no meeting with this code.');
    return row!;
  };
  const controls = async (meetingId: string, executor: Executor = db) =>
    controlsOf((await executor.one<ControlsRow>('SELECT * FROM meeting_controls WHERE meeting_id = ?', [meetingId]))!);
  const cohosts = async (meetingId: string) => (await db.query<{ user_id: string }>('SELECT user_id FROM meeting_cohosts WHERE meeting_id = ?', [meetingId])).map((r) => r.user_id);
  const invitees = async (meetingId: string) => (await db.query<{ user_id: string }>('SELECT user_id FROM meeting_invitees WHERE meeting_id = ?', [meetingId])).map((r) => r.user_id);
  const roleOf = async (meeting: MeetingRow, userId: string): Promise<contract.MeetingRole> =>
    meeting.host_id === userId ? 'host' : (await db.one('SELECT 1 FROM meeting_cohosts WHERE meeting_id = ? AND user_id = ?', [meeting.id, userId])) ? 'cohost' : 'participant';
  const requireHost = async (meeting: MeetingRow, me: AuthContext) => {
    const role = await roleOf(meeting, me.userId);
    if (role === 'participant') fail('forbidden', 'Only the host and co-hosts can do this.');
    return role;
  };
  const liveSession = (meetingId: string, executor: Executor = db) =>
    executor.one<SessionRow>('SELECT * FROM meeting_sessions WHERE meeting_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [meetingId]);
  const requireSession = async (meetingId: string) => {
    const session = await liveSession(meetingId);
    if (!session) fail('conflict', 'This meeting is not live.');
    return session!;
  };
  const myParticipant = async (session: SessionRow, me: AuthContext) => {
    const row = await db.one<ParticipantRow>('SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?', [session.id, me.userId]);
    if (!row || row.admission !== 'admitted') fail('forbidden', 'Join the meeting first.');
    return row!;
  };
  /** Everyone who should hear about a change: admitted people plus the hosts. */
  const audience = async (session: SessionRow, meeting: MeetingRow, executor: Executor = db) => {
    const rows = await executor.query<{ user_id: string }>("SELECT user_id FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
    return [...new Set([...rows.map((r) => r.user_id), meeting.host_id, ...(await cohosts(meeting.id))])];
  };
  const signal = async (session: SessionRow, meeting: MeetingRow, change: string, extra: Record<string, unknown> = {}) => {
    await db.tx(async (tx) => emit(tx, ctx, 'meeting.updated', meeting.id, await audience(session, meeting, tx), { meetingId: meeting.id, code: meeting.code, sessionId: session.id, change, ...extra }));
    ctx.relay.kick();
  };

  const info = async (meeting: MeetingRow, me: AuthContext): Promise<contract.MeetingInfo> => {
    const session = await liveSession(meeting.id);
    const [count, recording] = session
      ? await Promise.all([
          db.one<{ total: number }>("SELECT COUNT(*) AS total FROM meeting_participants WHERE session_id = ? AND admission = 'admitted' AND (last_left_at IS NULL OR last_left_at < last_joined_at)", [session.id]),
          db.one<{ kind: 'recording' | 'stream'; started_at: Date }>("SELECT kind, started_at FROM recordings WHERE session_id = ? AND status IN ('starting','active') ORDER BY id DESC LIMIT 1", [session.id]),
        ])
      : [undefined, undefined];
    return {
      id: meeting.id,
      code: meeting.code,
      title: meeting.title,
      description: meeting.description,
      hostId: meeting.host_id,
      scheduledStartAt: meeting.scheduled_start_at?.toISOString() ?? null,
      scheduledEndAt: meeting.scheduled_end_at?.toISOString() ?? null,
      access: meeting.access,
      status: meeting.status,
      controls: await controls(meeting.id),
      cohostIds: await cohosts(meeting.id),
      inviteeIds: await invitees(meeting.id),
      myRole: await roleOf(meeting, me.userId),
      sessionId: session?.id ?? null,
      participantCount: Number(count?.total ?? 0),
      recording: recording ? { kind: recording.kind, startedAt: recording.started_at.toISOString() } : null,
      createdAt: meeting.created_at.toISOString(),
    };
  };

  const token = async (session: SessionRow, meeting: MeetingRow, me: AuthContext, role: contract.MeetingRole, room = session.room_name): Promise<contract.MediaGrant> => ({
    url: lk.url,
    room,
    token: await lk.token({
      room,
      identity: me.userId,
      name: await ctx.services.displayName(me.userId).catch(() => 'Guest'),
      metadata: { userId: me.userId, role, meetingId: meeting.id },
      sources: sourcesFor(role, await controls(meeting.id)),
      admin: role !== 'participant',
    }),
  });

  // ───────── Create, list, read, update ─────────

  app.post('/meet/meetings', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const input = contract.createMeeting.parse(request.body);
    const id = ctx.ids.next();
    for (let attempt = 0; ; attempt++) {
      try {
        await db.tx(async (tx) => {
          await tx.run('INSERT INTO meetings (id, code, title, description, host_id, scheduled_start_at, scheduled_end_at, access) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            id,
            code(),
            input.title,
            input.description,
            me.userId,
            input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
            input.scheduledEndAt ? new Date(input.scheduledEndAt) : null,
            input.access,
          ]);
          await tx.run('INSERT INTO meeting_controls (meeting_id) VALUES (?)', [id]);
          for (const userId of new Set(input.inviteeIds)) if (userId !== me.userId) await tx.run('INSERT INTO meeting_invitees (meeting_id, user_id) VALUES (?, ?)', [id, userId]);
          if (input.inviteeIds.length)
            await emit(tx, ctx, 'meeting.updated', id, input.inviteeIds, { meetingId: id, change: 'invited', hostId: me.userId });
        });
        break;
      } catch (error) {
        if (!isDuplicate(error) || attempt > 3) throw error;
      }
    }
    ctx.relay.kick();
    reply.status(201);
    return { meeting: await info((await db.one<MeetingRow>('SELECT * FROM meetings WHERE id = ?', [id]))!, me) };
  });

  app.get('/meet/meetings', auth, async (request) => {
    const me = caller(request);
    const rows = await db.query<MeetingRow>(
      `SELECT DISTINCT m.* FROM meetings m
       LEFT JOIN meeting_invitees i ON i.meeting_id = m.id AND i.user_id = ?
       LEFT JOIN meeting_cohosts c ON c.meeting_id = m.id AND c.user_id = ?
       WHERE (m.host_id = ? OR i.user_id IS NOT NULL OR c.user_id IS NOT NULL) AND m.status <> 'cancelled'
         AND (m.status = 'live' OR m.scheduled_start_at IS NULL OR m.scheduled_start_at > CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY)
       ORDER BY (m.status = 'live') DESC, COALESCE(m.scheduled_start_at, m.created_at) DESC LIMIT 50`,
      [me.userId, me.userId, me.userId],
    );
    return { meetings: await Promise.all(rows.map((row) => info(row, me))) };
  });

  app.get('/meet/meetings/:code', auth, async (request) => {
    const me = caller(request);
    const { code: value } = z.object({ code: z.string() }).parse(request.params);
    const meeting = await meetingByCode(value);
    return { meeting: await info(meeting, me) };
  });

  app.patch('/meet/meetings/:code', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const input = contract.updateMeeting.parse(request.body);
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE meetings SET title = COALESCE(?, title), description = COALESCE(?, description), access = COALESCE(?, access),
           scheduled_start_at = IF(?, ?, scheduled_start_at), scheduled_end_at = IF(?, ?, scheduled_end_at) WHERE id = ?`,
        [
          input.title ?? null,
          input.description ?? null,
          input.access ?? null,
          input.scheduledStartAt !== undefined ? 1 : 0,
          input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
          input.scheduledEndAt !== undefined ? 1 : 0,
          input.scheduledEndAt ? new Date(input.scheduledEndAt) : null,
          meeting.id,
        ],
      );
      const c = input.controls ?? {};
      const columns: Record<keyof typeof c, string> = {
        hostManagement: 'host_management',
        allowScreenShare: 'allow_screen_share',
        allowChat: 'allow_chat',
        allowReactions: 'allow_reactions',
        allowUnmute: 'allow_unmute',
        allowVideo: 'allow_video',
        locked: 'locked',
      };
      for (const [key, value] of Object.entries(c) as Array<[keyof typeof c, boolean]>)
        await tx.run(`UPDATE meeting_controls SET ${columns[key]} = ? WHERE meeting_id = ?`, [value ? 1 : 0, meeting.id]);
    });
    const session = await liveSession(meeting.id);
    if (session) {
      // Apply the new rules to everyone already in the room.
      if (input.controls) {
        const now = await controls(meeting.id);
        const people = await db.query<ParticipantRow>("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
        for (const person of people) {
          const role = await roleOf(meeting, person.user_id);
          if (role === 'participant') await lk.setPermissions(session.room_name, person.user_id, sourcesFor(role, now));
        }
      }
      await signal(session, meeting, 'settings');
    }
    return { meeting: await info((await db.one<MeetingRow>('SELECT * FROM meetings WHERE id = ?', [meeting.id]))!, me) };
  });

  app.put('/meet/meetings/:code/cohosts/:userId', auth, async (request) => {
    const me = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { cohost } = z.object({ cohost: z.boolean() }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    if (meeting.host_id !== me.userId) fail('forbidden', 'Only the host can choose co-hosts.');
    if (userId === meeting.host_id) fail('bad_request', 'The host is already in charge.');
    if (cohost) await db.run('INSERT IGNORE INTO meeting_cohosts (meeting_id, user_id) VALUES (?, ?)', [meeting.id, userId]);
    else await db.run('DELETE FROM meeting_cohosts WHERE meeting_id = ? AND user_id = ?', [meeting.id, userId]);
    const session = await liveSession(meeting.id);
    if (session) {
      await db.run('UPDATE meeting_participants SET role = ? WHERE session_id = ? AND user_id = ?', [cohost ? 'cohost' : 'participant', session.id, userId]);
      await lk.setPermissions(session.room_name, userId, sourcesFor(cohost ? 'cohost' : 'participant', await controls(meeting.id)));
      await signal(session, meeting, 'roles', { userId });
    }
    return { ok: true };
  });

  app.delete('/meet/meetings/:code', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    if (meeting.host_id !== me.userId) fail('forbidden', 'Only the host can cancel the meeting.');
    if (meeting.status === 'live') fail('conflict', 'End the meeting first.');
    await db.tx(async (tx) => {
      await tx.run("UPDATE meetings SET status = 'cancelled' WHERE id = ?", [meeting.id]);
      await emit(tx, ctx, 'meeting.updated', meeting.id, await invitees(meeting.id), { meetingId: meeting.id, change: 'cancelled' });
    });
    ctx.relay.kick();
    return { ok: true };
  });

  // ───────── Join, admit, leave, end ─────────

  app.post('/meet/meetings/:code/join', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    if (meeting.status === 'cancelled') fail('not_found', 'This meeting was cancelled.');
    if (!lk.configured) fail('unavailable', 'Calls and meetings are not set up on this server yet.');
    const role = await roleOf(meeting, me.userId);
    const invited = role !== 'participant' || !!(await db.one('SELECT 1 FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?', [meeting.id, me.userId]));
    if (meeting.access === 'restricted' && !invited) fail('forbidden', 'Only invited people can join this meeting.');
    const rules = await controls(meeting.id);
    type Outcome = { kind: 'denied' } | { kind: 'admitted' | 'waiting'; session: SessionRow; participantId: string };
    const result = await db.tx(async (tx): Promise<Outcome> => {
      let session = await liveSession(meeting.id, tx);
      if (!session) {
        const sessionId = ctx.ids.next();
        await tx.run('INSERT INTO meeting_sessions (id, meeting_id, room_name) VALUES (?, ?, ?)', [sessionId, meeting.id, `meet-${sessionId}`]);
        await tx.run("UPDATE meetings SET status = 'live' WHERE id = ?", [meeting.id]);
        session = (await tx.one<SessionRow>('SELECT * FROM meeting_sessions WHERE id = ?', [sessionId]))!;
      }
      const existing = await tx.one<ParticipantRow>('SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?', [session.id, me.userId]);
      if (existing && (existing.admission === 'removed' || existing.admission === 'denied') && role === 'participant') return { kind: 'denied' as const };
      const direct = role !== 'participant' || (!rules.locked && (meeting.access === 'open' || invited)) || existing?.admission === 'admitted' || existing?.admission === 'left';
      const admission = direct ? 'admitted' : 'waiting';
      let participantId = existing?.id;
      if (existing)
        await tx.run('UPDATE meeting_participants SET admission = ?, role = ?, last_joined_at = IF(? = \'admitted\', CURRENT_TIMESTAMP(3), last_joined_at), first_joined_at = COALESCE(first_joined_at, IF(? = \'admitted\', CURRENT_TIMESTAMP(3), NULL)) WHERE id = ?', [
          admission,
          role,
          admission,
          admission,
          existing.id,
        ]);
      else {
        participantId = ctx.ids.next();
        await tx.run(
          "INSERT INTO meeting_participants (id, session_id, user_id, role, admission, first_joined_at, last_joined_at) VALUES (?, ?, ?, ?, ?, IF(? = 'admitted', CURRENT_TIMESTAMP(3), NULL), IF(? = 'admitted', CURRENT_TIMESTAMP(3), NULL))",
          [participantId, session.id, me.userId, role, admission, admission, admission],
        );
      }
      const count = await tx.one<{ total: number }>("SELECT COUNT(*) AS total FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
      await tx.run('UPDATE meeting_sessions SET peak_participants = GREATEST(peak_participants, ?) WHERE id = ?', [Number(count?.total ?? 0), session.id]);
      await emit(tx, ctx, 'meeting.updated', meeting.id, await audience(session, meeting, tx), {
        meetingId: meeting.id,
        code: meeting.code,
        sessionId: session.id,
        change: admission === 'waiting' ? 'knock' : 'joined',
        userId: me.userId,
      });
      return { kind: admission, session, participantId: participantId! };
    });
    ctx.relay.kick();
    if (result.kind === 'denied') return { state: 'denied' } satisfies contract.JoinResult;
    if (result.kind === 'waiting') return { state: 'waiting', participantId: result.participantId, sessionId: result.session.id } satisfies contract.JoinResult;
    return { state: 'admitted', participantId: result.participantId, sessionId: result.session.id, role, grant: await token(result.session, meeting, me, role) } satisfies contract.JoinResult;
  });

  /** A waiting person asks again after being admitted (also used to reconnect). */
  app.post('/meet/meetings/:code/token', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const role = await roleOf(meeting, me.userId);
    const breakout = await db.one<{ room_name: string }>(
      'SELECT b.room_name FROM breakout_assignments a JOIN breakout_rooms b ON b.id = a.breakout_room_id WHERE a.participant_id = ? AND b.opened_at IS NOT NULL AND b.closed_at IS NULL',
      [participant.id],
    );
    const { main } = z.object({ main: z.boolean().default(false) }).parse(request.body ?? {});
    return { grant: await token(session, meeting, me, role, !main && breakout ? breakout.room_name : session.room_name), breakout: !main && !!breakout };
  });

  app.get('/meet/meetings/:code/participants', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    if (role === 'participant') await myParticipant(session, me);
    const rows = await db.query<ParticipantRow>(
      `SELECT * FROM meeting_participants WHERE session_id = ? AND admission IN (${role === 'participant' ? "'admitted'" : "'admitted','waiting'"})
       ORDER BY admission = 'waiting' DESC, hand_raised_at IS NULL, hand_raised_at, first_joined_at`,
      [session.id],
    );
    const people: contract.MeetingParticipantInfo[] = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      role: row.role === 'viewer' ? 'participant' : row.role,
      admission: row.admission,
      handRaisedAt: row.hand_raised_at?.toISOString() ?? null,
      joinedAt: row.last_joined_at?.toISOString() ?? null,
    }));
    return { participants: people };
  });

  app.post('/meet/meetings/:code/participants/:participantId/:action', auth, async (request) => {
    const me = caller(request);
    const { participantId, action } = z
      .object({ participantId: contract.id, action: z.enum(['admit', 'deny', 'remove', 'mute', 'stop-video', 'lower-hand']) })
      .parse(request.params);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const target = await db.one<ParticipantRow>('SELECT * FROM meeting_participants WHERE id = ? AND session_id = ?', [participantId, session.id]);
    if (!target) fail('not_found', 'Participant not found.');
    if (target!.user_id === meeting.host_id && action === 'remove') fail('forbidden', 'The host cannot be removed.');
    if (action === 'admit' || action === 'deny') {
      const admission = action === 'admit' ? 'admitted' : 'denied';
      await db.tx(async (tx) => {
        await tx.run("UPDATE meeting_participants SET admission = ?, first_joined_at = IF(? = 'admitted', COALESCE(first_joined_at, CURRENT_TIMESTAMP(3)), first_joined_at), last_joined_at = IF(? = 'admitted', CURRENT_TIMESTAMP(3), last_joined_at) WHERE id = ? AND admission = 'waiting'", [
          admission,
          admission,
          admission,
          participantId,
        ]);
        await emit(tx, ctx, 'meeting.admission', meeting.id, [target!.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: admission });
      });
      ctx.relay.kick();
      await signal(session, meeting, 'participants');
    } else if (action === 'remove') {
      await db.run("UPDATE meeting_participants SET admission = 'removed', last_left_at = CURRENT_TIMESTAMP(3), duration_seconds = duration_seconds + GREATEST(0, TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3))) WHERE id = ?", [participantId]);
      await lk.remove(session.room_name, target!.user_id);
      await db.tx((tx) => emit(tx, ctx, 'meeting.admission', meeting.id, [target!.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: 'removed' }));
      await signal(session, meeting, 'participants');
    } else if (action === 'mute' || action === 'stop-video') {
      await lk.mute(session.room_name, target!.user_id, action === 'mute' ? 'microphone' : 'camera');
      await lk.broadcast(session.room_name, { type: action === 'mute' ? 'muted-by-host' : 'video-stopped-by-host' }, [target!.user_id]);
    } else {
      await db.run('UPDATE meeting_participants SET hand_raised_at = NULL WHERE id = ?', [participantId]);
      await signal(session, meeting, 'hands');
    }
    return { ok: true };
  });

  app.post('/meet/meetings/:code/admit-all', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const waiting = await db.query<{ user_id: string }>("SELECT user_id FROM meeting_participants WHERE session_id = ? AND admission = 'waiting'", [session.id]);
    await db.tx(async (tx) => {
      await tx.run("UPDATE meeting_participants SET admission = 'admitted', first_joined_at = COALESCE(first_joined_at, CURRENT_TIMESTAMP(3)), last_joined_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND admission = 'waiting'", [session.id]);
      for (const person of waiting) await emit(tx, ctx, 'meeting.admission', meeting.id, [person.user_id], { meetingId: meeting.id, code: meeting.code, sessionId: session.id, state: 'admitted' });
    });
    ctx.relay.kick();
    await signal(session, meeting, 'participants');
    return { admitted: waiting.length };
  });

  app.post('/meet/meetings/:code/mute-all', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const people = await db.query<ParticipantRow>("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted' AND user_id <> ?", [session.id, me.userId]);
    await Promise.all(people.map((p) => lk.mute(session.room_name, p.user_id, 'microphone')));
    await lk.broadcast(session.room_name, { type: 'muted-by-host' }, people.map((p) => p.user_id));
    return { muted: people.length };
  });

  app.post('/meet/meetings/:code/hand', auth, async (request) => {
    const me = caller(request);
    const { raised } = z.object({ raised: z.boolean() }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    await db.run(`UPDATE meeting_participants SET hand_raised_at = ${raised ? 'COALESCE(hand_raised_at, CURRENT_TIMESTAMP(3))' : 'NULL'} WHERE id = ?`, [participant.id]);
    await signal(session, meeting, 'hands', { userId: me.userId, raised });
    return { ok: true };
  });

  app.post('/meet/meetings/:code/leave', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await liveSession(meeting.id);
    if (!session) return { ok: true };
    await db.run(
      `UPDATE meeting_participants SET admission = IF(admission = 'admitted', 'left', admission), last_left_at = CURRENT_TIMESTAMP(3),
         duration_seconds = duration_seconds + IF(last_joined_at IS NOT NULL AND (last_left_at IS NULL OR last_left_at < last_joined_at), TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3)), 0),
         hand_raised_at = NULL
       WHERE session_id = ? AND user_id = ?`,
      [session.id, me.userId],
    );
    await signal(session, meeting, 'left', { userId: me.userId });
    return { ok: true };
  });

  const endSession = async (meeting: MeetingRow, session: SessionRow) => {
    await db.tx(async (tx) => {
      const recipients = await audience(session, meeting, tx);
      await tx.run(
        `UPDATE meeting_participants SET duration_seconds = duration_seconds + IF(admission = 'admitted' AND last_joined_at IS NOT NULL AND (last_left_at IS NULL OR last_left_at < last_joined_at), TIMESTAMPDIFF(SECOND, last_joined_at, CURRENT_TIMESTAMP(3)), 0),
           last_left_at = IF(admission = 'admitted', CURRENT_TIMESTAMP(3), last_left_at), admission = IF(admission IN ('admitted','waiting'), 'left', admission)
         WHERE session_id = ?`,
        [session.id],
      );
      await tx.run('UPDATE meeting_sessions SET ended_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND ended_at IS NULL', [session.id]);
      await tx.run('UPDATE breakout_rooms SET closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP(3)) WHERE session_id = ?', [session.id]);
      await tx.run("UPDATE meetings SET status = IF(scheduled_start_at IS NULL, 'ended', 'ended') WHERE id = ?", [meeting.id]);
      await emit(tx, ctx, 'meeting.updated', meeting.id, recipients, { meetingId: meeting.id, code: meeting.code, sessionId: session.id, change: 'ended' });
    });
    ctx.relay.kick();
    const active = await db.query<{ egress_id: string }>("SELECT egress_id FROM recordings WHERE session_id = ? AND status IN ('starting','active')", [session.id]);
    for (const recording of active) await lk.stopEgress(recording.egress_id);
    const breakouts = await db.query<{ room_name: string }>('SELECT room_name FROM breakout_rooms WHERE session_id = ?', [session.id]);
    for (const room of breakouts) await lk.close(room.room_name);
    await lk.close(session.room_name);
  };

  app.post('/meet/meetings/:code/end', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await liveSession(meeting.id);
    if (session) await endSession(meeting, session);
    return { ok: true };
  });

  // ───────── Chat ─────────

  app.get('/meet/meetings/:code/chat', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    if ((await roleOf(meeting, me.userId)) === 'participant') await myParticipant(session, me);
    const rows = await db.query<{ id: string; user_id: string; body: string; created_at: Date }>(
      `SELECT c.id, p.user_id, c.body, c.created_at FROM meeting_chat_messages c JOIN meeting_participants p ON p.id = c.participant_id
       WHERE c.session_id = ? AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 200`,
      [session.id],
    );
    return { messages: rows.reverse().map((r) => ({ id: r.id, userId: r.user_id, body: r.body, createdAt: r.created_at.toISOString() })) };
  });

  app.post('/meet/meetings/:code/chat', { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const { body } = contract.meetingChat.parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const rules = await controls(meeting.id);
    if (rules.hostManagement && !rules.allowChat && (await roleOf(meeting, me.userId)) === 'participant') fail('forbidden', 'The host turned off chat.');
    const id = ctx.ids.next();
    await db.run('INSERT INTO meeting_chat_messages (id, session_id, participant_id, body) VALUES (?, ?, ?, ?)', [id, session.id, participant.id, body]);
    await signal(session, meeting, 'chat', { messageId: id });
    reply.status(201);
    return { message: { id, userId: me.userId, body, createdAt: new Date().toISOString() } };
  });

  // ───────── Polls ─────────

  app.get('/meet/meetings/:code/polls', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    const participant = role === 'participant' ? await myParticipant(session, me) : await db.one<ParticipantRow>('SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?', [session.id, me.userId]);
    const polls = await db.query<{ id: string; question: string; multiple_choice: number; anonymous: number; results_shared: number; status: string }>(
      `SELECT * FROM polls WHERE session_id = ? ${role === 'participant' ? "AND status <> 'draft'" : ''} ORDER BY id DESC`,
      [session.id],
    );
    const result = [];
    for (const poll of polls) {
      const options = await db.query<{ id: string; label: string; ordinal: number }>('SELECT id, label, ordinal FROM poll_options WHERE poll_id = ? ORDER BY ordinal', [poll.id]);
      const votes = await db.query<{ option_id: string; participant_id: string }>('SELECT option_id, participant_id FROM poll_votes WHERE poll_id = ?', [poll.id]);
      const showResults = role !== 'participant' || Number(poll.results_shared) === 1 || poll.status === 'closed';
      result.push({
        id: poll.id,
        question: poll.question,
        multipleChoice: Number(poll.multiple_choice) === 1,
        anonymous: Number(poll.anonymous) === 1,
        status: poll.status,
        options: options.map((o) => ({ id: o.id, label: o.label, votes: showResults ? votes.filter((v) => v.option_id === o.id).length : null })),
        myVotes: participant ? votes.filter((v) => v.participant_id === participant.id).map((v) => v.option_id) : [],
        totalVoters: new Set(votes.map((v) => v.participant_id)).size,
      });
    }
    return { polls: result };
  });

  app.post('/meet/meetings/:code/polls', auth, async (request, reply) => {
    const me = caller(request);
    const input = contract.createMeetingPoll.parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const id = ctx.ids.next();
    await db.tx(async (tx) => {
      await tx.run("INSERT INTO polls (id, session_id, created_by, question, multiple_choice, anonymous, results_shared, status) VALUES (?, ?, ?, ?, ?, ?, 1, 'open')", [
        id,
        session.id,
        participant.id,
        input.question,
        input.multipleChoice ? 1 : 0,
        input.anonymous ? 1 : 0,
      ]);
      for (const [ordinal, label] of input.options.entries()) await tx.run('INSERT INTO poll_options (id, poll_id, ordinal, label) VALUES (?, ?, ?, ?)', [ctx.ids.next(), id, ordinal, label]);
    });
    await signal(session, meeting, 'polls', { pollId: id });
    reply.status(201);
    return { id };
  });

  app.post('/meet/meetings/:code/polls/:pollId/vote', auth, async (request) => {
    const me = caller(request);
    const { pollId } = z.object({ pollId: contract.id }).parse(request.params);
    const { optionIds } = z.object({ optionIds: z.array(contract.id).max(10) }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const poll = await db.one<{ status: string; multiple_choice: number }>('SELECT status, multiple_choice FROM polls WHERE id = ? AND session_id = ?', [pollId, session.id]);
    if (!poll || poll.status !== 'open') fail('conflict', 'This poll is closed.');
    if (Number(poll!.multiple_choice) !== 1 && optionIds.length > 1) fail('bad_request', 'Choose one answer.');
    const valid = (await db.query<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ?', [pollId])).map((o) => o.id);
    if (optionIds.some((o) => !valid.includes(o))) fail('bad_request', 'Choose a valid answer.');
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM poll_votes WHERE poll_id = ? AND participant_id = ?', [pollId, participant.id]);
      for (const optionId of optionIds) await tx.run('INSERT INTO poll_votes (poll_id, option_id, participant_id) VALUES (?, ?, ?)', [pollId, optionId, participant.id]);
    });
    await signal(session, meeting, 'polls', { pollId });
    return { ok: true };
  });

  app.post('/meet/meetings/:code/polls/:pollId/close', auth, async (request) => {
    const me = caller(request);
    const { pollId } = z.object({ pollId: contract.id }).parse(request.params);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    await db.run("UPDATE polls SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND session_id = ?", [pollId, session.id]);
    await signal(session, meeting, 'polls', { pollId });
    return { ok: true };
  });

  // ───────── Q&A ─────────

  app.get('/meet/meetings/:code/questions', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const role = await roleOf(meeting, me.userId);
    const participant = await db.one<ParticipantRow>('SELECT * FROM meeting_participants WHERE session_id = ? AND user_id = ?', [session.id, me.userId]);
    if (role === 'participant' && participant?.admission !== 'admitted') fail('forbidden', 'Join the meeting first.');
    const rows = await db.query<{ id: string; participant_id: string; user_id: string; body: string; anonymous: number; status: string; created_at: Date; votes: number; mine: number }>(
      `SELECT q.id, q.participant_id, p.user_id, q.body, q.anonymous, q.status, q.created_at,
         (SELECT COUNT(*) FROM question_votes v WHERE v.question_id = q.id) AS votes,
         EXISTS(SELECT 1 FROM question_votes v WHERE v.question_id = q.id AND v.participant_id = ?) AS mine
       FROM questions q JOIN meeting_participants p ON p.id = q.participant_id
       WHERE q.session_id = ? ${role === 'participant' ? "AND q.status <> 'hidden'" : ''}
       ORDER BY q.status = 'answered', votes DESC, q.id`,
      [participant?.id ?? '0', session.id],
    );
    return {
      questions: rows.map((r) => ({
        id: r.id,
        userId: Number(r.anonymous) === 1 && r.user_id !== me.userId ? null : r.user_id,
        body: r.body,
        status: r.status,
        votes: Number(r.votes),
        votedByMe: Number(r.mine) === 1,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.post('/meet/meetings/:code/questions', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const me = caller(request);
    const input = contract.askQuestion.parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    const id = ctx.ids.next();
    await db.run('INSERT INTO questions (id, session_id, participant_id, body, anonymous) VALUES (?, ?, ?, ?, ?)', [id, session.id, participant.id, input.body, input.anonymous ? 1 : 0]);
    await signal(session, meeting, 'questions', { questionId: id });
    reply.status(201);
    return { id };
  });

  app.post('/meet/meetings/:code/questions/:questionId/vote', auth, async (request) => {
    const me = caller(request);
    const { questionId } = z.object({ questionId: contract.id }).parse(request.params);
    const { voted } = z.object({ voted: z.boolean() }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const participant = await myParticipant(session, me);
    if (!(await db.one('SELECT 1 FROM questions WHERE id = ? AND session_id = ?', [questionId, session.id]))) fail('not_found', 'Question not found.');
    if (voted) await db.run('INSERT IGNORE INTO question_votes (question_id, participant_id) VALUES (?, ?)', [questionId, participant.id]);
    else await db.run('DELETE FROM question_votes WHERE question_id = ? AND participant_id = ?', [questionId, participant.id]);
    await signal(session, meeting, 'questions', { questionId });
    return { ok: true };
  });

  app.post('/meet/meetings/:code/questions/:questionId/status', auth, async (request) => {
    const me = caller(request);
    const { questionId } = z.object({ questionId: contract.id }).parse(request.params);
    const { status } = z.object({ status: z.enum(['open', 'answered', 'hidden']) }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    await db.run(`UPDATE questions SET status = ?, answered_at = ${status === 'answered' ? 'CURRENT_TIMESTAMP(3)' : 'answered_at'} WHERE id = ? AND session_id = ?`, [status, questionId, session.id]);
    await signal(session, meeting, 'questions', { questionId });
    return { ok: true };
  });

  // ───────── Breakout rooms ─────────

  app.get('/meet/meetings/:code/breakouts', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    const session = await requireSession(meeting.id);
    const rooms = await db.query<{ id: string; name: string; opened_at: Date | null; closes_at: Date | null }>(
      'SELECT id, name, opened_at, closes_at FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL ORDER BY id',
      [session.id],
    );
    const assignments = rooms.length
      ? await db.query<{ breakout_room_id: string; user_id: string }>(
          `SELECT a.breakout_room_id, p.user_id FROM breakout_assignments a JOIN meeting_participants p ON p.id = a.participant_id
           WHERE a.breakout_room_id IN (${rooms.map(() => '?').join(',')})`,
          rooms.map((r) => r.id),
        )
      : [];
    return {
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        openedAt: room.opened_at?.toISOString() ?? null,
        closesAt: room.closes_at?.toISOString() ?? null,
        userIds: assignments.filter((a) => a.breakout_room_id === room.id).map((a) => a.user_id),
      })),
      myRoomId: assignments.find((a) => a.user_id === me.userId)?.breakout_room_id ?? null,
    };
  });

  app.post('/meet/meetings/:code/breakouts', auth, async (request) => {
    const me = caller(request);
    const plan = contract.breakoutPlan.parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const participants = await db.query<ParticipantRow>("SELECT * FROM meeting_participants WHERE session_id = ? AND admission = 'admitted'", [session.id]);
    const byId = new Map(participants.map((p) => [p.id, p]));
    await db.tx(async (tx) => {
      await tx.run('UPDATE breakout_rooms SET closed_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND closed_at IS NULL', [session.id]);
      await tx.run('DELETE a FROM breakout_assignments a JOIN meeting_participants p ON p.id = a.participant_id WHERE p.session_id = ?', [session.id]);
      for (const room of plan.rooms) {
        const roomId = ctx.ids.next();
        await tx.run('INSERT INTO breakout_rooms (id, session_id, name, room_name, opened_at, closes_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?)', [
          roomId,
          session.id,
          room.name,
          `meet-${session.id}-b${roomId}`,
          plan.minutes ? new Date(Date.now() + plan.minutes * 60_000) : null,
        ]);
        for (const participantId of new Set(room.participantIds)) if (byId.has(participantId)) await tx.run('INSERT INTO breakout_assignments (participant_id, breakout_room_id) VALUES (?, ?)', [participantId, roomId]);
      }
    });
    await signal(session, meeting, 'breakouts-open');
    return { ok: true };
  });

  app.delete('/meet/meetings/:code/breakouts', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rooms = await db.query<{ room_name: string }>('SELECT room_name FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL', [session.id]);
    await db.run('UPDATE breakout_rooms SET closed_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND closed_at IS NULL', [session.id]);
    await signal(session, meeting, 'breakouts-closed');
    setTimeout(() => rooms.forEach((room) => void lk.close(room.room_name)), 15_000).unref();
    return { ok: true };
  });

  /** Everyone in breakout rooms gets a message from the host. */
  app.post('/meet/meetings/:code/breakouts/broadcast', auth, async (request) => {
    const me = caller(request);
    const { text } = z.object({ text: z.string().trim().min(1).max(300) }).parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rooms = await db.query<{ room_name: string }>('SELECT room_name FROM breakout_rooms WHERE session_id = ? AND closed_at IS NULL', [session.id]);
    for (const room of rooms) await lk.broadcast(room.room_name, { type: 'host-message', text });
    return { ok: true };
  });

  // ───────── Recording and live streaming ─────────

  app.post('/meet/meetings/:code/recording', auth, async (request) => {
    const me = caller(request);
    const input = z
      .object({ kind: z.enum(['recording', 'stream']), rtmpUrl: z.string().regex(/^rtmps?:\/\/[^\s]+$/, 'Enter the RTMP address from YouTube or Facebook').optional() })
      .parse(request.body);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    if (await db.one("SELECT 1 FROM recordings WHERE session_id = ? AND kind = ? AND status IN ('starting','active')", [session.id, input.kind])) fail('conflict', 'Already running.');
    if (input.kind === 'stream' && !input.rtmpUrl) fail('bad_request', 'Enter the stream address.');
    const egressId = input.kind === 'recording' ? await lk.startRecording(session.room_name, `${meeting.code}-${session.id}`) : await lk.startStream(session.room_name, input.rtmpUrl!);
    await db.run("INSERT INTO recordings (id, session_id, kind, egress_id, status, started_by) VALUES (?, ?, ?, ?, 'active', ?)", [ctx.ids.next(), session.id, input.kind, egressId, me.userId]);
    await signal(session, meeting, 'recording', { kind: input.kind, active: true });
    return { ok: true };
  });

  app.delete('/meet/meetings/:code/recording/:kind', auth, async (request) => {
    const me = caller(request);
    const { kind } = z.object({ kind: z.enum(['recording', 'stream']) }).parse(request.params);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const session = await requireSession(meeting.id);
    const rows = await db.query<{ id: string; egress_id: string }>("SELECT id, egress_id FROM recordings WHERE session_id = ? AND kind = ? AND status IN ('starting','active')", [session.id, kind]);
    for (const row of rows) {
      await lk.stopEgress(row.egress_id);
      await db.run("UPDATE recordings SET status = 'ending' WHERE id = ?", [row.id]);
    }
    await signal(session, meeting, 'recording', { kind, active: false });
    return { ok: true };
  });

  // ───────── Attendance ─────────

  app.get('/meet/meetings/:code/attendance', auth, async (request) => {
    const me = caller(request);
    const meeting = await meetingByCode((request.params as { code: string }).code);
    await requireHost(meeting, me);
    const sessions = await db.query<SessionRow & { peak_participants: number }>('SELECT * FROM meeting_sessions WHERE meeting_id = ? ORDER BY id DESC LIMIT 20', [meeting.id]);
    const result = [];
    for (const session of sessions) {
      const rows = await db.query<ParticipantRow>("SELECT * FROM meeting_participants WHERE session_id = ? AND first_joined_at IS NOT NULL ORDER BY first_joined_at", [session.id]);
      result.push({
        sessionId: session.id,
        startedAt: session.started_at.toISOString(),
        endedAt: session.ended_at?.toISOString() ?? null,
        peak: session.peak_participants,
        people: rows.map((row) => ({
          userId: row.user_id,
          firstJoinedAt: row.first_joined_at!.toISOString(),
          lastLeftAt: row.last_left_at?.toISOString() ?? null,
          minutes: Math.round(
            (row.duration_seconds + (row.admission === 'admitted' && row.last_joined_at && (!row.last_left_at || row.last_left_at < row.last_joined_at) ? (Date.now() - row.last_joined_at.getTime()) / 1000 : 0)) / 60,
          ),
        })),
      });
    }
    return { sessions: result };
  });

  // ───────── Media server webhooks ─────────

  app.post('/meet/livekit/webhook', { config: { rateLimit: false }, bodyLimit: 256 * 1024 }, async (request) => {
    const event = await lk.verifyWebhook(request.body as string, request.headers.authorization);
    const room = event.room?.name ?? '';
    const match = /^meet-(\d+)$/.exec(room);
    if (event.event === 'room_finished' && match) {
      const session = await db.one<SessionRow>('SELECT * FROM meeting_sessions WHERE id = ? AND ended_at IS NULL', [match[1]!]);
      const meeting = session && (await db.one<MeetingRow>('SELECT * FROM meetings WHERE id = ?', [session.meeting_id]));
      if (session && meeting) await endSession(meeting, session);
    }
    if (event.event === 'room_finished' && room.startsWith('call-')) await hooks.callRoomFinished?.(room);
    if (event.event === 'egress_ended' && event.egressInfo)
      await db.run("UPDATE recordings SET status = IF(? = '', 'complete', 'failed'), ended_at = CURRENT_TIMESTAMP(3) WHERE egress_id = ?", [event.egressInfo.error ?? '', event.egressInfo.egressId]);
    return { ok: true };
  });

  return { endSession };
}
