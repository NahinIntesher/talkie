import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, likeEscape, type Snowflake } from '@talkie/core';
import { caller, type installAuth } from '@talkie/auth-kit';
import { isDuplicate, writeOutbox, type Database, type Executor } from '@talkie/db';
import * as contract from '@talkie/contracts';

type Guards = ReturnType<typeof installAuth>;

interface ProfileRow {
  user_id: string;
  username: string;
  display_name: string;
  about: string;
  avatar_media_id: string | null;
  locale: contract.Locale;
  last_seen_at: Date | null;
  created_at: Date;
}

const PROFILE_COLUMNS = 'user_id, username, display_name, about, avatar_media_id, locale, last_seen_at, created_at';
const DEFAULT_AUDIENCE: Record<contract.PrivacyKey, contract.PrivacyAudience> = {
  last_seen: 'everyone',
  online: 'everyone',
  profile_photo: 'everyone',
  about: 'everyone',
  status: 'contacts',
  groups_add: 'everyone',
};

export function registerRoutes(
  app: FastifyInstance,
  db: Database,
  ids: Snowflake,
  guards: Guards,
  mediaUrl: string,
  ownsAvatar: (ownerId: string, mediaId: string) => Promise<boolean>,
) {
  const avatarUrl = (mediaId: string | null) => (mediaId ? `${mediaUrl}/avatars/${mediaId}` : null);

  const ownView = (row: ProfileRow) => ({
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    about: row.about,
    avatarUrl: avatarUrl(row.avatar_media_id),
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  });

  const privacyOf = async (userId: string) => {
    const rows = await db.query<{ setting_key: contract.PrivacyKey; audience: contract.PrivacyAudience }>(
      'SELECT setting_key, audience FROM privacy_settings WHERE user_id = ?',
      [userId],
    );
    return { ...DEFAULT_AUDIENCE, ...Object.fromEntries(rows.map((row) => [row.setting_key, row.audience])) } as Record<contract.PrivacyKey, contract.PrivacyAudience>;
  };

  /** What `viewerId` may see of `row`, after blocks and the owner's privacy choices. */
  const publicView = async (viewerId: string, row: ProfileRow) => {
    if (viewerId === row.user_id) return { ...ownView(row), lastSeenAt: row.last_seen_at?.toISOString() ?? null, isContact: false, blockedByMe: false };
    const [privacy, relation] = await Promise.all([
      privacyOf(row.user_id),
      db.one<{ in_their_contacts: number; in_my_contacts: number; blocked_by_me: number; blocked_me: number; nickname: string | null }>(
        `SELECT
           EXISTS(SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?) AS in_their_contacts,
           EXISTS(SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?) AS in_my_contacts,
           EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_by_me,
           EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_me,
           (SELECT nickname FROM contacts WHERE owner_id = ? AND contact_id = ?) AS nickname`,
        [row.user_id, viewerId, viewerId, row.user_id, viewerId, row.user_id, row.user_id, viewerId, viewerId, row.user_id],
      ),
    ]);
    const blockedMe = Number(relation?.blocked_me) === 1;
    const allowed = (key: contract.PrivacyKey) =>
      !blockedMe && (privacy[key] === 'everyone' || (privacy[key] === 'contacts' && Number(relation?.in_their_contacts) === 1));
    return {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      nickname: relation?.nickname ?? null,
      about: allowed('about') ? row.about : '',
      avatarUrl: allowed('profile_photo') ? avatarUrl(row.avatar_media_id) : null,
      lastSeenAt: allowed('last_seen') ? row.last_seen_at?.toISOString() ?? null : null,
      showsOnline: allowed('online'),
      createdAt: row.created_at.toISOString(),
      isContact: Number(relation?.in_my_contacts) === 1,
      blockedByMe: Number(relation?.blocked_by_me) === 1,
    };
  };

  const activeProfile = async (userId: string, executor: Executor = db) => {
    const row = await executor.one<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ? AND deleted_at IS NULL`, [userId]);
    if (!row) fail('not_found', 'This person is not on Talkie.');
    return row!;
  };

  const usernameState = async (username: string, selfId?: string) => {
    if (await db.one('SELECT 1 FROM reserved_usernames WHERE username = ?', [username])) return 'reserved' as const;
    const owner = await db.one<{ user_id: string }>('SELECT user_id FROM profiles WHERE username = ?', [username]);
    if (owner && owner.user_id !== selfId) return 'taken' as const;
    return 'available' as const;
  };

  // ───────── Usernames ─────────

  app.get('/users/username-available', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const parsed = contract.usernameCheck.safeParse(request.query);
    if (!parsed.success) return { available: false, reason: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid username' };
    const state = await usernameState(parsed.data.username, request.auth?.userId);
    return { available: state === 'available', reason: state === 'available' ? null : state };
  });

  // ───────── My profile ─────────

  app.get('/users/me', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const row = await activeProfile(auth.userId);
    const settings = await db.one<{ read_receipts: number }>('SELECT read_receipts FROM user_settings WHERE user_id = ?', [auth.userId]);
    return { profile: ownView(row), privacy: await privacyOf(auth.userId), readReceipts: settings ? Number(settings.read_receipts) === 1 : true };
  });

  app.patch('/users/me', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const input = contract.profileUpdate.parse(request.body);
    const username = z.object({ username: contract.username.optional() }).parse(request.body).username;
    const profile = await db.tx(async (tx) => {
      const row = await activeProfile(auth.userId, tx);
      if (username && username !== row.username) {
        if (await tx.one('SELECT 1 FROM reserved_usernames WHERE username = ?', [username])) fail('username_reserved', 'This username is not available.');
      }
      try {
        await tx.run(
          `UPDATE profiles SET display_name = COALESCE(?, display_name), about = COALESCE(?, about),
             locale = COALESCE(?, locale), username = COALESCE(?, username) WHERE user_id = ?`,
          [input.displayName ?? null, input.about ?? null, input.locale ?? null, username ?? null, auth.userId],
        );
      } catch (error) {
        if (isDuplicate(error)) fail('username_taken', 'This username is already taken.');
        throw error;
      }
      const next = await activeProfile(auth.userId, tx);
      await writeOutbox(tx, {
        id: ids.next(),
        type: 'profile.updated',
        key: auth.userId,
        payload: { userId: auth.userId, username: next.username, displayName: next.display_name, avatarMediaId: next.avatar_media_id },
      });
      return next;
    });
    return { profile: ownView(profile) };
  });

  app.put('/users/me/avatar', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { mediaId } = z.object({ mediaId: contract.id.nullable() }).parse(request.body);
    if (mediaId && !(await ownsAvatar(auth.userId, mediaId))) fail('bad_request', 'Upload the photo first.');
    await db.tx(async (tx) => {
      await tx.run('UPDATE profiles SET avatar_media_id = ? WHERE user_id = ? AND deleted_at IS NULL', [mediaId, auth.userId]);
      await writeOutbox(tx, { id: ids.next(), type: 'profile.updated', key: auth.userId, payload: { userId: auth.userId, avatarMediaId: mediaId } });
    });
    return { avatarUrl: avatarUrl(mediaId) };
  });

  app.put('/users/me/privacy', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const input = contract.privacyUpdate.parse(request.body);
    await db.tx(async (tx) => {
      for (const setting of input.settings ?? [])
        await tx.run(
          'INSERT INTO privacy_settings (user_id, setting_key, audience) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE audience = VALUES(audience)',
          [auth.userId, setting.key, setting.audience],
        );
      if (input.readReceipts !== undefined)
        await tx.run('INSERT INTO user_settings (user_id, read_receipts) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_receipts = VALUES(read_receipts)', [
          auth.userId,
          input.readReceipts ? 1 : 0,
        ]);
      const settings = await tx.one<{ read_receipts: number }>('SELECT read_receipts FROM user_settings WHERE user_id = ?', [auth.userId]);
      await writeOutbox(tx, {
        id: ids.next(),
        type: 'privacy.updated',
        key: auth.userId,
        payload: { userId: auth.userId, readReceipts: settings ? Number(settings.read_receipts) === 1 : true },
      });
    });
    return { privacy: await privacyOf(auth.userId) };
  });

  // ───────── Finding people ─────────

  /** Exact username lookup (no public directory, like username-based messengers). */
  app.get('/users/by-username/:username', { preHandler: guards.requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const { username } = z.object({ username: contract.username }).parse(request.params);
    const row = await db.one<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? AND deleted_at IS NULL`, [username]);
    if (!row) fail('not_found', 'No one on Talkie has this username.');
    return { user: await publicView(caller(request).userId, row!) };
  });

  app.get('/users/:userId', { preHandler: guards.requireAuth }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    return { user: await publicView(caller(request).userId, await activeProfile(userId)) };
  });

  /** Profiles for a list of ids (chat list, group members). */
  app.post('/users/lookup', { preHandler: guards.requireAuth }, async (request) => {
    const { ids: userIds } = z.object({ ids: z.array(contract.id).min(1).max(200) }).parse(request.body);
    const rows = await db.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id IN (${userIds.map(() => '?').join(',')}) AND deleted_at IS NULL`,
      userIds,
    );
    const viewer = caller(request).userId;
    return { users: await Promise.all(rows.map((row) => publicView(viewer, row))) };
  });

  // ───────── Contacts ─────────

  app.get('/users/me/contacts', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const rows = await db.query<ProfileRow & { nickname: string | null }>(
      `SELECT ${PROFILE_COLUMNS.split(', ').map((c) => 'p.' + c).join(', ')}, c.nickname
       FROM contacts c JOIN profiles p ON p.user_id = c.contact_id AND p.deleted_at IS NULL
       WHERE c.owner_id = ? ORDER BY COALESCE(c.nickname, p.display_name)`,
      [auth.userId],
    );
    return { contacts: await Promise.all(rows.map((row) => publicView(auth.userId, row))) };
  });

  app.put('/users/me/contacts/:userId', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const { nickname } = z.object({ nickname: contract.displayName.nullable().default(null) }).parse(request.body ?? {});
    if (userId === auth.userId) fail('bad_request', 'You cannot add yourself.');
    await activeProfile(userId);
    await db.run('INSERT INTO contacts (owner_id, contact_id, nickname) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)', [
      auth.userId,
      userId,
      nickname,
    ]);
    return { ok: true };
  });

  app.delete('/users/me/contacts/:userId', { preHandler: guards.requireAuth }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    await db.run('DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?', [caller(request).userId, userId]);
    return { ok: true };
  });

  // ───────── Blocks and reports ─────────

  app.get('/users/me/blocks', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const rows = await db.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS.split(', ').map((c) => 'p.' + c).join(', ')} FROM blocks b
       JOIN profiles p ON p.user_id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
      [auth.userId],
    );
    return { blocked: rows.map((row) => ({ id: row.user_id, username: row.username, displayName: row.display_name, avatarUrl: avatarUrl(row.avatar_media_id) })) };
  });

  app.put('/users/me/blocks/:userId', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    if (userId === auth.userId) fail('bad_request', 'You cannot block yourself.');
    await activeProfile(userId);
    await db.tx(async (tx) => {
      await tx.run('INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [auth.userId, userId]);
      await writeOutbox(tx, { id: ids.next(), type: 'user.blocked', key: auth.userId, payload: { blockerId: auth.userId, blockedId: userId } });
    });
    return { ok: true };
  });

  app.delete('/users/me/blocks/:userId', { preHandler: guards.requireAuth }, async (request) => {
    const auth = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    await db.tx(async (tx) => {
      const removed = await tx.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [auth.userId, userId]);
      if (removed.affectedRows)
        await writeOutbox(tx, { id: ids.next(), type: 'user.unblocked', key: auth.userId, payload: { blockerId: auth.userId, blockedId: userId } });
    });
    return { ok: true };
  });

  app.post('/users/:userId/report', { preHandler: guards.requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request) => {
    const auth = caller(request);
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    const input = contract.userReport.extend({ block: z.boolean().default(false) }).parse(request.body);
    await activeProfile(userId);
    await db.tx(async (tx) => {
      if (input.block) await tx.run('INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [auth.userId, userId]);
      await writeOutbox(tx, {
        id: ids.next(),
        type: 'report.created',
        key: userId,
        payload: { reportId: ids.next(), reporterId: auth.userId, targetType: 'user', targetId: userId, reason: input.reason, note: input.note },
      });
    });
    return { ok: true };
  });

  // ───────── Internal ─────────

  app.post('/internal/notification-avatar', { preHandler: guards.requireInternal }, async (request) => {
    const { senderId, recipients } = z.object({ senderId: contract.id, recipients: z.array(contract.id).min(1).max(500) }).parse(request.body);
    const sender = await activeProfile(senderId);
    if (!sender.avatar_media_id) return { avatarUrl: null, recipients: [] };
    const privacy = await privacyOf(senderId);
    const allowed = await db.query<{ user_id: string }>(
      `SELECT p.user_id FROM profiles p
       WHERE p.user_id IN (${recipients.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = p.user_id)
       AND (? = 'everyone' OR (? = 'contacts' AND EXISTS
           (SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = p.user_id)))`,
      [...recipients, senderId, privacy.profile_photo, privacy.profile_photo, senderId],
    );
    return { avatarUrl: avatarUrl(sender.avatar_media_id), recipients: allowed.map((row) => row.user_id) };
  });

  /** Creates the profile during sign-up. Repeating the same request is safe. */
  app.post('/internal/profiles', { preHandler: guards.requireInternal }, async (request, reply) => {
    const input = z
      .object({ userId: contract.id, username: contract.username, displayName: contract.displayName, locale: contract.locale })
      .parse(request.body);
    const existing = await db.one<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, [input.userId]);
    if (existing) {
      if (existing.username !== input.username) {
        const state = await usernameState(input.username, input.userId);
        if (state !== 'available') fail(state === 'reserved' ? 'username_reserved' : 'username_taken', 'This username is not available.');
        await db.run('UPDATE profiles SET username = ?, display_name = ? WHERE user_id = ?', [input.username, input.displayName, input.userId]);
      }
      return { profile: ownView(await activeProfile(input.userId)) };
    }
    const state = await usernameState(input.username);
    if (state === 'reserved') fail('username_reserved', 'This username is not available.');
    try {
      await db.tx(async (tx) => {
        await tx.run('INSERT INTO profiles (user_id, username, display_name, locale) VALUES (?, ?, ?, ?)', [
          input.userId,
          input.username,
          input.displayName,
          input.locale,
        ]);
        await tx.run('INSERT INTO user_settings (user_id) VALUES (?)', [input.userId]);
      });
    } catch (error) {
      if (isDuplicate(error)) fail('username_taken', 'This username is already taken.');
      throw error;
    }
    reply.status(201);
    return { profile: ownView(await activeProfile(input.userId)) };
  });

  app.get('/internal/profiles/:userId', { preHandler: guards.requireInternal }, async (request) => {
    const { userId } = z.object({ userId: contract.id }).parse(request.params);
    return { profile: ownView(await activeProfile(userId)) };
  });

  /** Which of `userIds` let `viewerId` see when they are online (privacy "online" + blocks). */
  app.post('/internal/presence-visibility', { preHandler: guards.requireInternal }, async (request) => {
    const { viewerId, userIds } = z.object({ viewerId: contract.id, userIds: z.array(contract.id).min(1).max(500) }).parse(request.body);
    const marks = userIds.map(() => '?').join(',');
    const [settings, contactsOf, blocks] = await Promise.all([
      db.query<{ user_id: string; audience: contract.PrivacyAudience }>(
        `SELECT user_id, audience FROM privacy_settings WHERE setting_key = 'online' AND user_id IN (${marks})`,
        userIds,
      ),
      db.query<{ owner_id: string }>(`SELECT owner_id FROM contacts WHERE contact_id = ? AND owner_id IN (${marks})`, [viewerId, ...userIds]),
      db.query<{ other: string }>(
        `SELECT blocked_id AS other FROM blocks WHERE blocker_id = ? AND blocked_id IN (${marks})
         UNION SELECT blocker_id AS other FROM blocks WHERE blocked_id = ? AND blocker_id IN (${marks})`,
        [viewerId, ...userIds, viewerId, ...userIds],
      ),
    ]);
    const audience = new Map(settings.map((row) => [row.user_id, row.audience]));
    const knows = new Set(contactsOf.map((row) => row.owner_id));
    const blocked = new Set(blocks.map((row) => row.other));
    return {
      visible: userIds.filter((id) => {
        if (blocked.has(id)) return false;
        const level = audience.get(id) ?? 'everyone';
        return level === 'everyone' || (level === 'contacts' && knows.has(id));
      }),
    };
  });

  /** Block and privacy facts another service needs before letting `userId` act on `otherIds`. */
  app.post('/internal/relationships', { preHandler: guards.requireInternal }, async (request) => {
    const { userId, otherIds } = z.object({ userId: contract.id, otherIds: z.array(contract.id).min(1).max(1024) }).parse(request.body);
    const marks = otherIds.map(() => '?').join(',');
    const [blocks, groupPrivacy, theirContacts] = await Promise.all([
      db.query<{ blocker_id: string; blocked_id: string }>(
        `SELECT blocker_id, blocked_id FROM blocks WHERE (blocker_id = ? AND blocked_id IN (${marks})) OR (blocked_id = ? AND blocker_id IN (${marks}))`,
        [userId, ...otherIds, userId, ...otherIds],
      ),
      db.query<{ user_id: string; audience: contract.PrivacyAudience }>(
        `SELECT user_id, audience FROM privacy_settings WHERE setting_key = 'groups_add' AND user_id IN (${marks})`,
        otherIds,
      ),
      db.query<{ owner_id: string }>(`SELECT owner_id FROM contacts WHERE contact_id = ? AND owner_id IN (${marks})`, [userId, ...otherIds]),
    ]);
    const audience = new Map(groupPrivacy.map((row) => [row.user_id, row.audience]));
    const knowsMe = new Set(theirContacts.map((row) => row.owner_id));
    return {
      relationships: otherIds.map((otherId) => {
        const level = audience.get(otherId) ?? 'everyone';
        return {
          userId: otherId,
          blocked: blocks.some((b) => (b.blocker_id === userId && b.blocked_id === otherId) || (b.blocker_id === otherId && b.blocked_id === userId)),
          canAddToGroup: level === 'everyone' || (level === 'contacts' && knowsMe.has(otherId)),
        };
      }),
    };
  });

  // ───────── Internal: admin panel ─────────

  /** Profile summaries (including deleted ones) for the admin panel. */
  app.post('/internal/admin/profiles', { preHandler: guards.requireInternal }, async (request) => {
    const { ids } = z.object({ ids: z.array(contract.id).max(500) }).parse(request.body);
    if (!ids.length) return { profiles: [] };
    const rows = await db.query<ProfileRow & { deleted_at: Date | null }>(
      `SELECT ${PROFILE_COLUMNS}, deleted_at FROM profiles WHERE user_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    return {
      profiles: rows.map((row) => ({
        ...ownView(row),
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        deletedAt: row.deleted_at?.toISOString() ?? null,
      })),
    };
  });

  /** Ids of people whose username starts with, or whose name contains, `q`. */
  app.get('/internal/admin/profiles/search', { preHandler: guards.requireInternal }, async (request) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(64) }).parse(request.query);
    const term = likeEscape(q.replace(/^@/, '').toLowerCase());
    const rows = await db.query<{ user_id: string }>(
      'SELECT user_id FROM profiles WHERE username LIKE ? OR display_name LIKE ? ORDER BY user_id DESC LIMIT 100',
      [`${term}%`, `%${term}%`],
    );
    return { ids: rows.map((row) => row.user_id) };
  });
}
