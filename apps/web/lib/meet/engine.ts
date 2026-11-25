'use client';

import { create } from 'zustand';
import { Room, RoomEvent, Track, type LocalVideoTrack } from 'livekit-client';
import type { JoinResult, MediaGrant, MeetingControls, MeetingInfo, MeetingParticipantInfo } from '@talkie/contracts';
import { api } from '../api';
import { connectRealtime, renewRealtimeToken } from '../realtime';
import { loadProfiles } from '../chat/engine';

export type MeetPhase = 'loading' | 'lobby' | 'joining' | 'waiting' | 'in' | 'ended' | 'denied' | 'removed' | 'missing';
export type Layout = 'auto' | 'tiled' | 'spotlight' | 'sidebar';
export type Panel = 'people' | 'chat' | 'activities' | 'controls' | 'info' | null;

export interface ChatLine {
  id: string;
  userId: string;
  body: string;
  createdAt: string;
}
export interface PollView {
  id: string;
  question: string;
  multipleChoice: boolean;
  status: string;
  options: Array<{ id: string; label: string; votes: number | null }>;
  myVotes: string[];
  totalVoters: number;
}
export interface QuestionView {
  id: string;
  userId: string | null;
  body: string;
  status: string;
  votes: number;
  votedByMe: boolean;
}
export interface BreakoutView {
  id: string;
  name: string;
  closesAt: string | null;
  userIds: string[];
}
export interface FloatingReaction {
  id: number;
  emoji: string;
  name: string;
}

interface MeetState {
  code: string;
  phase: MeetPhase;
  meeting: MeetingInfo | null;
  room: Room | null;
  inBreakout: boolean;
  participants: MeetingParticipantInfo[];
  chat: ChatLine[];
  unreadChat: number;
  polls: PollView[];
  questions: QuestionView[];
  breakouts: BreakoutView[];
  myBreakoutId: string | null;
  panel: Panel;
  layout: Layout;
  pinned: string | null;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  blur: boolean;
  handRaised: boolean;
  reactions: FloatingReaction[];
  notice: string | null;
  error: string | null;
  version: number;
}

const initial: Omit<MeetState, 'code'> = {
  phase: 'loading',
  meeting: null,
  room: null,
  inBreakout: false,
  participants: [],
  chat: [],
  unreadChat: 0,
  polls: [],
  questions: [],
  breakouts: [],
  myBreakoutId: null,
  panel: null,
  layout: 'auto',
  pinned: null,
  micOn: true,
  camOn: true,
  screenOn: false,
  blur: false,
  handRaised: false,
  reactions: [],
  notice: null,
  error: null,
  version: 0,
};

export const useMeet = create<MeetState>(() => ({ code: '', ...initial }));
const set = useMeet.setState;
const get = useMeet.getState;
const path = (suffix = '') => `/meet/meetings/${get().code}${suffix}`;
const bump = () => set((s) => ({ version: s.version + 1 }));

export const isHost = () => get().meeting?.myRole === 'host' || get().meeting?.myRole === 'cohost';

export function notice(text: string) {
  set({ notice: text });
  setTimeout(() => get().notice === text && set({ notice: null }), 4000);
}

// ───────── Load and join ─────────

export async function loadMeeting(code: string) {
  set({ code, ...initial });
  try {
    const { meeting } = await api<{ meeting: MeetingInfo }>(`/meet/meetings/${code}`);
    set({ meeting, phase: meeting.status === 'cancelled' ? 'ended' : 'lobby' });
    void loadProfiles([meeting.hostId]);
    bind();
  } catch {
    set({ phase: 'missing' });
  }
}

let preview: { video?: MediaStreamTrack; audio?: MediaStreamTrack } = {};
export const setPreview = (tracks: { video?: MediaStreamTrack; audio?: MediaStreamTrack }) => (preview = tracks);

export async function join(options: { mic: boolean; cam: boolean; blur: boolean; videoDevice?: string; audioDevice?: string }) {
  set({ phase: 'joining', micOn: options.mic, camOn: options.cam, blur: options.blur, error: null });
  try {
    const result = await api<JoinResult>(path('/join'), { method: 'POST', body: {} });
    if (result.state === 'denied') return set({ phase: 'denied' });
    if (result.state === 'waiting') return set({ phase: 'waiting' });
    await enter(result.grant, options);
  } catch (error) {
    set({ phase: 'lobby', error: (error as Error).message });
  }
}

async function enter(grant: MediaGrant, options?: { videoDevice?: string; audioDevice?: string }) {
  preview.video?.stop();
  preview.audio?.stop();
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: options?.audioDevice },
    videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 }, deviceId: options?.videoDevice },
    publishDefaults: { simulcast: true, videoCodec: 'vp9', backupCodec: true },
  });
  for (const event of [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.ParticipantPermissionsChanged,
  ])
    room.on(event, bump);
  room.on(RoomEvent.TrackMuted, (publication, participant) => {
    if (participant.isLocal) set({ micOn: room.localParticipant.isMicrophoneEnabled, camOn: room.localParticipant.isCameraEnabled });
  });
  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) set({ screenOn: false });
  });
  room.on(RoomEvent.ParticipantPermissionsChanged, () => {
    const can = room.localParticipant.permissions;
    if (can && !can.canPublishSources.includes(2 as never) && get().micOn) set({ micOn: false });
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(payload)) as { type: string; emoji?: string; text?: string };
      if (topic === 'reaction' && data.emoji) float(data.emoji, participant?.name ?? '');
      if (topic === 'talkie' && data.type === 'muted-by-host') {
        set({ micOn: false });
        notice('The host muted you');
      }
      if (topic === 'talkie' && data.type === 'video-stopped-by-host') {
        set({ camOn: false });
        notice('The host turned off your camera');
      }
      if (topic === 'talkie' && data.type === 'host-message' && data.text) notice(`Host: ${data.text}`);
    } catch {}
  });
  room.on(RoomEvent.Disconnected, () => {
    if (get().phase === 'in' && get().room === room && !switching) set({ phase: 'ended' });
  });
  await room.connect(grant.url, grant.token);
  set({ room, phase: 'in' });
  const can = (source: number) => room.localParticipant.permissions?.canPublishSources.includes(source as never) ?? true;
  // Devices start alongside: a permission prompt must not hold up entering the room.
  void (async () => {
    if (get().micOn && can(2)) await room.localParticipant.setMicrophoneEnabled(true).catch(() => set({ micOn: false }));
    else set({ micOn: false });
    if (get().camOn && can(1)) {
      await room.localParticipant.setCameraEnabled(true).catch(() => set({ camOn: false }));
      if (get().blur) await applyBlur(true);
    } else set({ camOn: false });
    bump();
  })();
  await refreshAll();
}

export async function refreshAll() {
  await Promise.all([refreshMeeting(), refreshParticipants(), refreshChat(), refreshPolls(), refreshQuestions(), refreshBreakouts()].map((p) => p.catch(() => {})));
}

export async function refreshMeeting() {
  const { meeting } = await api<{ meeting: MeetingInfo }>(path());
  set({ meeting });
}
export async function refreshParticipants() {
  const { participants } = await api<{ participants: MeetingParticipantInfo[] }>(path('/participants'));
  void loadProfiles(participants.map((p) => p.userId));
  set({ participants });
}
export async function refreshChat() {
  const { messages } = await api<{ messages: ChatLine[] }>(path('/chat'));
  set((s) => ({ chat: messages, unreadChat: s.panel === 'chat' ? 0 : s.unreadChat + Math.max(0, messages.length - s.chat.length) }));
}
export async function refreshPolls() {
  const { polls } = await api<{ polls: PollView[] }>(path('/polls'));
  set({ polls });
}
export async function refreshQuestions() {
  const { questions } = await api<{ questions: QuestionView[] }>(path('/questions'));
  set({ questions });
}
export async function refreshBreakouts() {
  const data = await api<{ rooms: BreakoutView[]; myRoomId: string | null }>(path('/breakouts'));
  set({ breakouts: data.rooms, myBreakoutId: data.myRoomId });
}

// ───────── Media ─────────

export async function toggleMic() {
  const room = get().room;
  if (!room) return set({ micOn: !get().micOn });
  const next = !get().micOn;
  try {
    await room.localParticipant.setMicrophoneEnabled(next);
    set({ micOn: next });
  } catch {
    notice('The host has turned off microphones');
  }
}

export async function toggleCam() {
  const room = get().room;
  if (!room) return set({ camOn: !get().camOn });
  const next = !get().camOn;
  try {
    await room.localParticipant.setCameraEnabled(next);
    set({ camOn: next });
    if (next && get().blur) await applyBlur(true);
  } catch {
    notice('The host has turned off cameras');
  }
}

export async function toggleScreen() {
  const room = get().room;
  if (!room) return;
  const next = !get().screenOn;
  try {
    await room.localParticipant.setScreenShareEnabled(next, { audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
    set({ screenOn: next });
  } catch (error) {
    if ((error as Error).name !== 'NotAllowedError') notice('The host has turned off screen sharing');
  }
}

let blurProcessor: { name: string } | null = null;
async function applyBlur(on: boolean) {
  const track = get().room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  if (!track) return;
  try {
    if (on) {
      const { BackgroundBlur, supportsBackgroundProcessors } = await import('@livekit/track-processors');
      if (!supportsBackgroundProcessors()) return notice('This browser cannot blur the background');
      blurProcessor = BackgroundBlur(12);
      await track.setProcessor(blurProcessor as never);
    } else if (blurProcessor) {
      await track.stopProcessor();
      blurProcessor = null;
    }
  } catch {
    notice('Background blur is not available');
  }
}

export async function toggleBlur() {
  const next = !get().blur;
  set({ blur: next });
  await applyBlur(next);
}

export function sendReaction(emoji: string) {
  const room = get().room;
  if (!room) return;
  void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ emoji })), { reliable: false, topic: 'reaction' }).catch(() => {});
  float(emoji, room.localParticipant.name ?? '');
}

let reactionId = 0;
function float(emoji: string, name: string) {
  const id = ++reactionId;
  set((s) => ({ reactions: [...s.reactions.slice(-20), { id, emoji, name }] }));
  setTimeout(() => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })), 4200);
}

// ───────── Actions ─────────

export async function raiseHand() {
  const next = !get().handRaised;
  set({ handRaised: next });
  await api(path('/hand'), { method: 'POST', body: { raised: next } });
}

export const sendChat = (body: string) => api(path('/chat'), { method: 'POST', body: { body } }).then(refreshChat);
export const hostAction = (participantId: string, action: 'admit' | 'deny' | 'remove' | 'mute' | 'stop-video' | 'lower-hand') =>
  api(path(`/participants/${participantId}/${action}`), { method: 'POST', body: {} }).then(refreshParticipants);
export const admitAll = () => api(path('/admit-all'), { method: 'POST', body: {} }).then(refreshParticipants);
export const muteAll = () => api(path('/mute-all'), { method: 'POST', body: {} });
export const setCohost = (userId: string, cohost: boolean) => api(path(`/cohosts/${userId}`), { method: 'PUT', body: { cohost } }).then(refreshAll);
export const updateControls = (controls: Partial<MeetingControls>) => api<{ meeting: MeetingInfo }>(path(), { method: 'PATCH', body: { controls } }).then(({ meeting }) => set({ meeting }));
export const updateAccess = (access: 'open' | 'trusted' | 'restricted') => api<{ meeting: MeetingInfo }>(path(), { method: 'PATCH', body: { access } }).then(({ meeting }) => set({ meeting }));
export const createPoll = (question: string, options: string[], multipleChoice: boolean) => api(path('/polls'), { method: 'POST', body: { question, options, multipleChoice } }).then(refreshPolls);
export const votePoll = (pollId: string, optionIds: string[]) => api(path(`/polls/${pollId}/vote`), { method: 'POST', body: { optionIds } }).then(refreshPolls);
export const closePoll = (pollId: string) => api(path(`/polls/${pollId}/close`), { method: 'POST', body: {} }).then(refreshPolls);
export const ask = (body: string, anonymous: boolean) => api(path('/questions'), { method: 'POST', body: { body, anonymous } }).then(refreshQuestions);
export const upvote = (id: string, voted: boolean) => api(path(`/questions/${id}/vote`), { method: 'POST', body: { voted } }).then(refreshQuestions);
export const markQuestion = (id: string, status: 'open' | 'answered' | 'hidden') => api(path(`/questions/${id}/status`), { method: 'POST', body: { status } }).then(refreshQuestions);
export const openBreakouts = (rooms: Array<{ name: string; participantIds: string[] }>, minutes: number | null) => api(path('/breakouts'), { method: 'POST', body: { rooms, minutes } });
export const closeBreakouts = () => api(path('/breakouts'), { method: 'DELETE' });
export const broadcastToBreakouts = (text: string) => api(path('/breakouts/broadcast'), { method: 'POST', body: { text } });
export const startRecording = (kind: 'recording' | 'stream', rtmpUrl?: string) => api(path('/recording'), { method: 'POST', body: { kind, ...(rtmpUrl ? { rtmpUrl } : {}) } }).then(refreshMeeting);
export const stopRecording = (kind: 'recording' | 'stream') => api(path(`/recording/${kind}`), { method: 'DELETE' }).then(refreshMeeting);
export const setPanel = (panel: Panel) => set((s) => ({ panel: s.panel === panel ? null : panel, unreadChat: panel === 'chat' ? 0 : s.unreadChat }));
export const setLayout = (layout: Layout) => set({ layout });
export const setPinned = (identity: string | null) => set((s) => ({ pinned: s.pinned === identity ? null : identity }));

export async function leave() {
  get().room?.disconnect();
  set({ room: null, phase: 'ended' });
  await api(path('/leave'), { method: 'POST', body: {} }).catch(() => {});
}

export async function endForAll() {
  await api(path('/end'), { method: 'POST', body: {} });
  get().room?.disconnect();
  set({ room: null, phase: 'ended' });
}

/** Moves between the main room and my breakout room. */
let switching = false;
async function switchRoom(toMain: boolean) {
  switching = true;
  try {
    const { grant, breakout } = await api<{ grant: MediaGrant; breakout: boolean }>(path('/token'), { method: 'POST', body: { main: toMain } });
    if (get().room?.name === grant.room) return;
    get().room?.disconnect();
    set({ inBreakout: breakout });
    await enter(grant);
    notice(breakout ? 'You moved to your breakout room' : 'Welcome back to the main room');
  } finally {
    switching = false;
  }
}
export const returnToMain = () => switchRoom(true);
export const goToBreakout = () => switchRoom(false);

// ───────── Live signals ─────────

let boundSocket: unknown = null;
function bind() {
  const socket = connectRealtime();
  if (boundSocket === socket) return;
  boundSocket = socket;
  socket.on('meeting:admission', async ({ code, state }: { code: string; state: string }) => {
    if (code !== get().code) return;
    if (state === 'admitted' && get().phase === 'waiting') {
      const { grant } = await api<{ grant: MediaGrant }>(path('/token'), { method: 'POST', body: {} });
      await enter(grant);
    } else if (state === 'denied') set({ phase: 'denied' });
    else if (state === 'removed') {
      get().room?.disconnect();
      set({ phase: 'removed', room: null });
    }
  });
  socket.on('meeting:update', ({ code, change, userId }: { code: string; change: string; userId?: string }) => {
    if (code !== get().code || get().phase !== 'in') return;
    if (change === 'ended') {
      get().room?.disconnect();
      return set({ phase: 'ended', room: null });
    }
    if (change === 'chat') void refreshChat();
    if (change === 'polls') void refreshPolls();
    if (change === 'questions') void refreshQuestions();
    if (['knock', 'joined', 'left', 'participants', 'hands', 'roles'].includes(change)) void refreshParticipants();
    if (['settings', 'roles', 'recording'].includes(change)) void refreshMeeting();
    if (change === 'knock' && isHost()) notice('Someone wants to join');
    if (change === 'hands' && userId) void refreshParticipants();
    if (change === 'breakouts-open') void refreshBreakouts().then(() => {
        if (get().myBreakoutId) void goToBreakout();
      });
    if (change === 'breakouts-closed') void refreshBreakouts().then(() => {
        if (get().inBreakout) void returnToMain();
      });
  });
  socket.on('connect', () => renewRealtimeToken());
}

export function resetMeet() {
  get().room?.disconnect();
  preview.video?.stop();
  preview.audio?.stop();
  set({ code: '', ...initial });
}
