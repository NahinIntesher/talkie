// End-to-end check of Phase 2 against real services and the local database:
// two people sign up, exchange end-to-end encrypted messages, see live events, receipts, edits, deletes,
// reactions and a group. Run with `npm run e2e:chat` (MySQL must be running; ports 4101–4108 free).
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import * as e2ee from '@talkie/e2ee';
import { phase3 } from './e2e-phase3.ts';
import { phase4 } from './e2e-phase4.ts';
import { phase6 } from './e2e-phase6.ts';

const root = resolve(import.meta.dirname, '..');
const services = ['auth', 'users', 'notify', 'chat', 'realtime', 'media', 'meet', 'admin'] as const;
const ports = { auth: 4101, users: 4102, chat: 4103, realtime: 4104, media: 4105, meet: 4106, notify: 4107, admin: 4108 };
const children: ChildProcess[] = [];
/** Becomes the platform owner (admin panel checks). Signs in again on later runs. */
const OWNER_EMAIL = 'boss.e2e@example.com';
const codes = new Map<string, string>();
let failures = 0;

const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${label}\x1b[0m${ok || detail === undefined ? '' : `, ${JSON.stringify(detail)}`}`);
};

function start(name: string) {
  // A development media key: tokens are signed and checked, no media server is needed for these checks.
  const env = { ...process.env, OWNER_EMAILS: OWNER_EMAIL, LOG_LEVEL: 'warn', DEV_LOG_OTP: 'true', LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'e2e-test-secret-that-is-long-enough' } as NodeJS.ProcessEnv;
  delete env.PORT;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: resolve(root, 'services', name), env });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const match of chunk.toString().matchAll(/sign-in code for (\S+): (\d{6})/g)) codes.set(match[1]!, match[2]!);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (!/ExperimentalWarning|trace-warnings|FastifyDeprecation/.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  children.push(child);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 8000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await wait(100);
  }
  return undefined;
}

async function call<T = any>(service: keyof typeof ports, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${ports[service]}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface Person {
  name: string;
  token: string;
  userId: string;
  deviceId: string;
  keys: e2ee.DeviceKeyPair;
  socket?: Socket;
  events: Array<{ event: string; payload: any }>;
}

async function signUp(name: string, email = `${name}.${Date.now()}@example.com`): Promise<Person> {
  const keys = e2ee.generateDeviceKeys();
  const requestCode = () => call('auth', '/auth/otp/request', { body: { email, locale: 'en' } });
  let { status: otpStatus, body: otp } = await requestCode();
  const retryAfter = otp.error?.details?.retryAfterSeconds;
  if (otpStatus === 429 && retryAfter > 0 && retryAfter <= 60) {
    await wait((retryAfter + 1) * 1000);
    ({ status: otpStatus, body: otp } = await requestCode());
  }
  if (!otp.challengeId) throw new Error(`code request for ${name} failed (${otpStatus}): ${JSON.stringify(otp)}`);
  const code = process.env.E2E_EXTERNAL ? process.env.DEV_FIXED_OTP : await until(() => codes.get(email));
  const device = { name: `${name}'s test device`, platform: 'android', identityKey: keys.publicKey };
  const { body: verified } = await call('auth', '/auth/otp/verify', { body: { challengeId: otp.challengeId, code, device } });
  if (verified.status === 'signed_in')
    return { name, token: verified.tokens.accessToken, userId: verified.user.id, deviceId: verified.deviceId, keys, events: [] };
  const username = `${name}_${Date.now().toString(36)}`;
  const { status: signedStatus, body: signed } = await call('auth', '/auth/signup', { body: { signupToken: verified.signupToken, username, displayName: name, device } });
  if (!signed.tokens) throw new Error(`sign-up for ${name} failed (${signedStatus}): ${JSON.stringify(signed)} / verify: ${JSON.stringify(verified)}`);
  return { name, token: signed.tokens.accessToken, userId: signed.user.id, deviceId: signed.deviceId, keys, events: [] };
}

function connect(person: Person) {
  return new Promise<void>((resolveConnect, reject) => {
    // E2E_TRANSPORT=polling checks the long-polling fallback.
    const socket = io(`http://127.0.0.1:${ports.realtime}`, { path: '/ws', transports: [process.env.E2E_TRANSPORT === 'polling' ? 'polling' : 'websocket'], auth: { token: person.token } });
    socket.onAny((event, payload) => person.events.push({ event, payload }));
    socket.on('connect', () => resolveConnect());
    socket.on('connect_error', reject);
    person.socket = socket;
  });
}

async function send(from: Person, conversationId: string, text: string, extra: Record<string, unknown> = {}) {
  const { status, body: list } = await call('chat', `/chat/conversations/${conversationId}/devices`, { token: from.token });
  if (status !== 200) return { status, body: list };
  const sealed = e2ee.seal({ v: 1, text }, from.keys, list.devices);
  return call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: from.token,
    body: { clientMessageId: e2ee.clientMessageId(), kind: 'text', ...sealed, ...extra },
  });
}

async function readAll(reader: Person, conversationId: string, senderKeys: Map<string, string>) {
  const { body } = await call('chat', `/chat/conversations/${conversationId}/messages`, { token: reader.token });
  return (body.messages as any[]).map((m) =>
    m.kind === 'system' ? `[${m.systemEvent.type}]` : m.deletedAt ? '[deleted]' : e2ee.open(m, senderKeys.get(m.senderDeviceId)!, reader.keys).text,
  );
}

async function main() {
  await e2ee.ready();
  // E2E_EXTERNAL=1: test services that are already running (e.g. the cPanel bundle's app.cjs on ports 4101–4108);
  // sign-in codes are then the fixed development code.
  if (!process.env.E2E_EXTERNAL) for (const name of services) start(name);
  const up = await until(async () => {
    const states = await Promise.all(services.map((s) => fetch(`http://127.0.0.1:${ports[s]}/healthz`).then((r) => r.ok).catch(() => false)));
    return states.every(Boolean) ? true : undefined;
  }, 30_000);
  check('all seven services are up', !!up);

  const ayesha = await signUp('ayesha');
  const rafiEmail = `rafi.${Date.now()}@example.com`;
  const rafi = await signUp('rafi', rafiEmail);
  const mim = await signUp('mim');
  check('three people signed up with device keys', !!(ayesha.token && rafi.token && mim.token));
  await Promise.all([ayesha, rafi, mim].map(connect));
  check('all connected to the realtime service', [ayesha, rafi, mim].every((p) => p.socket?.connected));
  const deviceKeys = new Map([ayesha, rafi, mim].map((p) => [p.deviceId, p.keys.publicKey]));

  // Direct chat
  const { body: direct } = await call('chat', '/chat/conversations/direct', { token: ayesha.token, body: { userId: rafi.userId } });
  const conversationId = direct.conversation.id as string;
  const again = await call('chat', '/chat/conversations/direct', { token: rafi.token, body: { userId: ayesha.userId } });
  check('one direct conversation per pair', again.body.conversation.id === conversationId);
  const peer = await call('users', '/users/lookup', { token: ayesha.token, body: { ids: [direct.conversation.peerId] } });
  check('a chat peer resolves to a profile', peer.body.users?.[0]?.displayName === 'rafi', peer.body);
  const username = peer.body.users?.[0]?.username;
  const found = await call('users', `/users/by-username/${username}`, { token: ayesha.token });
  check('exact username search finds the chat peer', found.body.user?.id === rafi.userId, found.body);

  const sent = await send(ayesha, conversationId, 'Hello Rafi 👋, this is encrypted');
  check('message sent', sent.status === 201, sent.body);
  const live = await until(() => rafi.events.find((e) => e.event === 'chat:message' && e.payload.conversationId === conversationId));
  check('Rafi got a live event', !!live);
  const texts = await readAll(rafi, conversationId, deviceKeys);
  check('Rafi decrypts the message', texts.at(-1) === 'Hello Rafi 👋, this is encrypted', texts);
  check('Ayesha can read her own message', (await readAll(ayesha, conversationId, deviceKeys)).at(-1) === 'Hello Rafi 👋, this is encrypted');

  const messageId = sent.body.message.id as string;
  const raw = await call('chat', `/chat/conversations/${conversationId}/messages`, { token: rafi.token });
  check('the server stores only ciphertext', !JSON.stringify(raw.body).includes('Hello Rafi'));
  let mimCannot = false;
  try {
    e2ee.open(raw.body.messages.at(-1), ayesha.keys.publicKey, mim.keys);
  } catch {
    mimCannot = true;
  }
  check('another person’s key cannot open it', mimCannot);
  const outsider = await call('chat', `/chat/conversations/${conversationId}/messages`, { token: mim.token });
  check('outsiders get 404 for the conversation', outsider.status === 404);

  const duplicate = await call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: ayesha.token,
    body: { clientMessageId: 'A'.repeat(26), kind: 'text', ...e2ee.seal({ v: 1, text: 'once' }, ayesha.keys, [{ deviceId: rafi.deviceId, identityKey: rafi.keys.publicKey }, { deviceId: ayesha.deviceId, identityKey: ayesha.keys.publicKey }]) },
  });
  const duplicate2 = await call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: ayesha.token,
    body: { clientMessageId: 'A'.repeat(26), kind: 'text', ...e2ee.seal({ v: 1, text: 'once' }, ayesha.keys, [{ deviceId: rafi.deviceId, identityKey: rafi.keys.publicKey }, { deviceId: ayesha.deviceId, identityKey: ayesha.keys.publicKey }]) },
  });
  check('retrying with the same client id does not duplicate', duplicate.body.message.id === duplicate2.body.message.id);

  const missingKey = await call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: ayesha.token,
    body: { clientMessageId: e2ee.clientMessageId(), kind: 'text', ...e2ee.seal({ v: 1, text: 'x' }, ayesha.keys, [{ deviceId: ayesha.deviceId, identityKey: ayesha.keys.publicKey }]) },
  });
  check('a message not sealed for every device is refused', missingKey.status === 409 && missingKey.body.error.code === 'devices_changed');

  // Receipts
  const { body: before } = await call('chat', `/chat/conversations/${conversationId}/receipts`, { token: ayesha.token });
  check('not read yet', before.receipts.read === '0');
  await call('chat', `/chat/conversations/${conversationId}/read`, { token: rafi.token, body: { messageId: duplicate.body.message.id } });
  const receipt = await until(() => ayesha.events.find((e) => e.event === 'chat:receipt'));
  check('Ayesha gets a live read receipt', !!receipt);
  const { body: after } = await call('chat', `/chat/conversations/${conversationId}/receipts`, { token: ayesha.token });
  check('read tick moves forward', after.receipts.read === duplicate.body.message.id, after);
  const { body: rafiList } = await call('chat', '/chat/conversations', { token: rafi.token });
  check('Rafi’s unread count is 0 after reading', rafiList.conversations[0].unreadCount === 0, rafiList.conversations[0]);

  // Typing and presence
  const presence = await new Promise<any[]>((r) => ayesha.socket!.emit('presence:watch', [rafi.userId], r));
  check('presence: Rafi is online', presence[0]?.online === true, presence);
  rafi.socket!.emit('typing', { conversationId, active: true });
  check('typing indicator reaches Ayesha', !!(await until(() => ayesha.events.find((e) => e.event === 'typing' && e.payload.userId === rafi.userId))));

  // Edit, react, reply, delete
  const { body: devices } = await call('chat', `/chat/conversations/${conversationId}/devices`, { token: ayesha.token });
  const edited = await call('chat', `/chat/messages/${messageId}`, { method: 'PATCH', token: ayesha.token, body: e2ee.seal({ v: 1, text: 'Hello Rafi (edited)' }, ayesha.keys, devices.devices) });
  check('edit within 15 minutes', edited.status === 200 && !!edited.body.message.editedAt, edited.body);
  const react = await call('chat', `/chat/messages/${messageId}/reaction`, { method: 'PUT', token: rafi.token, body: { emoji: '❤️' } });
  check('reaction saved', react.status === 200);
  const reply = await send(rafi, conversationId, 'Got it!', { replyToId: messageId });
  check('reply links to the original', reply.body.message.replyToId === messageId);
  const deleted = await call('chat', `/chat/messages/${reply.body.message.id}?scope=everyone`, { method: 'DELETE', token: rafi.token });
  check('delete for everyone', deleted.status === 200);
  const notMine = await call('chat', `/chat/messages/${messageId}?scope=everyone`, { method: 'DELETE', token: rafi.token });
  check('cannot delete someone else’s message in a direct chat', notMine.status === 403);
  const texts2 = await readAll(rafi, conversationId, deviceKeys);
  check('history shows edit and deleted placeholder', texts2.includes('Hello Rafi (edited)') && texts2.at(-1) === '[deleted]', texts2);

  // Group
  const { status: groupStatus, body: group } = await call('chat', '/chat/groups', { token: ayesha.token, body: { name: 'Weekend trip 🏕️', memberIds: [rafi.userId, mim.userId] } });
  check('group created with members', groupStatus === 201 && group.conversation.group.memberCount === 3, group);
  const groupId = group.conversation.id as string;
  const groupSend = await send(mim, groupId, 'I can bring the tent');
  check('group member sends', groupSend.status === 201);
  const ayeshaTexts = await readAll(ayesha, groupId, deviceKeys);
  check('group members decrypt', ayeshaTexts.at(-1) === 'I can bring the tent', ayeshaTexts);
  check('system lines describe the group', ayeshaTexts[0] === '[group_created]' && ayeshaTexts[1] === '[members_added]', ayeshaTexts);
  const lock = await call('chat', `/chat/groups/${groupId}`, { method: 'PATCH', token: ayesha.token, body: { sendPolicy: 'admins' } });
  check('owner restricts sending to admins', lock.status === 200);
  const blocked = await send(rafi, groupId, 'can I talk?');
  check('members cannot send when only admins may', blocked.status === 403);
  const notAdmin = await call('chat', `/chat/groups/${groupId}/members/${mim.userId}`, { method: 'DELETE', token: rafi.token });
  check('members cannot remove others', notAdmin.status === 403);
  const removed = await call('chat', `/chat/groups/${groupId}/members/${mim.userId}`, { method: 'DELETE', token: ayesha.token });
  check('owner removes a member', removed.status === 200);
  const removedSend = await send(mim, groupId, 'still here?');
  check('removed member can no longer send', removedSend.status === 403);
  const { body: invite } = await call('chat', `/chat/groups/${groupId}/invite-link`, { token: ayesha.token, body: {} });
  const joined = await call('chat', `/chat/invites/${invite.code}/join`, { token: mim.token, body: {} });
  check('invite link lets them rejoin', joined.body.status === 'joined');

  await phase3({ call, check, mediaPort: ports.media }, { ayesha, rafi, mim }, conversationId, groupId, deviceKeys);
  await phase4({ call, check }, { ayesha, rafi, mim }, conversationId, groupId);
  await checkHistory(rafi, rafiEmail, mim, conversationId, messageId, reply.body.message.id, deviceKeys);
  const boss = await signUp('boss', OWNER_EMAIL);
  await phase6({ call, check }, { boss, ayesha, rafi, mim });
  for (const person of [ayesha, rafi, mim]) person.socket?.disconnect();
}

async function checkHistory(source: Person, email: string, outsider: Person, conversationId: string, messageId: string, deletedId: string, known: Map<string, string>) {
  const receiver = await signUp(source.name, email);
  const target = { deviceId: receiver.deviceId, identityKey: receiver.keys.publicKey };
  const { body: original } = await call('chat', `/chat/conversations/${conversationId}/messages`, { token: receiver.token });
  check('a newly linked device initially has ciphertext without the old key', original.messages?.find((m: any) => m.id === messageId)?.sealedKey === null);

  const { body: exportPage } = await call('chat', `/chat/history/transfer?${new URLSearchParams(target)}`, { token: source.token });
  const key = exportPage.keys?.find((entry: any) => entry.messageId === messageId);
  check('only the old device can export its available history', !!key && !exportPage.keys.some((entry: any) => entry.messageId === deletedId), exportPage);
  if (!key) return;
  const secret = e2ee.openSecret(key.sealedKey, known.get(key.keySenderDeviceId)!, source.keys);
  const sealedKey = e2ee.sealSecret(secret, source.keys, [target])[0]!.sealedKey;
  const submit = (token: string, nonce: string) => call('chat', '/chat/history/transfer', { token, body: { target, keys: [{ messageId, nonce, sealedKey }] } });
  check('other accounts cannot transfer keys to this device', (await submit(outsider.token, key.nonce)).status === 403);
  check('a transfer for a different ciphertext version is ignored', (await submit(source.token, 'A'.repeat(32))).body.added === 0);
  check('an authorized transfer stores one wrapper', (await submit(source.token, key.nonce)).body.added === 1);
  check('retrying the transfer is idempotent', (await submit(source.token, key.nonce)).body.added === 0);

  const { body: imported } = await call('chat', `/chat/messages/${messageId}`, { token: receiver.token });
  check('the new device opens old history with its own key', imported.message?.keySenderDeviceId === source.deviceId && e2ee.open(imported.message, source.keys.publicKey, receiver.keys).text === 'Hello Rafi (edited)');
  const { body: unchanged } = await call('chat', `/chat/messages/${messageId}`, { token: source.token });
  check('the original device still opens the original wrapper', !unchanged.message?.keySenderDeviceId && e2ee.open(unchanged.message, known.get(unchanged.message.senderDeviceId)!, source.keys).text === 'Hello Rafi (edited)');
}

main()
  .catch((error) => {
    failures++;
    console.error(error);
  })
  .finally(async () => {
    for (const child of children) child.kill();
    await wait(300);
    console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mAll checks passed\x1b[0m');
    process.exit(failures ? 1 : 0);
  });
