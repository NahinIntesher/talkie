import type { Logger } from '@talkie/core';
import type { Database } from '@talkie/db';
import type { BusEvent } from '@talkie/bus';
import type { Fcm, PushMessage } from './fcm.ts';

type Locale = 'bn' | 'en';
interface Profile {
  id: string;
  displayName: string;
  locale: Locale;
}

/** Message previews stay end-to-end encrypted: a notification says who wrote and what kind of message, never the text. */
const words: Record<Locale, Record<string, string> & { text: string; hidden: string; videoCall: string; voiceCall: string; groupCall: string }> = {
  en: {
    text: 'New message',
    image: '📷 Photo',
    video: '🎥 Video',
    voice: '🎤 Voice message',
    audio: '🎵 Audio',
    document: '📄 Document',
    poll: '📊 Poll',
    sticker: 'Sticker',
    location: '📍 Location',
    contact: '👤 Contact',
    hidden: 'New message',
    videoCall: 'Incoming video call',
    voiceCall: 'Incoming voice call',
    groupCall: 'Group call',
  },
  bn: {
    text: 'নতুন মেসেজ',
    image: '📷 ছবি',
    video: '🎥 ভিডিও',
    voice: '🎤 ভয়েস মেসেজ',
    audio: '🎵 অডিও',
    document: '📄 ডকুমেন্ট',
    poll: '📊 পোল',
    sticker: 'স্টিকার',
    location: '📍 লোকেশন',
    contact: '👤 কন্টাক্ট',
    hidden: 'নতুন মেসেজ',
    videoCall: 'ভিডিও কল আসছে',
    voiceCall: 'ভয়েস কল আসছে',
    groupCall: 'গ্রুপ কল',
  },
};

interface Deps {
  /** https://talkie.kodofact.com, where web notifications lead. */
  origin: string;
  db: Database;
  fcm: Fcm;
  log: Logger;
  profiles: (ids: string[]) => Promise<Profile[]>;
  avatar: (senderId: string, recipients: string[]) => Promise<{ avatarUrl: string | null; recipients: string[] }>;
}

interface Preference {
  user_id: string;
  messages: number;
  groups_enabled: number;
  calls: number;
  show_preview: number;
}

export function pushHandlers({ origin, db, fcm, log, profiles, avatar }: Deps) {
  const placeholders = (list: unknown[]) => list.map(() => '?').join(',');

  const preferences = async (userIds: string[]) => {
    const rows = await db.query<Preference>(`SELECT * FROM notification_preferences WHERE user_id IN (${placeholders(userIds)})`, userIds);
    const byUser = new Map(rows.map((row) => [row.user_id, row]));
    // No row: everything on (the defaults).
    return (id: string) => byUser.get(id) ?? { user_id: id, messages: 1, groups_enabled: 1, calls: 1, show_preview: 1 };
  };

  /** Sends to every device of each user; forgets tokens Firebase says are dead. */
  const deliver = async (userIds: string[], build: (userId: string) => PushMessage | null) => {
    if (!userIds.length) return;
    const tokens = await db.query<{ device_id: string; user_id: string; token: string; inline_reply: number; phone_ringtone: number }>(
      `SELECT device_id, user_id, token, inline_reply, phone_ringtone FROM push_tokens WHERE provider = 'fcm' AND user_id IN (${placeholders(userIds)})`,
      userIds,
    );
    await Promise.all(
      tokens.map(async (row) => {
        const message = build(row.user_id);
        if (!message) return;
        if (message.channel === 'calls' && row.phone_ringtone) message.channel = 'incoming_calls';
        message.data = { ...message.data, deviceId: row.device_id, userId: row.user_id };
        const result = await fcm.send(row.token, message, !!row.inline_reply && message.channel === 'messages');
        if (result === 'invalid_token') await db.run('DELETE FROM push_tokens WHERE device_id = ? AND token = ?', [row.device_id, row.token]);
      }),
    );
  };

  return {
    async messageSent(event: BusEvent) {
      const p = event.payload as {
        recipients: string[];
        conversationId: string;
        messageId: string;
        senderId: string;
        kind: string;
        mutedBy?: string[];
        groupName?: string | null;
      };
      if (p.kind === 'system' || p.kind === 'call') return;
      const muted = new Set(p.mutedBy ?? []);
      const targets = p.recipients.filter((id) => id !== p.senderId && !muted.has(id));
      if (!targets.length) return;
      const [people, prefer, photo] = await Promise.all([
        profiles([p.senderId, ...targets]), preferences(targets),
        avatar(p.senderId, targets).catch(() => null),
      ]);
      const photoRecipients = new Set(photo?.recipients);
      const byId = new Map(people.map((person) => [person.id, person]));
      const sender = byId.get(p.senderId)?.displayName ?? 'Talkie';
      const group = p.groupName ?? null;
      await deliver(targets, (userId) => {
        const pref = prefer(userId);
        if (group ? !pref.groups_enabled : !pref.messages) return null;
        const w = words[byId.get(userId)?.locale ?? 'bn'];
        const what = w[p.kind] ?? w.text;
        const preview = !!pref.show_preview;
        return {
          title: preview ? (group ?? sender) : 'Talkie',
          body: preview ? (group ? `${sender}: ${what}` : what) : w.hidden,
          data: {
            type: 'message', conversationId: p.conversationId, messageId: p.messageId, locale: byId.get(userId)?.locale ?? 'bn',
            ...(preview && photo?.avatarUrl && photoRecipients.has(userId) ? { avatarUrl: photo.avatarUrl, senderName: sender } : {}),
          },
          channel: 'messages',
          tag: p.conversationId,
          link: `${origin}/app?c=${p.conversationId}`,
        };
      });
    },

    async callRinging(event: BusEvent) {
      const p = event.payload as { recipients: string[]; callId: string; conversationId: string; initiatorId: string; media: 'audio' | 'video'; group?: boolean };
      const targets = p.recipients.filter((id) => id !== p.initiatorId);
      if (!targets.length) return;
      const [people, prefer] = await Promise.all([profiles([p.initiatorId, ...targets]), preferences(targets)]);
      const byId = new Map(people.map((person) => [person.id, person]));
      const caller = byId.get(p.initiatorId)?.displayName ?? 'Talkie';
      await deliver(targets, (userId) => {
        if (!prefer(userId).calls) return null;
        const w = words[byId.get(userId)?.locale ?? 'bn'];
        return {
          title: caller,
          body: `${p.media === 'video' ? w.videoCall : w.voiceCall}${p.group ? ` · ${w.groupCall}` : ''}`,
          data: { type: 'call', callId: p.callId, conversationId: p.conversationId, media: p.media },
          channel: 'calls',
          tag: p.callId, // same tag as the web app's own call notification, so the browser shows one
          urgent: true,
          link: `${origin}/app`,
          // A ring is useless a minute later.
          ttlSeconds: 45,
        };
      });
    },

    async deviceRevoked(event: BusEvent) {
      const { deviceId } = event.payload as { deviceId: string };
      await db.run('DELETE FROM push_tokens WHERE device_id = ?', [deviceId]);
      log.debug({ deviceId }, 'push token removed for signed-out device');
    },
  };
}
