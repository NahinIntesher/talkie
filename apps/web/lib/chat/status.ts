'use client';

import { create } from 'zustand';
import * as e2ee from '@talkie/e2ee';
import type { AttachmentRef, DeviceKey, PrivacyAudience, StatusViewer, WireStatus } from '@talkie/contracts';
import { api } from '../api';
import { realtime } from '../realtime';
import { deviceKeys, rememberKeys, senderKeys } from './keys';
import { loadProfiles } from './engine';
import { prepareImage, prepareVideo, primeAttachment, uploadEncrypted } from './media';
import { useChat } from './store';

export interface StatusBody extends e2ee.MessageBody {
  text?: string;
  background?: string;
  font?: number;
  attachment?: AttachmentRef;
}

export interface StatusItem extends Omit<WireStatus, 'ciphertext' | 'nonce' | 'sealedKey'> {
  body: StatusBody | null;
  viewCount?: number;
}

export interface StatusGroup {
  ownerId: string;
  items: StatusItem[];
  allViewed: boolean;
  latestAt: string;
}

interface StatusState {
  loaded: boolean;
  mine: StatusItem[];
  groups: StatusGroup[];
  muted: string[];
}

export const useStatus = create<StatusState>(() => ({ loaded: false, mine: [], groups: [], muted: [] }));

export const STATUS_BACKGROUNDS = ['#d97706', '#b45309', '#db2777', '#0ea5e9', '#059669', '#7c3aed', '#dc2626', '#0f172a'];
export const STATUS_FONTS = ['font-sans', 'font-serif', 'font-mono', 'italic font-semibold'];

async function decrypt(list: Array<WireStatus & { viewCount?: number }>): Promise<StatusItem[]> {
  const keys = deviceKeys();
  const known = await senderKeys(list.map((s) => s.senderDeviceId)).catch(() => new Map<string, string>());
  return list.map(({ ciphertext, nonce, sealedKey, ...rest }) => {
    let body: StatusBody | null = null;
    try {
      if (keys && sealedKey && known.get(rest.senderDeviceId)) body = e2ee.open({ ciphertext, nonce, sealedKey }, known.get(rest.senderDeviceId)!, keys.pair) as StatusBody;
    } catch {}
    return { ...rest, body };
  });
}

export async function loadStatus() {
  const feed = await api<{ mine: Array<WireStatus & { viewCount: number }>; others: WireStatus[]; mutedOwnerIds: string[] }>('/chat/status/feed');
  const [mine, others] = await Promise.all([decrypt(feed.mine), decrypt(feed.others)]);
  const byOwner = new Map<string, StatusItem[]>();
  for (const item of others.filter((s) => s.body)) byOwner.set(item.ownerId, [...(byOwner.get(item.ownerId) ?? []), item]);
  const groups = [...byOwner.entries()]
    .map(([ownerId, items]) => ({ ownerId, items, allViewed: items.every((i) => i.viewed), latestAt: items.at(-1)!.createdAt }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  void loadProfiles(groups.map((g) => g.ownerId));
  useStatus.setState({ loaded: true, mine, groups, muted: feed.mutedOwnerIds });
}

/** Who sees my status, following my Status privacy choice (set in Settings → Privacy). */
async function audience(): Promise<string[]> {
  const [{ privacy }, { contacts }] = await Promise.all([
    api<{ privacy: Record<string, PrivacyAudience> }>('/users/me'),
    api<{ contacts: Array<{ id: string }> }>('/users/me/contacts'),
  ]);
  if (privacy.status === 'nobody') return [];
  const people = new Set(contacts.map((c) => c.id));
  if (privacy.status === 'everyone')
    for (const conversation of Object.values(useChat.getState().conversations)) if (conversation.peerId) people.add(conversation.peerId);
  return [...people];
}

async function post(kind: 'text' | 'image' | 'video', body: StatusBody, mediaId?: string) {
  const keys = deviceKeys();
  if (!keys) throw new Error('Device keys are not ready');
  const people = await audience();
  const { devices } = await api<{ devices: DeviceKey[] }>('/chat/status/devices', { method: 'POST', body: { userIds: people } });
  rememberKeys(devices);
  const sealed = e2ee.seal(body, keys.pair, devices);
  const result = await api<{ sharedWith: number }>('/chat/status', { method: 'POST', body: { kind, ...sealed, audience: people, ...(mediaId ? { mediaId } : {}) } });
  await loadStatus();
  return result.sharedWith;
}

export const postTextStatus = (text: string, background: string, font: number) => post('text', { v: 1, text, background, font });

export async function postMediaStatus(file: File, caption: string, onProgress?: (fraction: number) => void) {
  const video = file.type.startsWith('video/');
  if (file.size > 64 * 1024 * 1024) throw new Error('Status videos can be up to 64 MB.');
  let upload: Blob = file;
  const ref: Partial<AttachmentRef> = { mime: file.type, name: file.name, size: file.size };
  if (video) Object.assign(ref, await prepareVideo(file));
  else {
    const prepared = await prepareImage(file);
    upload = prepared.blob;
    Object.assign(ref, { width: prepared.width, height: prepared.height, thumb: prepared.thumb, size: prepared.blob.size, mime: prepared.blob.type || file.type });
  }
  const uploaded = await uploadEncrypted(upload, 'status', onProgress);
  primeAttachment(uploaded.mediaId, upload);
  return post(video ? 'video' : 'image', { v: 1, ...(caption ? { text: caption } : {}), attachment: { ...(ref as AttachmentRef), ...uploaded } }, uploaded.mediaId);
}

const viewedSent = new Set<string>();
export function markViewed(item: StatusItem) {
  if (item.viewed || viewedSent.has(item.id) || item.ownerId === useChat.getState().me?.userId) return;
  viewedSent.add(item.id);
  useStatus.setState((state) => ({
    groups: state.groups.map((g) => {
      if (g.ownerId !== item.ownerId) return g;
      const items = g.items.map((i) => (i.id === item.id ? { ...i, viewed: true } : i));
      return { ...g, items, allViewed: items.every((i) => i.viewed) };
    }),
  }));
  void api(`/chat/status/${item.id}/view`, { method: 'POST', body: {} }).catch(() => viewedSent.delete(item.id));
}

export const reactToStatus = (id: string, reaction: string) => api(`/chat/status/${id}/view`, { method: 'POST', body: { reaction } });

export async function statusViewers(id: string): Promise<StatusViewer[]> {
  const { viewers } = await api<{ viewers: StatusViewer[] }>(`/chat/status/${id}/viewers`);
  void loadProfiles(viewers.map((v) => v.userId));
  return viewers;
}

export async function deleteStatus(id: string) {
  await api(`/chat/status/${id}`, { method: 'DELETE' });
  await loadStatus();
}

export async function muteStatus(userId: string, muted: boolean) {
  await api(`/chat/status/mutes/${userId}`, { method: 'PUT', body: { muted } });
  await loadStatus();
}

let bound = false;
/** Live: reload the feed when someone posts, views or deletes a status. */
export function watchStatus() {
  const socket = realtime();
  if (!socket || bound) return;
  bound = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  socket.on('status:update', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadStatus().catch(() => {}), 300);
  });
}
