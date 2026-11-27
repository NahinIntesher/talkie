'use client';

import { create } from 'zustand';
import type { ConversationSummary, MemberInfo, Receipts, WireMessage } from '@talkie/contracts';
import type { MessageBody } from '@talkie/e2ee';

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  nickname?: string | null;
  about: string;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  showsOnline?: boolean;
  isContact?: boolean;
  blockedByMe?: boolean;
}

export interface ChatMessage extends WireMessage {
  body: MessageBody | null;
  /** Why the body is missing: sent before this device was linked, or could not be decrypted. */
  unreadable?: 'not_for_this_device' | 'failed';
  /** Local delivery state for my own messages that the server has not confirmed yet. */
  local?: 'sending' | 'failed';
}

export interface Thread {
  items: ChatMessage[];
  hasMore: boolean;
  loaded: boolean;
  latestSyncedId?: string;
  loadingPage?: boolean;
  pageFailed?: boolean;
}

export interface ChatState {
  ready: boolean;
  me: { userId: string; deviceId: string } | null;
  connection: 'connected' | 'connecting' | 'offline';
  conversations: Record<string, ConversationSummary & { lastBody?: MessageBody | null }>;
  threads: Record<string, Thread>;
  receipts: Record<string, Receipts>;
  members: Record<string, MemberInfo[]>;
  pins: Record<string, string[]>;
  profiles: Record<string, Profile>;
  typing: Record<string, Record<string, number>>;
  presence: Record<string, { online: boolean; lastSeenAt?: string }>;
  activeId: string | null;
  /** Upload progress (0–1) of my messages that are still sending, by local id. */
  uploads: Record<string, number>;
}

export const useChat = create<ChatState>(() => ({
  ready: false,
  me: null,
  connection: 'connecting',
  conversations: {},
  threads: {},
  receipts: {},
  members: {},
  pins: {},
  profiles: {},
  typing: {},
  presence: {},
  activeId: null,
  uploads: {},
}));

export const resetChat = () =>
  useChat.setState({ ready: false, me: null, conversations: {}, threads: {}, receipts: {}, members: {}, pins: {}, profiles: {}, typing: {}, presence: {}, activeId: null, uploads: {} });

/** Chat list order: pinned first, then newest activity. */
export function orderedConversations(state: ChatState) {
  return Object.values(state.conversations).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const at = a.lastMessage?.id ?? a.id;
    const bt = b.lastMessage?.id ?? b.id;
    return BigInt(bt) > BigInt(at) ? 1 : BigInt(bt) < BigInt(at) ? -1 : 0;
  });
}

/** Display name for a conversation from the viewer's point of view. */
export function conversationTitle(state: ChatState, conversation: ConversationSummary): string {
  if (conversation.group) return conversation.group.name;
  const peer = conversation.peerId ? state.profiles[conversation.peerId] : undefined;
  return peer?.nickname || peer?.displayName || (peer?.username ? `@${peer.username}` : '…');
}

export const nameOf = (state: ChatState, userId: string, you = 'You') =>
  userId === state.me?.userId ? you : state.profiles[userId]?.nickname || state.profiles[userId]?.displayName || '…';
