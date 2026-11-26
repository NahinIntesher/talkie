// A scripted participant for testing calls and meetings against a real LiveKit server.
// It signs in as the test bot, then:
//   npm run call-bot                      answers incoming calls automatically
//   npm run call-bot -- --call rafiq.ahmed --video   calls that person
//   npm run call-bot -- --meet abc-defg-hij         joins (or asks to join) a meeting
// While connected it sends a 440 Hz tone and a moving colour-bar video, and reports what it receives
// (including whether end-to-end decryption of the other side works).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  VideoStream,
  dispose,
} from '@livekit/rtc-node';
import * as e2ee from '@talkie/e2ee';

const { values: args } = parseArgs({
  options: {
    email: { type: 'string', default: 'nusrat.bot@example.com' },
    username: { type: 'string', default: 'nusrat.bot' },
    name: { type: 'string', default: 'Nusrat Jahan' },
    call: { type: 'string' },
    video: { type: 'boolean', default: false },
    meet: { type: 'string' },
    seconds: { type: 'string', default: '0' },
  },
});

const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((line) => /^\w+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
if (!env.DEV_FIXED_OTP) throw new Error('Set DEV_FIXED_OTP in .env');
const base = { auth: 'http://127.0.0.1:4101', users: 'http://127.0.0.1:4102', chat: 'http://127.0.0.1:4103', meet: 'http://127.0.0.1:4106' };
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
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

// ───── Sign in ─────
await e2ee.ready();
const keys = e2ee.generateDeviceKeys();
const device = { name: 'Call test bot', platform: 'android', identityKey: keys.publicKey };
const otp = await call(`${base.auth}/auth/otp/request`, { email: args.email, locale: 'en' });
const verified = await call(`${base.auth}/auth/otp/verify`, { challengeId: otp.challengeId, code: env.DEV_FIXED_OTP, device });
const session = verified.status === 'signed_in' ? verified : await call(`${base.auth}/auth/signup`, { signupToken: verified.signupToken, username: args.username, displayName: args.name, device });
token = session.tokens.accessToken;
await call(`${base.auth}/auth/devices/current/identity-key`, { identityKey: keys.publicKey }, 'PUT');
log(`signed in as ${session.user.displayName}`);

// ───── Media ─────
let room: Room | null = null;
let timers: NodeJS.Timeout[] = [];

async function connect(url: string, jwt: string, callKey?: string) {
  const started = Date.now();
  const r = new Room();
  room = r;
  r.on(RoomEvent.ParticipantConnected, (p) => log(`→ ${p.name || p.identity} joined the room`));
  r.on(RoomEvent.ParticipantDisconnected, (p) => log(`← ${p.name || p.identity} left the room`));
  r.on(RoomEvent.ParticipantEncryptionStatusChanged, (encrypted, p) => log(`🔐 ${p.identity}: encrypted=${encrypted}`));
  r.on(RoomEvent.EncryptionError, (error: unknown) => log(`🔐 encryption error: ${String(error)}`));
  r.on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
    log(`✓ receiving ${track.kind === TrackKind.KIND_AUDIO ? 'audio' : 'video'} from ${p.name || p.identity}`);
    void measure(track, p.name || p.identity);
  });
  await r.connect(url, jwt, {
    autoSubscribe: true,
    dynacast: true,
    ...(callKey ? { e2ee: { keyProviderOptions: { sharedKey: new TextEncoder().encode(callKey) } } } : {}),
  });
  if (room !== r) return void (await r.disconnect());
  if (callKey) r.e2eeManager?.setEnabled(true);
  log(`connected to ${r.name}${callKey ? ' (end-to-end encrypted)' : ''} in ${Date.now() - started} ms`);
  await publish();
}

/** Counts frames / audio level received, to prove media really flows (and decrypts). */
async function measure(track: any, who: string) {
  let frames = 0;
  let peak = 0;
  const started = Date.now();
  const stream = track.kind === TrackKind.KIND_AUDIO ? new AudioStream(track) : new VideoStream(track);
  const report = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    log(track.kind === TrackKind.KIND_AUDIO ? `  audio from ${who}: ${frames} frames in ${secs}s, peak level ${peak.toFixed(3)}` : `  video from ${who}: ${frames} frames in ${secs}s`);
    peak = 0;
  }, 5000);
  timers.push(report);
  for await (const event of stream as AsyncIterable<any>) {
    frames++;
    const frame = event.frame ?? event;
    if (frame instanceof AudioFrame) for (let i = 0; i < frame.data.length; i += 16) peak = Math.max(peak, Math.abs(frame.data[i]!) / 32768);
  }
  clearInterval(report);
}

async function publish() {
  if (!room?.localParticipant) return;
  // 440 Hz tone, 48 kHz mono, 10 ms frames.
  const audio = new AudioSource(48_000, 1);
  const audioTrack = LocalAudioTrack.createAudioTrack('tone', audio);
  await room.localParticipant.publishTrack(audioTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  let phase = 0;
  const tone = setInterval(() => {
    const samples = new Int16Array(480);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin((phase++ * 2 * Math.PI * 440) / 48_000) * 6000);
    void audio.captureFrame(new AudioFrame(samples, 48_000, 1, 480)).catch(() => {});
  }, 10);
  timers.push(tone);
  // Moving colour bars, 640×360 at 15 fps.
  const width = 640;
  const height = 360;
  const video = new VideoSource(width, height);
  const videoTrack = LocalVideoTrack.createVideoTrack('bars', video);
  await room.localParticipant.publishTrack(videoTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
  const colours = [[91, 91, 247], [139, 92, 246], [236, 72, 153], [14, 165, 233], [16, 185, 129], [245, 158, 11]];
  let tick = 0;
  const frames = setInterval(() => {
    const data = new Uint8Array(width * height * 4);
    const offset = (tick++ * 6) % width;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = colours[Math.floor(((x + offset) % width) / (width / colours.length))]!;
        const i = (y * width + x) * 4;
        data[i] = r!;
        data[i + 1] = g!;
        data[i + 2] = b!;
        data[i + 3] = 255;
      }
    video.captureFrame(new VideoFrame(data, width, height, VideoBufferType.RGBA));
  }, 1000 / 15);
  timers.push(frames);
  log('sending a 440 Hz tone and moving colour bars');
}

async function disconnect(reason: string) {
  timers.forEach(clearInterval);
  timers = [];
  if (room) {
    await room.disconnect();
    room = null;
    log(`left the room (${reason})`);
  }
}

const openKey = async (info: { sealedKey: string | null; keySenderDeviceId: string | null }) => {
  if (!info.sealedKey || !info.keySenderDeviceId) throw new Error('This device was not given the call key');
  const { devices } = await call(`${base.auth}/auth/device-keys/lookup`, { deviceIds: [info.keySenderDeviceId] });
  return e2ee.openSecret(info.sealedKey, devices[0].identityKey, keys);
};

// ───── Signals ─────
const socket = io('http://127.0.0.1:4104', { path: '/ws', transports: ['websocket'], auth: { token } });
let activeCall: string | null = null;

socket.on('call:incoming', async ({ callId }: { callId: string }) => {
  try {
  if (activeCall) return;
  activeCall = callId;
  const { call: info } = await call(`${base.meet}/meet/calls/${callId}`);
  log(`📞 incoming ${info.media} call, answering in 2 s`);
  await new Promise((r) => setTimeout(r, 2000));
  const callKey = await openKey(info);
  const { grant } = await call(`${base.meet}/meet/calls/${callId}/accept`, {});
  log('answered, joining the room…');
  await connect(grant.url, grant.token, callKey);
  } catch (error) {
    log(`could not answer: ${(error as Error).message}`);
    activeCall = null;
  }
});
socket.on('call:ended', async ({ callId, outcome }: { callId: string; outcome: string }) => {
  if (callId !== activeCall) return;
  activeCall = null;
  log(`call ended: ${outcome}`);
  await disconnect('call ended');
});
socket.on('meeting:admission', async ({ code, state }: { code: string; state: string }) => {
  log(`meeting ${code}: ${state}`);
  if (state === 'admitted') {
    const { grant } = await call(`${base.meet}/meet/meetings/${code}/token`, {});
    await connect(grant.url, grant.token);
  }
  if (state === 'removed' || state === 'denied') await disconnect(state);
});
socket.on('meeting:update', async ({ change }: { change: string }) => {
  if (change === 'ended') await disconnect('meeting ended');
});
socket.on('connect', () => log('listening for calls… (Ctrl+C to stop)'));

if (args.call) {
  const { user } = await call(`${base.users}/users/by-username/${args.call}`);
  const { conversation } = await call(`${base.chat}/chat/conversations/direct`, { userId: user.id });
  const { devices } = await call(`${base.chat}/chat/conversations/${conversation.id}/devices`);
  const callKey = e2ee.newCallKey();
  const { call: info, grant } = await call(`${base.meet}/meet/calls`, { conversationId: conversation.id, media: args.video ? 'video' : 'audio', keys: e2ee.sealSecret(callKey, keys, devices) });
  activeCall = info.id;
  log(`📞 calling @${args.call} (${info.state})`);
  if (grant) await connect(grant.url, grant.token, callKey);
}

if (args.meet) {
  const result = await call(`${base.meet}/meet/meetings/${args.meet}/join`, {});
  log(`meeting ${args.meet}: ${result.state}`);
  if (result.state === 'admitted') await connect(result.grant.url, result.grant.token);
}

const stop = async () => {
  if (activeCall) await call(`${base.meet}/meet/calls/${activeCall}/leave`, {}).catch(() => {});
  if (args.meet) await call(`${base.meet}/meet/meetings/${args.meet}/leave`, {}).catch(() => {});
  await disconnect('stopped');
  socket.disconnect();
  await dispose();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
if (Number(args.seconds) > 0) setTimeout(() => void stop(), Number(args.seconds) * 1000);
