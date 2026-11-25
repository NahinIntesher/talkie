// A scripted Talkie user for local testing: signs up (or signs in), starts a chat with `--to <username>`,
// sends a greeting and answers every message it receives — all end-to-end encrypted like a real device.
// Needs DEV_FIXED_OTP in .env and the services running (`npm run dev`).
//   npm run bot -- --to rafiq.ahmed [--name "Nusrat Jahan"] [--email nusrat@example.com]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';
import * as e2ee from '@talkie/e2ee';

const { values: args } = parseArgs({
  options: { to: { type: 'string' }, name: { type: 'string', default: 'Nusrat Jahan' }, email: { type: 'string', default: 'nusrat.bot@example.com' }, username: { type: 'string', default: 'nusrat.bot' } },
});
const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((line) => /^\w+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
const code = env.DEV_FIXED_OTP;
if (!code) throw new Error('Set DEV_FIXED_OTP in .env');

const base = { auth: 'http://127.0.0.1:4101', users: 'http://127.0.0.1:4102', chat: 'http://127.0.0.1:4103' };
let token = '';
async function call<T = any>(url: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(url, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(`${response.status} ${data.error?.message ?? ''}`);
  return data;
}

await e2ee.ready();
const keys = e2ee.generateDeviceKeys();
const device = { name: 'Test bot', platform: 'android', identityKey: keys.publicKey };
const otp = await call(`${base.auth}/auth/otp/request`, { email: args.email, locale: 'en' });
const verified = await call(`${base.auth}/auth/otp/verify`, { challengeId: otp.challengeId, code, device });
const session = verified.status === 'signed_in' ? verified : await call(`${base.auth}/auth/signup`, { signupToken: verified.signupToken, username: args.username, displayName: args.name, device });
token = session.tokens.accessToken;
const me = { userId: session.user.id as string, deviceId: session.deviceId as string };
// A returning bot gets a new device: register this run's key on it.
await call(`${base.auth}/auth/devices/current/identity-key`, { identityKey: keys.publicKey }, 'PUT');
console.log(`Signed in as ${session.user.displayName} (@${session.user.username})`);

const senderKeys = new Map<string, string>();
async function keyOf(deviceId: string) {
  if (!senderKeys.has(deviceId)) {
    const { devices } = await call(`${base.auth}/auth/device-keys/lookup`, { deviceIds: [deviceId] });
    for (const d of devices) senderKeys.set(d.deviceId, d.identityKey);
  }
  return senderKeys.get(deviceId);
}

async function send(conversationId: string, text: string, replyToId?: string) {
  const { devices } = await call(`${base.chat}/chat/conversations/${conversationId}/devices`);
  const sealed = e2ee.seal({ v: 1, text }, keys, devices);
  await call(`${base.chat}/chat/conversations/${conversationId}/messages`, { clientMessageId: e2ee.clientMessageId(), kind: 'text', ...sealed, ...(replyToId ? { replyToId } : {}) });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const socket = io('http://127.0.0.1:4104', { path: '/ws', transports: ['websocket'], auth: { token } });

let conversationId: string | null = null;
if (args.to) {
  const { user } = await call(`${base.users}/users/by-username/${args.to}`);
  await call(`${base.users}/users/me/contacts/${user.id}`, {}, 'PUT');
  conversationId = (await call(`${base.chat}/chat/conversations/direct`, { userId: user.id })).conversation.id;
  socket.emit('typing', { conversationId, active: true });
  await wait(1500);
  await send(conversationId!, `Hi ${user.displayName.split(' ')[0]}! 👋 I'm a test bot. Everything here is end-to-end encrypted.`);
  console.log(`Chat started with @${args.to}`);
  // A status update the target can see.
  const { devices: statusDevices } = await call(`${base.chat}/chat/status/devices`, { userIds: [user.id] });
  const status = e2ee.seal({ v: 1, text: "Testing Talkie status ✨", background: "#8b5cf6", font: 0 }, keys, statusDevices);
  await call(`${base.chat}/chat/status`, { kind: "text", ...status, audience: [user.id] });
  console.log("Posted a status");
}

const seen = new Set<string>();
socket.on('chat:message', async ({ conversationId: cid, messageId, senderId }) => {
  if (senderId === me.userId || seen.has(messageId)) return;
  seen.add(messageId);
  const { message } = await call(`${base.chat}/chat/messages/${messageId}`);
  await call(`${base.chat}/chat/conversations/${cid}/delivered`, { messageId });
  let text = '(could not decrypt)';
  let fileNote = '';
  let pollNote = '';
  try {
    const body = e2ee.open(message, (await keyOf(message.senderDeviceId))!, keys) as e2ee.MessageBody & { attachments?: Array<{ mediaId: string; key: string; header: string; name: string; size: number }>; poll?: { question: string; options: string[] } };
    text = body.text ?? '';
    const file = body.attachments?.[0];
    if (file) {
      const response = await fetch(`http://127.0.0.1:4105/media/files/${file.mediaId}`, { headers: { authorization: `Bearer ${token}` } });
      const plain = e2ee.decryptBytes(new Uint8Array(await response.arrayBuffer()), file.key, file.header);
      fileNote = `${message.kind} “${file.name}” — downloaded and decrypted ${plain.length.toLocaleString()} bytes 🔐`;
    }
    if (body.poll) {
      pollNote = `voted for “${body.poll.options[0]}” 🗳️`;
      await call(`${base.chat}/chat/messages/${messageId}/vote`, { options: [0] }, 'PUT');
    }
  } catch {}
  console.log(`← ${text}`);
  await wait(800);
  await call(`${base.chat}/chat/conversations/${cid}/read`, { messageId });
  socket.emit('typing', { conversationId: cid, active: true });
  await wait(1200 + Math.min(text.length * 30, 2500));
  const reply = fileNote ? `Got your ${fileNote}` : pollNote ? `I ${pollNote}` : /hello|hi|হ্যালো|salam/i.test(text) ? 'Hello! How are you? 😊' : `You said: “${text}” — got it, decrypted on my side 🔐`;
  await send(cid, reply, messageId);
  await call(`${base.chat}/chat/messages/${messageId}/reaction`, { emoji: '👍' }, 'PUT');
  console.log(`→ ${reply}`);
});
socket.on('connect', () => console.log('Listening for messages… (Ctrl+C to stop)'));
