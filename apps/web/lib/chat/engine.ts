'use client';

import type { ConversationSummary, DeviceKey, MemberInfo, Receipts, WireMessage } from '@talkie/contracts';
import * as e2ee from '@talkie/e2ee';
import { api, ApiError, refreshSession, retryTemporary } from '../api';
import { connectRealtime, disconnectRealtime, onConnectionState, realtime, renewRealtimeToken } from '../realtime';
import { deviceKeys, ensureDeviceKeys, isKeyOwner, rememberKeys, senderKeys } from './keys';
import { resetChat, useChat, type ChatMessage, type Profile, type Thread } from './store';
import { kindOf, prepareImage, prepareVideo, primeAttachment, uploadEncrypted } from './media';
import type { AttachmentRef, MessageKind, PollBody } from '@talkie/contracts';

/**
 * The chat engine: loads conversations, decrypts and sends messages, and keeps everything current from live
 * events. Components read the store; they call these functions to act.
 */

const set = useChat.setState;
const get = useChat.getState;
const deviceCache = new Map<string, DeviceKey[]>();
const olderPages = new Map<string, Promise<boolean>>();
const catchUps = new Map<string, { task: Promise<void>; rerun: boolean }>();
const readSent = new Map<string, string>();
const deliveredSent = new Map<string, string>();
let started = false;
let cleanup: Array<() => void> = [];

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);
const messageOrder = (a: ChatMessage, b: ChatMessage) =>
  a.local ? (b.local ? 0 : 1) : b.local ? -1 : a.id === b.id ? 0 : newer(a.id, b.id) ? 1 : -1;

// ───────── Decryption ─────────

async function decrypt(messages: WireMessage[]): Promise<ChatMessage[]> {
  const keys = deviceKeys();
  const sealed = messages.filter((m) => m.ciphertext && m.sealedKey);
  const wrappers = new Set(sealed.flatMap((m) => m.keySenderDeviceId ? [m.keySenderDeviceId] : []));
  const senders = sealed.map((m) => m.keySenderDeviceId ?? m.senderDeviceId);
  const known = senders.length ? await senderKeys(senders, wrappers).catch(() => senderKeys([])) : new Map<string, string>();
  return messages.map((message) => {
    if (!message.ciphertext || message.deletedAt || message.kind === 'system') return { ...message, body: null };
    if (!message.sealedKey || !keys) return { ...message, body: null, unreadable: 'not_for_this_device' };
    const wrap = message.keySenderDeviceId;
    const owner = get().me?.userId;
    const senderKey = wrap && (!owner || !isKeyOwner(wrap, owner)) ? undefined : known.get(wrap ?? message.senderDeviceId);
    if (!senderKey) return { ...message, body: null, unreadable: 'failed' };
    try {
      return { ...message, body: e2ee.open({ ciphertext: message.ciphertext, nonce: message.nonce!, sealedKey: message.sealedKey }, senderKey, keys.pair) };
    } catch {
      return { ...message, body: null, unreadable: 'failed' };
    }
  });
}

// ───────── Profiles ─────────

const profileRequests = new Set<string>();
export async function loadProfiles(userIds: string[]) {
  const missing = [...new Set(userIds)].filter((id) => !get().profiles[id] && !profileRequests.has(id));
  if (!missing.length) return;
  missing.forEach((id) => profileRequests.add(id));
  try {
    for (let offset = 0; offset < missing.length; offset += 50) {
      const ids = missing.slice(offset, offset + 50);
      const { users } = await api<{ users: Profile[] }>('/users/lookup', { method: 'POST', body: { ids } }).catch(async () => {
        const users: Profile[] = [];
        for (const id of ids) {
          const result = await api<{ user: Profile }>(`/users/${id}`).catch(() => null);
          if (result) users.push(result.user);
        }
        return { users };
      });
      set((state) => ({ profiles: { ...state.profiles, ...Object.fromEntries(users.map((u) => [u.id, u])) } }));
    }
  } finally {
    missing.forEach((id) => profileRequests.delete(id));
  }
}

export async function refreshProfile(userId: string) {
  const { user } = await api<{ user: Profile }>(`/users/${userId}`);
  set((state) => ({ profiles: { ...state.profiles, [userId]: user } }));
  return user;
}

// ───────── Conversations ─────────

async function storeSummaries(summaries: ConversationSummary[], replace = false) {
  const lasts = await decrypt(summaries.map((s) => s.lastMessage).filter((m): m is WireMessage => !!m));
  const lastBy = new Map(lasts.map((m) => [m.id, m]));
  set((state) => {
    const conversations = replace ? {} : { ...state.conversations };
    const receipts = { ...state.receipts };
    const viewing = typeof document !== 'undefined' && document.visibilityState === 'visible' ? state.activeId : null;
    for (const summary of summaries) {
      const last = summary.lastMessage ? lastBy.get(summary.lastMessage.id) : undefined;
      // The chat on screen is being read right now; a summary fetched a moment earlier must not bring back its badge.
      const read = summary.id === viewing ? { unreadCount: 0, markedUnread: false } : {};
      conversations[summary.id] = { ...summary, ...read, lastMessage: last ?? summary.lastMessage, lastBody: last?.body ?? null };
      receipts[summary.id] = summary.receipts;
    }
    return { conversations, receipts };
  });
  const people = summaries.flatMap((s) => [s.peerId, s.lastMessage?.senderId]).filter((id): id is string => !!id);
  void loadProfiles(people);
  watchPresence();
}

export async function loadConversations() {
  const { conversations } = await api<{ conversations: ConversationSummary[] }>('/chat/conversations');
  await storeSummaries(conversations, true);
}

async function reloadConversation(conversationId: string) {
  try {
    const data = await retryTemporary(() => api<{ conversation: ConversationSummary; members: MemberInfo[]; pinnedMessageIds: string[] }>(
      `/chat/conversations/${conversationId}`, { signal: AbortSignal.timeout(10_000) },
    ));
    await storeSummaries([data.conversation]);
    set((state) => ({ members: { ...state.members, [conversationId]: data.members }, pins: { ...state.pins, [conversationId]: data.pinnedMessageIds } }));
    void loadProfiles(data.members.map((m) => m.userId));
    deviceCache.delete(conversationId);
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) forgetConversation(conversationId);
    return null;
  }
}

/** Removes a chat from this device's list (it was deleted, or is gone). */
function forgetConversation(conversationId: string) {
  olderPages.delete(conversationId);
  catchUps.delete(conversationId);
  set((state) => {
    const conversations = { ...state.conversations };
    const threads = { ...state.threads };
    delete conversations[conversationId];
    delete threads[conversationId];
    return { conversations, threads, activeId: state.activeId === conversationId ? null : state.activeId };
  });
}

/** "Delete chat": clears it for me and removes it from my list until someone writes again. */
export async function deleteConversation(conversationId: string) {
  await api(`/chat/conversations/${conversationId}`, { method: 'DELETE' });
  forgetConversation(conversationId);
}

export async function clearConversation(conversationId: string) {
  await api(`/chat/conversations/${conversationId}/clear`, { method: 'POST' });
  olderPages.delete(conversationId);
  catchUps.delete(conversationId);
  set((state) => {
    const threads = { ...state.threads };
    delete threads[conversationId];
    return { threads };
  });
  await loadOlder(conversationId, true);
}

export async function openConversation(conversationId: string | null) {
  set({ activeId: conversationId });
  if (!conversationId) return;
  const summary = reloadConversation(conversationId);
  if (get().threads[conversationId]?.loaded) void loadNewer(conversationId);
  else await loadOlder(conversationId, true);
  if (!await summary && get().activeId === conversationId && !get().conversations[conversationId]) {
    updateThread(conversationId, { pageFailed: true });
  }
  markRead(conversationId);
}

export function loadOlder(conversationId: string, initial = false): Promise<boolean> {
  const pending = olderPages.get(conversationId);
  if (pending) return pending;
  const thread = get().threads[conversationId] ?? { items: [], hasMore: false, loaded: false };
  const oldest = thread.items.find((m) => !m.local)?.id;
  if (!initial && (!thread.hasMore || !oldest)) return Promise.resolve(false);
  const before = initial ? '' : `&before=${oldest}`;
  const request: Promise<boolean> = loadPage(conversationId, `limit=50${before}`, () => olderPages.get(conversationId) === request, before ? 'older' : 'initial')
    .then(() => true, () => {
      if (olderPages.get(conversationId) === request) updateThread(conversationId, { pageFailed: true });
      return false;
    }).finally(() => {
      if (olderPages.get(conversationId) !== request) return;
      olderPages.delete(conversationId);
      updateThread(conversationId, { loadingPage: false });
    });
  olderPages.set(conversationId, request);
  updateThread(conversationId, { loadingPage: true, pageFailed: false });
  return request;
}

function updateThread(conversationId: string, patch: Partial<Thread>) {
  set((state) => ({
    threads: { ...state.threads, [conversationId]: { ...(state.threads[conversationId] ?? { items: [], hasMore: false, loaded: false }), ...patch } },
  }));
}

async function loadPage(conversationId: string, query: string, currentRequest: () => boolean, kind: 'initial' | 'older' | 'newer'): Promise<string | undefined> {
  const page = await retryTemporary(() => api<{ messages: WireMessage[]; receipts: Receipts; hasMore: boolean }>(
    `/chat/conversations/${conversationId}/messages?${query}`, { signal: AbortSignal.timeout(12_000) },
  ));
  if (!currentRequest()) return;
  const decrypted = await decrypt(page.messages);
  if (!currentRequest()) return;
  void loadProfiles(decrypted.map((m) => m.senderId));
  set((state) => {
    const current = state.threads[conversationId]!;
    const byId = new Map(current.items.map((m) => [m.id, m]));
    for (const message of decrypted) {
      const known = byId.get(message.id);
      if (!known?.body || !message.unreadable || known.editedAt !== message.editedAt) byId.set(message.id, message);
    }
    const items = [...byId.values()].sort(messageOrder);
    const newest = decrypted.at(-1);
    const oldest = items.find((m) => !m.local)?.id;
    const summary = state.conversations[conversationId];
    const conversations = newest && summary && (!summary.lastMessage || newer(newest.id, summary.lastMessage.id))
      ? { ...state.conversations, [conversationId]: { ...summary, lastMessage: newest, lastBody: newest.body } }
      : state.conversations;
    const hasMore = kind === 'older' || (kind === 'initial' && (!current.loaded || decrypted[0]?.id === oldest)) ? page.hasMore : current.hasMore;
    const latestSyncedId = (kind === 'newer' || !current.latestSyncedId) && kind !== 'older' && newest ? newest.id : current.latestSyncedId;
    return { conversations, threads: { ...state.threads, [conversationId]: { ...current, items, hasMore, latestSyncedId, loaded: true } }, receipts: { ...state.receipts, [conversationId]: page.receipts } };
  });
  acknowledgeDelivery(conversationId);
  return page.hasMore ? decrypted.at(-1)?.id : undefined;
}

async function loadNewer(conversationId: string) {
  const pending = catchUps.get(conversationId);
  if (pending) {
    pending.rerun = true;
    return pending.task;
  }
  const currentRequest = (): boolean => catchUps.get(conversationId) === job;
  const job: { task: Promise<void>; rerun: boolean } = {
    rerun: false,
    task: Promise.resolve().then(async () => {
      try {
        do {
          job.rerun = false;
          await olderPages.get(conversationId);
          if (!currentRequest()) return;
          let cursor = get().threads[conversationId]?.latestSyncedId;
          if (!cursor) {
            await loadOlder(conversationId, true);
            continue;
          }
          while (cursor && currentRequest()) {
            cursor = await loadPage(conversationId, `after=${cursor}&limit=100`, currentRequest, 'newer');
          }
        } while (job.rerun && currentRequest());
      } catch {
        // Retain the visible history and retry on reconnect or the next event.
      } finally {
        if (currentRequest()) catchUps.delete(conversationId);
      }
    }),
  };
  catchUps.set(conversationId, job);
  return job.task;
}

// ───────── Receipts ─────────

function latestFromOthers(conversationId: string): string | null {
  const me = get().me?.userId;
  const thread = get().threads[conversationId];
  const fromThread = [...(thread?.items ?? [])].reverse().find((m) => !m.local && m.senderId !== me)?.id;
  const summary = get().conversations[conversationId]?.lastMessage;
  const fromSummary = summary && summary.senderId !== me ? summary.id : null;
  if (fromThread && fromSummary) return newer(fromThread, fromSummary) ? fromThread : fromSummary;
  return fromThread ?? fromSummary;
}

export function markRead(conversationId: string) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (get().activeId !== conversationId) return;
  const latest = latestFromOthers(conversationId);
  const summary = get().conversations[conversationId];
  if (!summary?.active && summary) return;
  if (summary && (summary.unreadCount > 0 || summary.markedUnread))
    set((state) => ({ conversations: { ...state.conversations, [conversationId]: { ...summary, unreadCount: 0, markedUnread: false } } }));
  if (!latest || (readSent.get(conversationId) && !newer(latest, readSent.get(conversationId)!))) return;
  readSent.set(conversationId, latest);
  void api(`/chat/conversations/${conversationId}/read`, { method: 'POST', body: { messageId: latest } }).catch(() => readSent.delete(conversationId));
}

function acknowledgeDelivery(conversationId: string) {
  const latest = latestFromOthers(conversationId);
  if (!latest || (deliveredSent.get(conversationId) && !newer(latest, deliveredSent.get(conversationId)!))) return;
  deliveredSent.set(conversationId, latest);
  void api(`/chat/conversations/${conversationId}/delivered`, { method: 'POST', body: { messageId: latest } }).catch(() => deliveredSent.delete(conversationId));
}

// ───────── Sending ─────────

async function devicesFor(conversationId: string, fresh = false): Promise<DeviceKey[]> {
  if (!fresh && deviceCache.has(conversationId)) return deviceCache.get(conversationId)!;
  const { devices } = await retryTemporary(() => api<{ devices: DeviceKey[] }>(
    `/chat/conversations/${conversationId}/devices${fresh ? '?fresh=1' : ''}`, { signal: AbortSignal.timeout(12_000) },
  ));
  deviceCache.set(conversationId, devices);
  rememberKeys(devices);
  return devices;
}

/** Encrypts for every device and posts; re-encrypts once if someone linked or removed a device meanwhile. */
async function sealAndPost<T>(conversationId: string, body: e2ee.MessageBody, post: (sealed: e2ee.Sealed) => Promise<T>): Promise<T> {
  const keys = deviceKeys();
  if (!keys) throw new Error('Device keys are not ready');
  const recipients = (devices: DeviceKey[]) => {
    const list = devices.map((d) => ({ deviceId: d.deviceId, identityKey: d.identityKey }));
    if (!list.some((d) => d.deviceId === keys.deviceId)) list.push({ deviceId: keys.deviceId, identityKey: keys.pair.publicKey });
    return list;
  };
  try {
    return await post(e2ee.seal(body, keys.pair, recipients(await devicesFor(conversationId))));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'devices_changed') throw error;
    const devices = (error.details?.devices as DeviceKey[] | undefined) ?? (await devicesFor(conversationId, true));
    deviceCache.set(conversationId, devices);
    rememberKeys(devices);
    return post(e2ee.seal(body, keys.pair, recipients(devices)));
  }
}

function upsertMessage(conversationId: string, message: ChatMessage, replaceId?: string) {
  set((state) => {
    const thread = state.threads[conversationId] ?? { items: [], hasMore: false, loaded: false };
    const items = thread.items.filter((m) => m.id !== message.id && m.id !== replaceId);
    items.push(message);
    items.sort(messageOrder);
    const summary = state.conversations[conversationId];
    const isLatest = !message.local && (!summary?.lastMessage || !newer(summary.lastMessage.id, message.id));
    return {
      threads: { ...state.threads, [conversationId]: { ...thread, items } },
      conversations: summary && isLatest ? { ...state.conversations, [conversationId]: { ...summary, lastMessage: message, lastBody: message.body } } : state.conversations,
    };
  });
}

interface SendOptions {
  replyToId?: string;
  local?: ChatMessage;
  /** Runs before posting (e.g. uploads); returns body additions and the uploaded media ids. */
  prepare?: (localId: string) => Promise<{ body?: Partial<e2ee.MessageBody>; mediaIds?: string[] }>;
}

/** Shows the message at once, prepares (uploads) if needed, encrypts for every device and posts it. */
async function sendMessage(conversationId: string, kind: Exclude<MessageKind, 'system' | 'call'>, body: e2ee.MessageBody, options: SendOptions = {}) {
  const me = get().me!;
  const clientMessageId = options.local?.id.slice(6) ?? e2ee.clientMessageId();
  const localId = `local:${clientMessageId}`;
  const optimistic: ChatMessage = options.local
    ? { ...options.local, local: 'sending' }
    : {
        id: localId,
        conversationId,
        senderId: me.userId,
        senderDeviceId: me.deviceId,
        kind,
        ciphertext: null,
        nonce: null,
        sealedKey: null,
        systemEvent: null,
        replyToId: options.replyToId ?? null,
        forwardedCount: 0,
        editedAt: null,
        deletedAt: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        reactions: [],
        starred: false,
        body,
        local: 'sending',
      };
  upsertMessage(conversationId, optimistic);
  try {
    const prepared = options.prepare ? await options.prepare(localId) : {};
    const finalBody = { ...body, ...prepared.body } as e2ee.MessageBody;
    const { message } = await sealAndPost(conversationId, finalBody, (sealed) =>
      retryTemporary(() => api<{ message: WireMessage }>(`/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        body: { clientMessageId, kind, ...sealed, mediaIds: prepared.mediaIds ?? [], ...(optimistic.replyToId ? { replyToId: optimistic.replyToId } : {}) },
      })),
    );
    upsertMessage(conversationId, { ...message, body: finalBody }, localId);
    readSent.set(conversationId, message.id);
    setProgress(localId, null);
  } catch (error) {
    upsertMessage(conversationId, { ...optimistic, local: 'failed' });
    setProgress(localId, null);
    throw error;
  }
}

function setProgress(localId: string, value: number | null) {
  set((state) => {
    const uploads = { ...state.uploads };
    if (value === null) delete uploads[localId];
    else uploads[localId] = value;
    return { uploads };
  });
}

export async function sendText(conversationId: string, text: string, replyToId?: string, local?: ChatMessage) {
  if (local && local.kind !== 'text') throw new Error('Choose the file again to resend it.');
  await sendMessage(conversationId, 'text', { v: 1, text }, { replyToId, local });
}

/** Photos, videos, documents and voice notes: encrypted on this device, uploaded, then sent. */
export async function sendFile(
  conversationId: string,
  file: File | Blob,
  options: { caption?: string; replyToId?: string; hd?: boolean; voice?: { durationMs: number; waveform: number[] }; name?: string } = {},
) {
  const named = file instanceof File ? file : new File([file], options.name ?? 'voice-note', { type: file.type });
  const kind = options.voice ? 'voice' : kindOf(named);
  const ref: Partial<AttachmentRef> = { mime: named.type || 'application/octet-stream', name: named.name, size: named.size };
  let upload: Blob = named;
  if (options.voice) Object.assign(ref, { durationMs: options.voice.durationMs, waveform: options.voice.waveform });
  else if (kind === 'image') {
    const prepared = await prepareImage(named, options.hd);
    upload = prepared.blob;
    Object.assign(ref, { width: prepared.width, height: prepared.height, thumb: prepared.thumb, size: prepared.blob.size, mime: prepared.blob.type || named.type });
  } else if (kind === 'video') Object.assign(ref, await prepareVideo(named));
  // The bubble shows the local file right away, before the upload finishes.
  const preview: AttachmentRef = { ...(ref as AttachmentRef), mediaId: `local-${Math.random().toString(36).slice(2)}`, key: '', header: '' };
  primeAttachment(preview.mediaId, upload);
  await sendMessage(conversationId, kind, { v: 1, ...(options.caption ? { text: options.caption } : {}), attachments: [preview] }, {
    replyToId: options.replyToId,
    prepare: async (localId) => {
      setProgress(localId, 0);
      const uploaded = await uploadEncrypted(upload, 'message', (fraction) => setProgress(localId, fraction));
      primeAttachment(uploaded.mediaId, upload);
      return { body: { attachments: [{ ...preview, ...uploaded }] }, mediaIds: [uploaded.mediaId] };
    },
  });
}

export async function sendPoll(conversationId: string, poll: PollBody) {
  await sendMessage(conversationId, 'poll', { v: 1, poll });
}

export async function vote(conversationId: string, messageId: string, options: number[]) {
  const me = get().me!.userId;
  set((state) => {
    const thread = state.threads[conversationId];
    if (!thread) return {};
    const items = thread.items.map((m) => {
      if (m.id !== messageId) return m;
      const tallies = new Map((m.pollVotes ?? []).map((t) => [t.option, t.userIds.filter((u) => u !== me)]));
      for (const option of options) tallies.set(option, [...(tallies.get(option) ?? []), me]);
      return { ...m, pollVotes: [...tallies.entries()].filter(([, users]) => users.length).map(([option, userIds]) => ({ option, userIds })) };
    });
    return { threads: { ...state.threads, [conversationId]: { ...thread, items } } };
  });
  await api(`/chat/messages/${messageId}/vote`, { method: 'PUT', body: { options } });
}

export async function editText(conversationId: string, messageId: string, text: string) {
  const body: e2ee.MessageBody = { v: 1, text };
  const { message } = await sealAndPost(conversationId, body, (sealed) => api<{ message: WireMessage }>(`/chat/messages/${messageId}`, { method: 'PATCH', body: sealed }));
  upsertMessage(conversationId, { ...message, body });
}

/**
 * Removes a message from the screen at once and returns a function that puts it back (for Undo). The server is
 * only asked to delete it later, when Undo is no longer possible.
 */
export function hideMessageLocally(conversationId: string, messageId: string): () => void {
  const thread = get().threads[conversationId];
  const message = thread?.items.find((m) => m.id === messageId);
  if (!thread || !message) return () => {};
  set((state) => {
    const current = state.threads[conversationId];
    return current ? { threads: { ...state.threads, [conversationId]: { ...current, items: current.items.filter((m) => m.id !== messageId) } } } : {};
  });
  return () =>
    set((state) => {
      const current = state.threads[conversationId];
      if (!current || current.items.some((m) => m.id === messageId)) return {};
      const items = [...current.items, message].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return { threads: { ...state.threads, [conversationId]: { ...current, items } } };
    });
}

export async function deleteMessage(conversationId: string, messageId: string, scope: 'me' | 'everyone') {
  await api(`/chat/messages/${messageId}?scope=${scope}`, { method: 'DELETE' });
  if (scope === 'me')
    set((state) => {
      const thread = state.threads[conversationId];
      return thread ? { threads: { ...state.threads, [conversationId]: { ...thread, items: thread.items.filter((m) => m.id !== messageId) } } } : {};
    });
  else await refreshMessage(conversationId, messageId);
}

export async function react(conversationId: string, messageId: string, emoji: string | null) {
  const me = get().me!.userId;
  // Optimistic: show my reaction at once.
  set((state) => {
    const thread = state.threads[conversationId];
    if (!thread) return {};
    const items = thread.items.map((m) => {
      if (m.id !== messageId) return m;
      const reactions = m.reactions.map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== me) })).filter((r) => r.userIds.length);
      if (emoji) {
        const existing = reactions.find((r) => r.emoji === emoji);
        if (existing) existing.userIds.push(me);
        else reactions.push({ emoji, userIds: [me] });
      }
      return { ...m, reactions };
    });
    return { threads: { ...state.threads, [conversationId]: { ...thread, items } } };
  });
  await api(`/chat/messages/${messageId}/reaction`, { method: 'PUT', body: { emoji } });
}

export async function star(conversationId: string, messageId: string, starred: boolean) {
  await api(`/chat/messages/${messageId}/star`, { method: 'PUT', body: { starred } });
  await refreshMessage(conversationId, messageId);
}

export async function pin(conversationId: string, messageId: string, pinned: boolean) {
  await api(`/chat/messages/${messageId}/pin`, { method: 'PUT', body: { pinned, seconds: 604_800 } });
  await reloadConversation(conversationId);
}

async function refreshMessage(conversationId: string, messageId: string) {
  try {
    const { message } = await api<{ message: WireMessage }>(`/chat/messages/${messageId}`);
    const [decrypted] = await decrypt([message]);
    upsertMessage(conversationId, decrypted!);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      set((state) => {
        const thread = state.threads[conversationId];
        return thread ? { threads: { ...state.threads, [conversationId]: { ...thread, items: thread.items.filter((m) => m.id !== messageId) } } } : {};
      });
  }
}

/** A single message for reply previews that are not in the loaded page. */
export async function fetchMessage(messageId: string): Promise<ChatMessage | null> {
  try {
    const { message } = await api<{ message: WireMessage }>(`/chat/messages/${messageId}`);
    return (await decrypt([message]))[0] ?? null;
  } catch {
    return null;
  }
}

// ───────── Conversations: create and manage ─────────

export async function startDirect(userId: string): Promise<string> {
  const { conversation } = await api<{ conversation: ConversationSummary }>('/chat/conversations/direct', { method: 'POST', body: { userId } });
  await storeSummaries([conversation]);
  return conversation.id;
}

export async function createGroup(name: string, memberIds: string[], description = '') {
  const result = await api<{ conversation: ConversationSummary; notAdded: string[] }>('/chat/groups', { method: 'POST', body: { name, description, memberIds } });
  await storeSummaries([result.conversation]);
  return result;
}

export async function updateSettings(conversationId: string, settings: { mutedUntil?: string | null; archived?: boolean; pinned?: boolean; markedUnread?: boolean }) {
  const { conversation } = await api<{ conversation: ConversationSummary }>(`/chat/conversations/${conversationId}/settings`, { method: 'PATCH', body: settings });
  await storeSummaries([conversation]);
}

export const reload = reloadConversation;

// ───────── Live updates ─────────

function watchPresence() {
  const socket = realtime();
  if (!socket?.connected) return;
  const peers = Object.values(get().conversations).map((c) => c.peerId).filter((id): id is string => !!id);
  if (!peers.length) return;
  socket.emit('presence:watch', peers.slice(0, 300), (states: Array<{ userId: string; online: boolean }>) => {
    set((state) => ({ presence: { ...state.presence, ...Object.fromEntries(states.map((s) => [s.userId, { online: s.online }])) } }));
  });
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
export function setTyping(conversationId: string, active: boolean) {
  realtime()?.emit('typing', { conversationId, active });
  if (typingTimer) clearTimeout(typingTimer);
  if (active) typingTimer = setTimeout(() => realtime()?.emit('typing', { conversationId, active: false }), 4000);
}

function bindRealtime() {
  const socket = connectRealtime();
  const on = (event: string, handler: (payload: any) => void) => {
    socket.on(event, handler);
    cleanup.push(() => socket.off(event, handler));
  };
  cleanup.push(onConnectionState((connection) => set({ connection })));

  socket.on('connect', () => {
    watchPresence();
    // Catch up on anything missed while offline.
    void loadConversations().then(() => {
      const active = get().activeId;
      if (active) void loadNewer(active);
    });
  });

  on('chat:message', async ({ conversationId, messageId, senderId }: { conversationId: string; messageId: string; senderId: string }) => {
    const me = get().me?.userId;
    if (!get().conversations[conversationId]) {
      await reloadConversation(conversationId);
    } else if (get().threads[conversationId]?.loaded) {
      await loadNewer(conversationId);
    } else {
      const message = await fetchMessage(messageId);
      if (message) {
        const summary = get().conversations[conversationId]!;
        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId]: { ...summary, lastMessage: message, lastBody: message.body, unreadCount: senderId === me ? summary.unreadCount : summary.unreadCount + 1, archived: summary.mutedUntil ? summary.archived : false },
          },
        }));
      }
    }
    if (senderId !== me) {
      const summary = get().conversations[conversationId];
      if (summary && get().activeId !== conversationId && get().threads[conversationId]?.loaded)
        set((state) => ({ conversations: { ...state.conversations, [conversationId]: { ...summary, unreadCount: summary.unreadCount + 1 } } }));
      acknowledgeDelivery(conversationId);
      markRead(conversationId);
      // The sender stopped typing when the message arrived.
      set((state) => {
        const typing = { ...(state.typing[conversationId] ?? {}) };
        delete typing[senderId];
        return { typing: { ...state.typing, [conversationId]: typing } };
      });
      if (get().activeId !== conversationId && !get().conversations[conversationId]?.mutedUntil) notifyIncoming();
    }
  });

  on('chat:message-updated', ({ conversationId, messageId, change }: { conversationId: string; messageId: string; change: string }) => {
    if (change === 'expired') {
      set((state) => {
        const thread = state.threads[conversationId];
        return thread ? { threads: { ...state.threads, [conversationId]: { ...thread, items: thread.items.filter((m) => m.id !== messageId) } } } : {};
      });
      return;
    }
    if (get().threads[conversationId]?.items.some((m) => m.id === messageId)) void refreshMessage(conversationId, messageId);
    else if (get().conversations[conversationId]?.lastMessage?.id === messageId) void reloadConversation(conversationId);
  });

  on('chat:receipt', async ({ conversationId, userId }: { conversationId: string; userId: string }) => {
    if (userId === get().me?.userId) return;
    const { receipts } = await api<{ receipts: Receipts }>(`/chat/conversations/${conversationId}/receipts`);
    set((state) => ({ receipts: { ...state.receipts, [conversationId]: receipts } }));
  });

  on('chat:conversation', ({ conversationId, change }: { conversationId: string; change?: string }) => {
    deviceCache.delete(conversationId);
    if (change === 'deleted') return forgetConversation(conversationId);
    void reloadConversation(conversationId).then(() => {
      if (get().threads[conversationId]?.loaded) void loadNewer(conversationId);
    });
  });

  on('chat:history-synced', () => {
    const { activeId, threads } = get();
    set({ threads: Object.fromEntries(Object.entries(threads).filter(([id, thread]) => id === activeId || !thread.items.some((m) => m.unreadable))) });
    if (activeId) {
      const locked = threads[activeId]?.items.filter((m) => m.unreadable).slice(0, 25) ?? [];
      void Promise.all(locked.map((m) => fetchMessage(m.id))).then((messages) => {
        const byId = new Map(messages.flatMap((m) => m && !m.unreadable ? [[m.id, m] as const] : []));
        set((state) => {
          const current = state.threads[activeId];
          if (!current) return {};
          const items = current.items.map((m) => m.unreadable ? byId.get(m.id) ?? m : m);
          return { threads: { ...state.threads, [activeId]: { ...current, items } } };
        });
      }).catch(() => {});
    }
    void loadConversations().catch(() => {});
  });

  on('typing', ({ conversationId, userId, active }: { conversationId: string; userId: string; active: boolean }) => {
    set((state) => {
      const typing = { ...(state.typing[conversationId] ?? {}) };
      if (active) typing[userId] = Date.now() + 6000;
      else delete typing[userId];
      return { typing: { ...state.typing, [conversationId]: typing } };
    });
  });

  on('presence', ({ userId, online, lastSeenAt }: { userId: string; online: boolean; lastSeenAt?: string }) => {
    set((state) => ({
      presence: { ...state.presence, [userId]: { online, lastSeenAt } },
      profiles: lastSeenAt && state.profiles[userId] ? { ...state.profiles, [userId]: { ...state.profiles[userId]!, lastSeenAt } } : state.profiles,
    }));
  });

  on('session:device-revoked', ({ deviceId }: { deviceId: string }) => {
    if (deviceId === get().me?.deviceId) window.location.assign('/signin');
  });

  const onVisible = () => {
    if (document.visibilityState === 'visible' && get().activeId) markRead(get().activeId!);
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanup.push(() => document.removeEventListener('visibilitychange', onVisible));

  // Keep the socket's token fresh alongside the HTTP session refresh.
  const timer = setInterval(async () => {
    if (await refreshSession()) renewRealtimeToken();
  }, 10 * 60_000);
  cleanup.push(() => clearInterval(timer));

  // Expire stale typing indicators.
  const typingSweep = setInterval(() => {
    const now = Date.now();
    const typing = get().typing;
    let changed = false;
    const next: typeof typing = {};
    for (const [conversationId, people] of Object.entries(typing)) {
      next[conversationId] = Object.fromEntries(Object.entries(people).filter(([, until]) => until > now));
      if (Object.keys(next[conversationId]!).length !== Object.keys(people).length) changed = true;
    }
    if (changed) set({ typing: next });
  }, 1000);
  cleanup.push(() => clearInterval(typingSweep));
}

// ───────── Notifications ─────────

let audio: AudioContext | null = null;
function notifyIncoming() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.26);
  } catch {}
  // The push worker owns banners and applies the recipient's preview preferences.
}

// ───────── Lifecycle ─────────

export async function startChat(userId: string) {
  if (started) return;
  started = true;
  const account = await api<{ deviceId: string }>('/auth/account');
  await ensureDeviceKeys(account.deviceId);
  set({ me: { userId, deviceId: account.deviceId } });
  bindRealtime();
  await loadConversations();
  set({ ready: true });
}

export function stopChat() {
  started = false;
  cleanup.forEach((fn) => fn());
  cleanup = [];
  deviceCache.clear();
  olderPages.clear();
  catchUps.clear();
  readSent.clear();
  deliveredSent.clear();
  disconnectRealtime();
  resetChat();
}
