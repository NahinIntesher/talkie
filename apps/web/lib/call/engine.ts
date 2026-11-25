'use client';

import { create } from 'zustand';
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track, type LocalTrackPublication } from 'livekit-client';
import * as e2ee from '@talkie/e2ee';
import type { CallInfo, DeviceKey, MediaGrant } from '@talkie/contracts';
import { api, ApiError } from '../api';
import { realtime } from '../realtime';
import { deviceKeys, senderKeys } from '../chat/keys';
import { loadProfiles } from '../chat/engine';

export type CallPhase = 'outgoing' | 'connecting' | 'active' | 'reconnecting' | 'ended';

export interface CallSession {
  info: CallInfo;
  phase: CallPhase;
  room: Room | null;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  minimized: boolean;
  /** Why it ended (shown for a moment): declined, busy, no answer… */
  endReason: string | null;
  /** Bumped on every room event so the UI re-reads tracks. */
  version: number;
}

interface CallState {
  enabled: boolean | null;
  session: CallSession | null;
  incoming: CallInfo | null;
}

export const useCall = create<CallState>(() => ({ enabled: null, session: null, incoming: null }));
const set = useCall.setState;
const get = useCall.getState;

// ───────── Tones ─────────

let audio: AudioContext | null = null;
let toneTimer: ReturnType<typeof setInterval> | null = null;

/** Soft two-note ringtone for incoming calls, a quieter ringback while calling out. */
function playTone(kind: 'ring' | 'ringback') {
  stopTone();
  try {
    audio ??= new AudioContext();
    const beep = () => {
      const ctx = audio!;
      const notes = kind === 'ring' ? [659, 880] : [440];
      notes.forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        const start = ctx.currentTime + index * 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(kind === 'ring' ? 0.12 : 0.05, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + (kind === 'ring' ? 0.32 : 1.1));
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 1.2);
      });
    };
    beep();
    toneTimer = setInterval(beep, kind === 'ring' ? 1600 : 3000);
  } catch {}
}

function stopTone() {
  if (toneTimer) clearInterval(toneTimer);
  toneTimer = null;
}

// ───────── Helpers ─────────

export async function callsEnabled(): Promise<boolean> {
  if (get().enabled !== null) return get().enabled!;
  try {
    const { enabled } = await api<{ enabled: boolean }>('/meet/config');
    set({ enabled });
    return enabled;
  } catch {
    return false;
  }
}

const bump = () => set((state) => (state.session ? { session: { ...state.session, version: state.session.version + 1 } } : {}));

const patch = (changes: Partial<CallSession>) => set((state) => (state.session ? { session: { ...state.session, ...changes } } : {}));

async function connect(grant: MediaGrant, callKey: string, video: boolean): Promise<Room> {
  const keyProvider = new ExternalE2EEKeyProvider();
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    e2ee: { keyProvider, worker: new Worker('/livekit-e2ee-worker.mjs', { type: 'module' }) },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
  });
  await keyProvider.setKey(callKey);
  const events = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.ConnectionQualityChanged,
  ];
  for (const event of events) room.on(event, bump);
  room.on(RoomEvent.ParticipantConnected, () => {
    stopTone();
    const session = get().session;
    if (session && session.phase !== 'active') patch({ phase: 'active' });
  });
  room.on(RoomEvent.Reconnecting, () => patch({ phase: 'reconnecting' }));
  room.on(RoomEvent.Reconnected, () => patch({ phase: 'active' }));
  room.on(RoomEvent.Disconnected, () => {
    const session = get().session;
    if (session && session.phase !== 'ended') void hangUp('disconnected');
  });
  await room.setE2EEEnabled(true);
  await room.connect(grant.url, grant.token);
  // The call is live as soon as the room connects; the microphone and camera start alongside (a permission
  // prompt or a missing device must not hold up hearing and seeing the other person).
  void (async () => {
    await room.localParticipant.setMicrophoneEnabled(true).catch(() => patch({ micOn: false }));
    if (video) await room.localParticipant.setCameraEnabled(true).catch(() => patch({ camOn: false }));
    bump();
  })();
  if (room.remoteParticipants.size) stopTone();
  return room;
}

function friendly(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if ((error as Error)?.name === 'NotAllowedError') return 'Allow camera and microphone access to call.';
  return 'The call could not connect.';
}

// ───────── Outgoing ─────────

export async function startCall(conversationId: string, media: 'audio' | 'video'): Promise<string | null> {
  if (get().session) return 'You are already on a call.';
  if (!(await callsEnabled())) return 'Calls are not set up on this server yet.';
  const keys = deviceKeys();
  if (!keys) return 'Your encryption keys are not ready yet.';
  try {
    const callKey = e2ee.newCallKey();
    const { devices } = await api<{ devices: DeviceKey[] }>(`/chat/conversations/${conversationId}/devices`);
    const recipients = [...devices, { deviceId: keys.deviceId, identityKey: keys.pair.publicKey, userId: '' }];
    const { call, grant } = await api<{ call: CallInfo; grant: MediaGrant | null }>('/meet/calls', {
      method: 'POST',
      body: { conversationId, media, keys: e2ee.sealSecret(callKey, keys.pair, recipients) },
    });
    void loadProfiles(call.participants.map((p) => p.userId));
    set({ session: { info: call, phase: 'outgoing', room: null, micOn: true, camOn: media === 'video', screenOn: false, minimized: false, endReason: null, version: 0 } });
    if (call.state === 'busy' || !grant) {
      finishLocally('busy');
      return null;
    }
    const joinedExisting = call.state === 'active';
    if (!joinedExisting) playTone('ringback');
    const room = await connect(grant, joinedExisting ? await keyFor(call) : callKey, media === 'video');
    patch({ room, phase: joinedExisting ? 'active' : 'outgoing' });
    return null;
  } catch (error) {
    stopTone();
    set({ session: null });
    return friendly(error);
  }
}

async function keyFor(call: CallInfo): Promise<string> {
  const keys = deviceKeys();
  if (!call.sealedKey || !call.keySenderDeviceId || !keys) throw new Error('This device cannot decrypt the call.');
  const known = await senderKeys([call.keySenderDeviceId]);
  return e2ee.openSecret(call.sealedKey, known.get(call.keySenderDeviceId)!, keys.pair);
}

// ───────── Incoming ─────────

export async function accept(media: 'audio' | 'video') {
  const incoming = get().incoming;
  if (!incoming) return;
  stopTone();
  set({ incoming: null });
  try {
    const callKey = await keyFor(incoming);
    const { call, grant } = await api<{ call: CallInfo; grant: MediaGrant }>(`/meet/calls/${incoming.id}/accept`, { method: 'POST', body: {} });
    set({ session: { info: call, phase: 'connecting', room: null, micOn: true, camOn: media === 'video', screenOn: false, minimized: false, endReason: null, version: 0 } });
    const room = await connect(grant, callKey, media === 'video');
    patch({ room, phase: 'active' });
  } catch (error) {
    set({ session: null });
    alert(friendly(error));
  }
}

export async function decline() {
  const incoming = get().incoming;
  stopTone();
  set({ incoming: null });
  if (incoming) await api(`/meet/calls/${incoming.id}/decline`, { method: 'POST', body: {} }).catch(() => {});
}

/** Join a group call that is already going on in a chat. */
export async function joinGroupCall(callId: string) {
  if (get().session) return;
  const { call } = await api<{ call: CallInfo }>(`/meet/calls/${callId}`);
  const { grant, call: joined } = await api<{ call: CallInfo; grant: MediaGrant }>(`/meet/calls/${callId}/join`, { method: 'POST', body: {} });
  set({ session: { info: joined, phase: 'connecting', room: null, micOn: true, camOn: false, screenOn: false, minimized: false, endReason: null, version: 0 } });
  const room = await connect(grant, await keyFor(call), false);
  patch({ room, phase: 'active' });
}

// ───────── During the call ─────────

export async function toggleMic() {
  const session = get().session;
  if (!session?.room) return;
  const next = !session.micOn;
  await session.room.localParticipant.setMicrophoneEnabled(next);
  patch({ micOn: next });
}

export async function toggleCamera() {
  const session = get().session;
  if (!session?.room) return;
  const next = !session.camOn;
  try {
    await session.room.localParticipant.setCameraEnabled(next);
    patch({ camOn: next });
  } catch {
    patch({ camOn: false });
  }
}

export async function toggleScreen() {
  const session = get().session;
  if (!session?.room) return;
  const next = !session.screenOn;
  try {
    const publication = (await session.room.localParticipant.setScreenShareEnabled(next, { audio: true })) as LocalTrackPublication | undefined;
    publication?.track?.once('ended', () => patch({ screenOn: false }));
    patch({ screenOn: next });
  } catch {
    patch({ screenOn: false });
  }
}

export async function switchCamera() {
  const session = get().session;
  const track = session?.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  if (!track) return;
  const devices = await Room.getLocalDevices('videoinput');
  if (devices.length < 2) return;
  const current = track.mediaStreamTrack.getSettings().deviceId;
  const next = devices[(devices.findIndex((d) => d.deviceId === current) + 1) % devices.length]!;
  await session!.room!.switchActiveDevice('videoinput', next.deviceId);
}

export const setMinimized = (minimized: boolean) => patch({ minimized });

function finishLocally(reason: string) {
  stopTone();
  const session = get().session;
  session?.room?.disconnect();
  if (!session) return;
  patch({ phase: 'ended', endReason: reason, room: null });
  setTimeout(() => {
    if (get().session?.phase === 'ended') set({ session: null });
  }, 1800);
}

export async function hangUp(reason = 'ended') {
  const session = get().session;
  if (!session) return;
  finishLocally(reason);
  await api(`/meet/calls/${session.info.id}/leave`, { method: 'POST', body: {} }).catch(() => {});
}

// ───────── Live signals ─────────

let bound = false;
export function bindCalls() {
  const socket = realtime();
  if (!socket || bound) return;
  bound = true;
  socket.on('call:incoming', async ({ callId }: { callId: string }) => {
    if (get().session) return; // already on a call: the server marks this one busy/missed
    try {
      const { call } = await api<{ call: CallInfo }>(`/meet/calls/${callId}`);
      void loadProfiles([call.initiatorId]);
      set({ incoming: call });
      playTone('ring');
      if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted')
        new Notification(call.media === 'video' ? 'Incoming video call' : 'Incoming voice call', { tag: callId, icon: '/icon.svg', requireInteraction: true });
    } catch {}
  });
  socket.on('call:update', async ({ callId }: { callId: string }) => {
    const session = get().session;
    if (session?.info.id !== callId) return;
    const { call } = await api<{ call: CallInfo }>(`/meet/calls/${callId}`);
    void loadProfiles(call.participants.map((p) => p.userId));
    patch({ info: call });
  });
  socket.on('call:ended', ({ callId, outcome }: { callId: string; outcome: string }) => {
    if (get().incoming?.id === callId) {
      stopTone();
      set({ incoming: null });
    }
    if (get().session?.info.id === callId && get().session?.phase !== 'ended') finishLocally(outcome);
  });
  // A call that rang while this page was closed.
  void api<{ calls: CallInfo[] }>('/meet/calls/incoming')
    .then(({ calls }) => {
      if (calls[0] && !get().session) {
        set({ incoming: calls[0] });
        playTone('ring');
        void loadProfiles([calls[0].initiatorId]);
      }
    })
    .catch(() => {});
}

export function unbindCalls() {
  bound = false;
  stopTone();
  get().session?.room?.disconnect();
  set({ session: null, incoming: null, enabled: null });
}
