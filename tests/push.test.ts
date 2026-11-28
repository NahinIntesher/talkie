import { describe, expect, it } from 'vitest';
import { pushHandlers } from '../services/notify/src/push.ts';
import { sharedTableNames, tableRewriter } from '../packages/core/src/index.ts';
import type { PushMessage, SendResult } from '../services/notify/src/fcm.ts';

/** A stand-in database: push tokens, preferences, and a record of deleted tokens. */
function fakeDb(tokens: Array<{ device_id: string; user_id: string; token: string; phone_ringtone?: number }>, prefs: Array<Record<string, unknown>> = []) {
  const deleted: string[] = [];
  return {
    deleted,
    db: {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('FROM push_tokens')) return tokens.filter((t) => params.includes(t.user_id));
        if (sql.includes('FROM notification_preferences')) return prefs.filter((p) => params.includes(p.user_id));
        return [];
      },
      async run(sql: string, params: unknown[] = []) {
        if (sql.startsWith('DELETE FROM push_tokens')) deleted.push(String(params[0]));
        return { affectedRows: 1 };
      },
      async one() {
        return undefined;
      },
    },
  };
}

function setup(tokens: Parameters<typeof fakeDb>[0], prefs?: Parameters<typeof fakeDb>[1], results: Record<string, SendResult> = {}) {
  const { db, deleted } = fakeDb(tokens, prefs);
  const sent: Array<{ token: string; message: PushMessage }> = [];
  const fcm = {
    projectId: 'test',
    async send(token: string, message: PushMessage): Promise<SendResult> {
      sent.push({ token, message });
      return results[token] ?? 'sent';
    },
  };
  const people = [
    { id: '1', displayName: 'Ayesha', locale: 'en' as const },
    { id: '2', displayName: 'Rafi', locale: 'bn' as const },
    { id: '3', displayName: 'Mim', locale: 'en' as const },
  ];
  const log = { debug() {}, warn() {}, info() {}, error() {} };
  const push = pushHandlers({
    origin: 'https://talkie.test', db: db as never, fcm: fcm as never, log: log as never,
    profiles: async (ids) => people.filter((p) => ids.includes(p.id)),
    avatar: async () => ({ avatarUrl: '/api/media/avatars/42', recipients: ['2', '3'] }),
  });
  return { push, sent, deleted };
}

const event = (type: string, payload: Record<string, unknown>) => ({ id: '9', type, key: 'k', occurredAt: new Date().toISOString(), payload });

describe('push notifications', () => {
  const tokens = [
    { device_id: 'd1', user_id: '1', token: 't-ayesha' },
    { device_id: 'd2', user_id: '2', token: 't-rafi-phone', phone_ringtone: 1 },
    { device_id: 'd3', user_id: '2', token: 't-rafi-tablet' },
    { device_id: 'd4', user_id: '3', token: 't-mim' },
  ];

  it('notify every device of the recipient, never the sender, in the recipient’s language, without message text', async () => {
    const { push, sent } = setup(tokens);
    await push.messageSent(event('message.sent', { recipients: ['1', '2'], conversationId: 'c1', messageId: 'm1', senderId: '1', kind: 'image' }));
    expect(sent.map((s) => s.token).sort()).toEqual(['t-rafi-phone', 't-rafi-tablet']);
    expect(sent[0]!.message).toMatchObject({ title: 'Ayesha', body: '📷 ছবি', channel: 'messages', tag: 'c1', data: { type: 'message', conversationId: 'c1', avatarUrl: '/api/media/avatars/42', senderName: 'Ayesha' } });
  });

  it('skip people who muted the chat and system lines', async () => {
    const { push, sent } = setup(tokens);
    await push.messageSent(event('message.sent', { recipients: ['1', '2', '3'], conversationId: 'g', messageId: 'm', senderId: '1', kind: 'text', mutedBy: ['2'], groupName: 'Trip' }));
    expect(sent.map((s) => s.token)).toEqual(['t-mim']);
    expect(sent[0]!.message).toMatchObject({ title: 'Trip', body: 'Ayesha: New message' });
    await push.messageSent(event('message.sent', { recipients: ['1', '3'], conversationId: 'g', messageId: 'm2', senderId: '1', kind: 'system' }));
    expect(sent).toHaveLength(1);
  });

  it('respect notification switches and hidden previews', async () => {
    const prefs = [
      { user_id: '2', messages: 0, groups_enabled: 1, calls: 1, show_preview: 1 },
      { user_id: '3', messages: 1, groups_enabled: 1, calls: 0, show_preview: 0 },
    ];
    const { push, sent } = setup(tokens, prefs);
    await push.messageSent(event('message.sent', { recipients: ['1', '2', '3'], conversationId: 'c', messageId: 'm', senderId: '1', kind: 'voice' }));
    expect(sent.map((s) => s.token)).toEqual(['t-mim']);
    expect(sent[0]!.message).toMatchObject({ title: 'Talkie', body: 'New message' });
    expect(sent[0]!.message.data).not.toHaveProperty('avatarUrl');
    expect(sent[0]!.message.data).not.toHaveProperty('senderName');
    await push.callRinging(event('call.ringing', { recipients: ['2', '3'], callId: 'k1', conversationId: 'c', initiatorId: '1', media: 'video' }));
    expect(sent.slice(1).map((s) => s.token).sort()).toEqual(['t-rafi-phone', 't-rafi-tablet']);
    expect(sent[1]!.message).toMatchObject({ title: 'Ayesha', body: 'ভিডিও কল আসছে', channel: 'incoming_calls', urgent: true, ttlSeconds: 45 });
    expect(sent[2]!.message.channel).toBe('calls');
  });

  it('forget tokens Firebase no longer knows, and tokens of signed-out devices', async () => {
    const { push, deleted } = setup(tokens, [], { 't-rafi-tablet': 'invalid_token' });
    await push.messageSent(event('message.sent', { recipients: ['1', '2'], conversationId: 'c', messageId: 'm', senderId: '1', kind: 'text' }));
    expect(deleted).toEqual(['d3']);
    await push.deviceRevoked(event('device.revoked', { userId: '3', deviceId: 'd4' }));
    expect(deleted).toEqual(['d3', 'd4']);
  });
});

describe('single-database table names', () => {
  it('rename only the shared tables, as whole words', () => {
    const meet = tableRewriter(sharedTableNames({ DB_SHARED_NAME: 'one' }, 'talkie_meet'));
    expect(meet('CREATE TABLE outbox (KEY ix_outbox_pending (id))')).toBe('CREATE TABLE meet_outbox (KEY ix_outbox_pending (id))');
    expect(meet('SELECT * FROM poll_votes JOIN polls')).toBe('SELECT * FROM meet_poll_votes JOIN polls');
    const chat = tableRewriter(sharedTableNames({ DB_SHARED_NAME: 'one' }, 'talkie_chat'));
    expect(chat('DELETE FROM poll_votes')).toBe('DELETE FROM poll_votes');
    expect(tableRewriter(sharedTableNames({}, 'talkie_chat'))('UPDATE outbox')).toBe('UPDATE outbox');
  });
});

describe('Firebase sender', () => {
  it('signs in with the service account, sends an HTTP v1 message and reports dead tokens', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { createFcm } = await import('../services/notify/src/fcm.ts');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
      if (String(init.body).includes('"dead"')) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      return new Response(JSON.stringify({ name: 'projects/p/messages/1' }));
    }) as typeof fetch;
    try {
      const log = { debug() {}, warn() {}, info() {}, error() {} };
      const fcm = createFcm({ project_id: 'talkie-test', client_email: 'push@talkie-test.iam.gserviceaccount.com', private_key: privateKey }, log as never);
      const message = { title: 'Ayesha', body: 'New message', data: { type: 'message', conversationId: 'c1' }, channel: 'messages' as const, tag: 'c1' };
      expect(await fcm.send('alive', message)).toBe('sent');
      expect(await fcm.send('dead', message)).toBe('invalid_token');
      expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); // access token reused
      const sent = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
      expect(sent.url).toBe('https://fcm.googleapis.com/v1/projects/talkie-test/messages:send');
      expect(sent.auth).toBe('Bearer ya29.test');
      expect(JSON.parse(sent.body).message).toMatchObject({ token: 'alive', notification: { title: 'Ayesha' }, android: { notification: { channel_id: 'messages', tag: 'c1' } } });
      const assertion = new URLSearchParams(calls[0]!.body).get('assertion')!;
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString());
      expect(claims).toMatchObject({ iss: 'push@talkie-test.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
