'use client';

import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { Archive, BellOff, Check, CheckCheck, Clock, MessageCirclePlus, Pin, Search, Users, X } from 'lucide-react';
import { Avatar, IconButton } from '@/components/ui/primitives';
import { useI18n } from '@/lib/i18n';
import { conversationTitle, nameOf, orderedConversations, useChat, type ChatState } from '@/lib/chat/store';
import { chatStrings, listTime } from '@/lib/chat/strings';
import { previewText } from './text';

type Filter = 'all' | 'unread' | 'groups' | 'archived';

export function ConversationList({ activeId, onOpen, onNewChat }: { activeId: string | null; onOpen: (id: string) => void; onNewChat: (query?: string) => void }) {
  const { locale, t } = useI18n();
  const s = chatStrings(locale);
  const state = useChat();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    return orderedConversations(state).filter((c) => {
      if (filter === 'archived' ? !c.archived : c.archived && !q) return false;
      if (filter === 'unread' && !(c.unreadCount > 0 || c.markedUnread)) return false;
      if (filter === 'groups' && c.kind !== 'group') return false;
      if (!q) return true;
      const peer = c.peerId ? state.profiles[c.peerId] : undefined;
      return conversationTitle(state, c).toLowerCase().includes(q) || peer?.username.includes(q);
    });
  }, [state, filter, query]);

  const archivedCount = Object.values(state.conversations).filter((c) => c.archived).length;
  const looksLikeUsername = /^@?[a-z0-9._]{3,32}$/i.test(query.trim());

  return (
    <section className="flex h-full w-full flex-col bg-surface" aria-label={t.app.chats}>
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <h1 className="text-2xl font-extrabold tracking-tight">{t.app.chats}</h1>
        <div className="flex items-center gap-1">
          <ConnectionBadge />
          <IconButton label={s.newChat} onClick={() => onNewChat()}>
            <MessageCirclePlus className="size-5" />
          </IconButton>
        </div>
      </div>

      <div className="px-4">
        <label className="flex h-11 items-center gap-2.5 rounded-2xl bg-surface-2 px-4 transition focus-within:bg-surface focus-within:ring-4 focus-within:ring-[var(--ring)]">
          <Search className="size-[1.1rem] text-subtle" aria-hidden />
          <span className="sr-only">{s.searchChats}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.app.search}
            autoCapitalize="none"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[0.95rem] outline-none placeholder:text-subtle"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label={s.cancel} className="text-subtle hover:text-text">
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>

      <div className="scrollbar-thin flex gap-2 overflow-x-auto px-4 py-3" role="tablist" aria-label={s.searchChats}>
        {(['all', 'unread', 'groups', ...(archivedCount ? (['archived'] as const) : [])] as Filter[]).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
            className={clsx(
              'h-8 shrink-0 rounded-full px-3.5 text-sm font-semibold transition-colors',
              filter === value ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted hover:text-text',
            )}
          >
            {value === 'archived' ? `${s.archived} · ${archivedCount}` : s[value]}
          </button>
        ))}
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4" role="list">
        {query && looksLikeUsername && (
          <button onClick={() => onNewChat(query.trim().replace(/^@/, ''))} className="mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-surface-2">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Search className="size-5" aria-hidden />
            </span>
            <span className="font-semibold text-brand">{s.findByUsername.replace('{u}', query.trim().replace(/^@/, '').toLowerCase())}</span>
          </button>
        )}
        <AnimatePresence initial={false}>
          {list.map((conversation) => (
            <motion.div key={conversation.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <Row id={conversation.id} active={conversation.id === activeId} onOpen={onOpen} />
            </motion.div>
          ))}
        </AnimatePresence>
        {state.ready && !list.length && (
          <div className="flex flex-col items-center px-8 py-16 text-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-brand-gradient opacity-25 blur-2xl" />
              <span className="relative inline-flex size-20 items-center justify-center rounded-[1.6rem] bg-brand-soft text-brand">
                {query ? <Search className="size-9" aria-hidden /> : <MessageCirclePlus className="size-9" aria-hidden />}
              </span>
            </div>
            <h2 className="mt-6 text-lg font-bold">{query ? s.noResults : t.app.emptyChatsTitle}</h2>
            {!query && (
              <>
                <button onClick={() => onNewChat()} className="bg-brand-gradient mt-6 rounded-2xl px-5 py-2.5 text-sm font-semibold text-white shadow-card">
                  {s.startChat}
                </button>
              </>
            )}
          </div>
        )}
        {!state.ready && <ListSkeleton />}
      </div>
    </section>
  );
}

const Row = memo(function Row({ id, active, onOpen }: { id: string; active: boolean; onOpen: (id: string) => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const state = useChat();
  const conversation = state.conversations[id];
  if (!conversation) return null;
  const title = conversationTitle(state, conversation);
  const peer = conversation.peerId ? state.profiles[conversation.peerId] : undefined;
  const last = conversation.lastMessage;
  const mine = last?.senderId === state.me?.userId;
  const typers = Object.keys(state.typing[id] ?? {});
  const unread = conversation.unreadCount > 0 || conversation.markedUnread;
  const online = conversation.peerId ? state.presence[conversation.peerId]?.online : false;
  return (
    <button
      role="listitem"
      onClick={() => onOpen(id)}
      aria-current={active ? 'true' : undefined}
      className={clsx(
        'group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors',
        active ? 'bg-brand-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="relative shrink-0">
        {conversation.kind === 'group' && !conversation.group?.avatarUrl ? (
          <span className="inline-flex size-[3.25rem] items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
            <Users className="size-6" aria-hidden />
          </span>
        ) : (
          <Avatar name={title} src={conversation.group?.avatarUrl ?? peer?.avatarUrl} size={52} />
        )}
        {online && <span className="absolute right-0.5 bottom-0.5 size-3.5 rounded-full border-[2.5px] border-surface bg-success" aria-label={s.online} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={clsx('truncate text-[0.98rem]', unread ? 'font-bold' : 'font-semibold')}>{title}</span>
          {last && <span className={clsx('shrink-0 text-xs', unread ? 'font-semibold text-brand' : 'text-subtle')}>{listTime(last.createdAt, locale)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={clsx('flex min-w-0 flex-1 items-center gap-1 truncate text-sm', unread ? 'text-text' : 'text-muted')}>
            {typers.length ? (
              <span className="truncate font-medium text-success">{conversation.kind === 'group' ? s.typingIn.replace('{name}', nameOf(state, typers[0]!, s.you)) : s.typing}</span>
            ) : last ? (
              <>
                {mine && !last.systemEvent && !last.deletedAt && <Ticks state={state} conversationId={id} messageId={last.id} />}
                {last.expiresAt && <Clock className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">
                  {conversation.kind === 'group' && !last.systemEvent && !last.deletedAt && `${nameOf(state, last.senderId, s.you)}: `}
                  {previewText(state, last, conversation.lastBody ?? null, s)}
                </span>
              </>
            ) : (
              <span className="truncate italic">{s.emptyThread}</span>
            )}
          </span>
          {conversation.mutedUntil && <BellOff className="size-4 shrink-0 text-subtle" aria-label={s.mute} />}
          {conversation.archived && <Archive className="size-4 shrink-0 text-subtle" aria-hidden />}
          {conversation.pinned && !unread && <Pin className="size-4 shrink-0 rotate-45 text-subtle" aria-label={s.pinChat} />}
          {unread && (
            <span className={clsx('inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.7rem] font-bold text-white', conversation.mutedUntil ? 'bg-subtle' : 'bg-brand-gradient')}>
              {conversation.unreadCount > 0 ? (conversation.unreadCount > 99 ? '99+' : conversation.unreadCount) : ''}
            </span>
          )}
        </span>
      </span>
    </button>
  );
});

export function Ticks({ state, conversationId, messageId, className }: { state: ChatState; conversationId: string; messageId: string; className?: string }) {
  const receipts = state.receipts[conversationId];
  const reached = (mark?: string) => !!mark && mark !== '0' && BigInt(mark) >= BigInt(messageId);
  if (messageId.startsWith('local:')) return <Clock className={clsx('size-3.5 shrink-0', className)} aria-label="sending" />;
  if (reached(receipts?.read)) return <CheckCheck className={clsx('size-4 shrink-0 text-sky-500', className)} aria-label="read" />;
  if (reached(receipts?.delivered)) return <CheckCheck className={clsx('size-4 shrink-0', className)} aria-label="delivered" />;
  return <Check className={clsx('size-4 shrink-0', className)} aria-label="sent" />;
}

function ConnectionBadge() {
  const { locale } = useI18n();
  const connection = useChat((state) => state.connection);
  if (connection === 'connected') return null;
  const s = chatStrings(locale);
  return (
    <span className="mr-1 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted" role="status">
      <span className={clsx('size-2 rounded-full', connection === 'offline' ? 'bg-danger' : 'animate-pulse bg-warning')} />
      {connection === 'offline' ? s.offline : s.connecting}
    </span>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-hidden>
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-2.5">
          <div className="size-[3.25rem] animate-pulse rounded-full bg-surface-3" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 animate-pulse rounded bg-surface-3" style={{ width: `${45 + ((index * 17) % 35)}%` }} />
            <div className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${30 + ((index * 23) % 45)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
