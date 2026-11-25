import { describe, expect, it } from 'vitest';
import { ipToBuffer, isSnowflake, Snowflake } from '../packages/core/src/index.ts';
import { email, username } from '../packages/contracts/src/index.ts';

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
