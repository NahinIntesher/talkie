import { isIPv4, isIPv6 } from 'node:net';

/** Packs an IPv4/IPv6 address into 4 or 16 bytes for a VARBINARY(16) column. */
export function ipToBuffer(ip: string | undefined | null): Buffer | null {
  if (!ip) return null;
  const value = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(value)) return Buffer.from(value.split('.').map(Number));
  if (!isIPv6(value)) return null;
  const [head = '', tail = ''] = value.split('::');
  const part = (s: string) => (s ? s.split(':') : []);
  const left = part(head);
  const right = part(tail);
  const groups = value.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || '0', 16), index * 2));
  return out;
}
