import { describe, expect, it } from 'vitest';
import { AppError, baseEnvSchema, createService, ipToBuffer, isSnowflake, Snowflake } from '../packages/core/src/index.ts';
import { email, username } from '../packages/contracts/src/index.ts';
import { installAuth } from '../packages/auth-kit/src/index.ts';
import { toWire, type MessageRow } from '../services/chat/src/context.ts';
import type { Executor } from '../packages/db/src/index.ts';

describe('service request limits', () => {
  it('keeps authenticated internal calls working after the public IP bucket is exhausted', async () => {
    const env = { ...baseEnvSchema.parse({ LOG_LEVEL: 'fatal' }), WORKER_ID: 1 };
    const { app } = await createService({ name: 'limit-test', env, rateLimitPerMinute: 1 });
    const guards = installAuth(app, { verify: async () => { throw new AppError('unauthorized', 'Invalid test token'); } }, env);
    app.get('/public', async () => ({ ok: true }));
    app.get('/internal/dependency', { preHandler: guards.requireInternal }, async () => ({ ok: true }));
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const status = async (path: string, token: string) => {
        const response = await fetch(`${origin}${path}`, { headers: { 'x-internal-token': token } });
        await response.arrayBuffer();
        return response.status;
      };
      expect(await status('/internal/dependency', 'invalid')).toBe(403);
      expect(await status('/public', env.INTERNAL_TOKEN)).toBe(429);
      expect(await status('/internal/dependency', 'invalid')).toBe(429);
      expect(await status('/internal/dependency', env.INTERNAL_TOKEN)).toBe(200);
      expect(await status('/internal/dependency', env.INTERNAL_TOKEN)).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('chat history event JSON', () => {
  it('loads the whole page with driver-decoded events, JSON text and malformed legacy metadata', async () => {
    const event = { type: 'call', actorId: '1', call: { callId: '4', media: 'audio', outcome: 'ended', durationSeconds: 12, joinedIds: ['1', '2'] } } as const;
    const row: MessageRow = {
      id: '1', conversation_id: '4', sender_id: '1', sender_device_id: '0', kind: 'call',
      ciphertext: null, nonce: null, sealed_key: null, wrap_device_id: null, system_event: null,
      reply_to_id: null, forwarded_count: 0, edited_at: null, deleted_at: null, expires_at: null, created_at: new Date(),
    };
    const events = [{ ...event, call: { ...event.call, joinedIds: ['1', '2'] } }, JSON.stringify(event), '{broken', null];
    const rows = events.map((system_event, index) => ({ ...row, id: String(index + 1), system_event }));
    const db = { query: async () => [] } as unknown as Executor;
    expect((await toWire(db, rows, '1')).map((message) => message.systemEvent)).toEqual([event, event, null, null]);
  });
});

describe('Snowflake ids', () => {
  it('are unique and increasing within a burst', () => {
    const ids = new Snowflake(7);
    const list = Array.from({ length: 10_000 }, () => ids.next());
    expect(new Set(list).size).toBe(list.length);
    for (let i = 1; i < list.length; i++) expect(BigInt(list[i]!) > BigInt(list[i - 1]!)).toBe(true);
  });

  it('encode their creation time', () => {
    const before = Date.now();
    const id = new Snowflake(1).next();
    expect(Math.abs(Snowflake.timeOf(id).getTime() - before)).toBeLessThan(50);
    expect(isSnowflake(id)).toBe(true);
    expect(isSnowflake('0123')).toBe(false);
  });
});

describe('ipToBuffer', () => {
  it('packs IPv4, mapped IPv4 and IPv6', () => {
    expect(ipToBuffer('192.168.0.1')?.toString('hex')).toBe('c0a80001');
    expect(ipToBuffer('::ffff:10.0.0.2')?.toString('hex')).toBe('0a000002');
    expect(ipToBuffer('2001:db8::1')?.toString('hex')).toBe('20010db8000000000000000000000001');
    expect(ipToBuffer('not-an-ip')).toBeNull();
  });
});

describe('field rules', () => {
  it('normalizes emails', () => {
    expect(email.parse('  Me@Example.COM ')).toBe('me@example.com');
    expect(email.safeParse('nope').success).toBe(false);
  });

  it('accepts and rejects usernames', () => {
    expect(username.parse('Nahin.Dev')).toBe('nahin.dev');
    for (const bad of ['ab', '.start', 'end.', 'a..b', '1234', 'has space', 'x'.repeat(33)])
      expect(username.safeParse(bad).success, bad).toBe(false);
  });
});

describe('file encryption', () => {
  it('round-trips files of awkward sizes and detects tampering', async () => {
    const e2ee = await import('../packages/e2ee/src/index.ts');
    await e2ee.ready();
    for (const size of [0, 1, e2ee.FILE_CHUNK - 1, e2ee.FILE_CHUNK, e2ee.FILE_CHUNK + 1, 3 * e2ee.FILE_CHUNK + 5]) {
      const plain = new Uint8Array(size).map((_, i) => (i * 31) % 251);
      const sealed = e2ee.encryptBytes(plain);
      expect(sealed.data.length).toBe(e2ee.encryptedSize(size));
      expect(Buffer.from(e2ee.decryptBytes(sealed.data, sealed.key, sealed.header)).equals(Buffer.from(plain))).toBe(true);
    }
    const sealed = e2ee.encryptBytes(new Uint8Array(200_000));
    const tampered = sealed.data.slice();
    tampered[70_000] = tampered[70_000]! ^ 1;
    expect(() => e2ee.decryptBytes(tampered, sealed.key, sealed.header)).toThrow();
    expect(() => e2ee.decryptBytes(sealed.data.subarray(0, e2ee.FILE_CHUNK + e2ee.FILE_CHUNK_OVERHEAD), sealed.key, sealed.header)).toThrow();
  });
});
