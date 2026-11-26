'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { Archive, ArrowLeft, BellOff, BellRing, ChevronDown, Eraser, MailOpen, MoreVertical, Phone, Pin, PinOff, Users, Video } from 'lucide-react';
import { Avatar, Button, IconButton } from '@/components/ui/primitives';
import { Dialog, Menu } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { conversationTitle, nameOf, useChat, type ChatMessage } from '@/lib/chat/store';
import { chatStrings, dayLabel, lastSeenText } from '@/lib/chat/strings';
import * as engine from '@/lib/chat/engine';
import { startCall } from '@/lib/call/engine';
import { Composer } from './composer';
import { MessageBubble, type BubbleActions } from './message-bubble';
import { previewText } from './text';

export function Thread({ conversationId, onBack, onInfo }: { conversationId: string; onBack: () => void; onInfo: () => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const toast = useToast();
  const state = useChat();
  const conversation = state.conversations[conversationId];
  const thread = state.threads[conversationId];
  const members = state.members[conversationId];
  const me = state.me?.userId;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [info, setInfo] = useState<{ message: ChatMessage; readBy: string[]; deliveredTo: string[] } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [unreadMark, setUnreadMark] = useState<string | null>(null);
  const loadingOlder = useRef(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  // Remember where unread messages began when the chat was opened.
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    const summary = useChat.getState().conversations[conversationId];
    if (!summary?.unreadCount) return setUnreadMark(null);
    const items = useChat.getState().threads[conversationId]?.items ?? [];
    const others = items.filter((m) => m.senderId !== me && m.kind !== 'system');
    setUnreadMark(others[others.length - summary.unreadCount]?.id ?? null);
  }, [conversationId, me, thread?.loaded]);

  const items = thread?.items ?? [];
  const lastId = items.at(-1)?.id;

  // Stick to the bottom when new messages arrive while already at the bottom (or when I send).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const last = items.at(-1);
    if (atBottom.current || last?.senderId === me) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }, [conversationId, thread?.loaded]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) {
      setShowJump(false);
      engine.markRead(conversationId);
    }
    if (el.scrollTop < 200 && thread?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      const before = el.scrollHeight;
      await engine.loadOlder(conversationId).catch(() => {});
      requestAnimationFrame(() => {
        el.scrollTop += el.scrollHeight - before;
        loadingOlder.current = false;
      });
    }
  };

  const jumpTo = useCallback(
    async (messageId: string) => {
      let target = document.getElementById(`m-${messageId}`);
      for (let page = 0; !target && page < 10 && useChat.getState().threads[conversationId]?.hasMore; page++) {
        await engine.loadOlder(conversationId);
        await new Promise((r) => requestAnimationFrame(r));
        target = document.getElementById(`m-${messageId}`);
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlight(messageId);
      setTimeout(() => setHighlight(null), 1600);
    },
    [conversationId],
  );

  const fail = useCallback((error: unknown) => toast(error instanceof ApiError && error.code !== 'network' ? error.message : locale === 'bn' ? 'কিছু একটা সমস্যা হয়েছে।' : 'Something went wrong.', 'error'), [toast, locale]);

  const actions = useMemo<BubbleActions>(
    () => ({
      reply: (message) => {
        setEditing(null);
        setReplyTo(message);
      },
      edit: (message) => {
        setReplyTo(null);
        setEditing(message);
      },
      remove: (message) => setDeleting(message),
      react: (message, emoji) => void engine.react(conversationId, message.id, emoji).catch(fail),
      star: (message) => void engine.star(conversationId, message.id, !message.starred).catch(fail),
      pin: (message, pinned) => void engine.pin(conversationId, message.id, pinned).catch(fail),
      info: async (message) => {
        try {
          const data = await api<{ readBy: string[]; deliveredTo: string[] }>(`/chat/messages/${message.id}/info`);
          await engine.loadProfiles([...data.readBy, ...data.deliveredTo]);
          setInfo({ message, ...data });
        } catch (error) {
          fail(error);
        }
      },
      retry: (message) => message.body?.text && void engine.sendText(conversationId, message.body.text, message.replyToId ?? undefined, message).catch(fail),
      jumpTo: (id) => void jumpTo(id),
      copy: (text) => void navigator.clipboard.writeText(text).then(() => toast(s.copied, 'success')),
    }),
    [conversationId, fail, jumpTo, toast, s.copied],
  );

  if (!conversation) return null;
  const title = conversationTitle(state, conversation);
  const peer = conversation.peerId ? state.profiles[conversation.peerId] : undefined;
  const typers = Object.keys(state.typing[conversationId] ?? {}).filter((id) => id !== me);
  const myRole = members?.find((m) => m.userId === me)?.role ?? conversation.role;
  const isAdmin = myRole === 'admin' || myRole === 'owner';
  const pins = (state.pins[conversationId] ?? []).map((id) => items.find((m) => m.id === id)).filter((m): m is ChatMessage => !!m);

  const subtitle = (() => {
    if (typers.length) return conversation.kind === 'group' ? s.typingIn.replace('{name}', nameOf(state, typers[0]!, s.you)) : s.typing;
    if (conversation.kind === 'group')
      return (members ?? []).map((m) => nameOf(state, m.userId, s.you)).slice(0, 8).join(', ') || s.members.replace('{n}', String(conversation.group?.memberCount ?? ''));
    if (conversation.peerId && state.presence[conversation.peerId]?.online) return s.online;
    const seen = state.presence[conversation.peerId ?? '']?.lastSeenAt ?? peer?.lastSeenAt;
    return seen ? lastSeenText(seen, locale) : peer ? `@${peer.username}` : '';
  })();

  const disabledReason = !conversation.active
    ? s.leftNotice
    : peer?.blockedByMe
      ? s.blockedNotice
      : conversation.group?.sendPolicy === 'admins' && !isAdmin
        ? s.adminsOnly
        : null;

  const muted = !!conversation.mutedUntil;

  return (
    <section
      className="relative flex h-full min-w-0 flex-1 flex-col"
      aria-label={title}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files') && !disabledReason) setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files') && !disabledReason) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (!event.dataTransfer.files.length || disabledReason) return;
        event.preventDefault();
        setDropped([...event.dataTransfer.files]);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-3xl border-4 border-dashed border-brand bg-brand-soft/85 backdrop-blur-sm">
          <p className="text-xl font-extrabold text-brand">{s.dropFiles}</p>
        </div>
      )}
      {/* Header */}
      <header className="z-10 flex h-16 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-2 backdrop-blur sm:px-4">
        <IconButton label={s.cancel} onClick={onBack} className="md:hidden">
          <ArrowLeft className="size-5" />
        </IconButton>
        <button onClick={onInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1.5 py-1 text-left transition-colors hover:bg-surface-2">
          {conversation.kind === 'group' && !conversation.group?.avatarUrl ? (
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-white">
              <Users className="size-5" aria-hidden />
            </span>
          ) : (
            <Avatar name={title} src={conversation.group?.avatarUrl ?? peer?.avatarUrl} size={40} />
          )}
          <span className="min-w-0">
            <span className="block truncate font-bold">{title}</span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={subtitle} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className={clsx('block truncate text-xs', typers.length || subtitle === s.online ? 'font-semibold text-success' : 'text-subtle')}>
                {subtitle}
              </motion.span>
            </AnimatePresence>
          </span>
        </button>
        <IconButton label={locale === 'bn' ? 'ভিডিও কল' : 'Video call'} disabled={!!disabledReason} onClick={() => void startCall(conversationId, 'video').then((error) => error && toast(error, 'error'))}>
          <Video className="size-5" />
        </IconButton>
        <IconButton label={locale === 'bn' ? 'ভয়েস কল' : 'Voice call'} disabled={!!disabledReason} onClick={() => void startCall(conversationId, 'audio').then((error) => error && toast(error, 'error'))}>
          <Phone className="size-5" />
        </IconButton>
        <Menu
          label={s.info}
          trigger={(props) => (
            <IconButton label={s.info} {...props}>
              <MoreVertical className="size-5" />
            </IconButton>
          )}
          items={[
            { label: conversation.kind === 'group' ? s.groupInfo : s.contactInfo, icon: <Users />, onSelect: onInfo },
            { label: muted ? s.unmute : s.mute, icon: muted ? <BellRing /> : <BellOff />, onSelect: () => void engine.updateSettings(conversationId, { mutedUntil: muted ? null : new Date(Date.now() + 8 * 3600_000).toISOString() }).catch(fail) },
            { label: conversation.pinned ? s.unpinChat : s.pinChat, icon: conversation.pinned ? <PinOff /> : <Pin />, onSelect: () => void engine.updateSettings(conversationId, { pinned: !conversation.pinned }).catch(fail) },
            {
              label: conversation.archived ? s.unarchive : s.archive,
              icon: <Archive />,
              onSelect: () => {
                const archiving = !conversation.archived;
                void engine
                  .updateSettings(conversationId, { archived: archiving })
                  .then(() => {
                    if (!archiving) return;
                    onBack();
                    toast(s.chatArchived, 'success', { label: s.undo, onClick: () => void engine.updateSettings(conversationId, { archived: false }).catch(fail) });
                  })
                  .catch(fail);
              },
            },
            { label: s.markUnread, icon: <MailOpen />, onSelect: () => void engine.updateSettings(conversationId, { markedUnread: true }).then(onBack).catch(fail) },
            {
              label: s.clear,
              icon: <Eraser />,
              danger: true,
              onSelect: async () => {
                await api(`/chat/conversations/${conversationId}/clear`, { method: 'POST' }).catch(fail);
                await engine.loadOlder(conversationId, true);
              },
            },
          ]}
        />
      </header>

      {/* Pinned messages */}
      {pins.length > 0 && (
        <button onClick={() => void jumpTo(pins[0]!.id)} className="flex items-center gap-3 border-b border-border bg-surface/95 px-4 py-2 text-left backdrop-blur transition-colors hover:bg-surface-2">
          <Pin className="size-4 shrink-0 rotate-45 text-brand" aria-hidden />
          <span className="min-w-0">
            <span className="block text-xs font-bold text-brand">{s.pinned}{pins.length > 1 ? ` · ${pins.length}` : ''}</span>
            <span className="block truncate text-sm text-muted">{previewText(state, pins[0]!, pins[0]!.body, s)}</span>
          </span>
        </button>
      )}

      {/* Messages */}
      <div ref={scroller} onScroll={onScroll} className="chat-wallpaper scrollbar-thin relative flex-1 overflow-y-auto overscroll-contain py-3" role="log" aria-live="polite" aria-relevant="additions">
        {!thread?.loaded && (
          <div className="flex h-full items-center justify-center">
            <span className="size-8 animate-spin rounded-full border-[3px] border-brand/25 border-t-brand" aria-label="Loading" />
          </div>
        )}
        {items.map((message, index) => {
          const previous = items[index - 1];
          const next = items[index + 1];
          const day = dayLabel(message.createdAt, locale);
          const newDay = !previous || dayLabel(previous.createdAt, locale) !== day;
          const sameRun = (a?: ChatMessage, b?: ChatMessage) =>
            !!a && !!b && a.senderId === b.senderId && a.kind !== 'system' && b.kind !== 'system' && Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) < 5 * 60_000;
          return (
            <div key={message.id}>
              {newDay && (
                <div className="sticky top-1 z-[5] my-3 flex justify-center">
                  <span className="rounded-xl bg-surface/95 px-3 py-1 text-xs font-semibold text-muted shadow-soft backdrop-blur">{day}</span>
                </div>
              )}
              {message.id === unreadMark && (
                <div className="my-3 flex items-center gap-3 px-6" role="separator">
                  <span className="h-px flex-1 bg-brand/30" />
                  <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand">{s.newMessages}</span>
                  <span className="h-px flex-1 bg-brand/30" />
                </div>
              )}
              <MessageBubble
                message={message}
                conversationId={conversationId}
                isGroup={conversation.kind === 'group'}
                firstOfRun={newDay || !sameRun(previous, message)}
                lastOfRun={!sameRun(message, next)}
                pinned={(state.pins[conversationId] ?? []).includes(message.id)}
                canModerate={isAdmin}
                actions={actions}
                highlighted={highlight === message.id}
              />
            </div>
          );
        })}
        {thread?.loaded && !items.length && (
          <div className="flex h-[60%] flex-col items-center justify-center text-center">
            <motion.span initial={{ scale: 0.5, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} className="text-6xl">👋</motion.span>
            <p className="mt-4 font-semibold text-muted">{s.emptyThread}</p>
          </div>
        )}
        {typers.length > 0 && (
          <div className="mt-2 flex px-3 sm:px-6" aria-hidden>
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-surface px-4 py-3 shadow-soft">
              {[0, 1, 2].map((dot) => (
                <motion.span key={dot} className="size-2 rounded-full bg-subtle" animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 0.9, delay: dot * 0.15 }} />
              ))}
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showJump && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => {
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
              setShowJump(false);
            }}
            aria-label={s.newMessages}
            className="absolute right-6 bottom-24 z-20 inline-flex size-11 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-float hover:text-text"
          >
            <ChevronDown className="size-5" />
            {conversation.unreadCount > 0 && <span className="bg-brand-gradient absolute -top-1.5 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[0.7rem] font-bold text-on-brand">{conversation.unreadCount}</span>}
          </motion.button>
        )}
      </AnimatePresence>

      <Composer
        conversationId={conversationId}
        replyTo={replyTo}
        editing={editing}
        disabledReason={disabledReason}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onSend={(text) => {
          const reply = replyTo?.id;
          setReplyTo(null);
          atBottom.current = true;
          void engine.sendText(conversationId, text, reply).catch(fail);
        }}
        dropped={dropped}
        onSendFiles={(files, caption, hd) => {
          const reply = replyTo?.id;
          setReplyTo(null);
          atBottom.current = true;
          files.forEach((file, index) => void engine.sendFile(conversationId, file, { caption: index === 0 ? caption : undefined, hd, replyToId: index === 0 ? reply : undefined }).catch(fail));
        }}
        onSendVoice={(result) => {
          atBottom.current = true;
          void engine.sendFile(conversationId, result.blob, { voice: { durationMs: result.durationMs, waveform: result.waveform }, name: `voice-${Date.now()}.${result.blob.type.includes('mp4') ? 'm4a' : 'webm'}` }).catch(fail);
        }}
        onSendPoll={(poll) => {
          atBottom.current = true;
          void engine.sendPoll(conversationId, poll).catch(fail);
        }}
        onSaveEdit={(text) => {
          const target = editing!;
          setEditing(null);
          if (text !== target.body?.text) void engine.editText(conversationId, target.id, text).catch(fail);
        }}
      />

      {/* Delete */}
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={s.deleteTitle}>
        {deleting && (
          <div className="flex flex-col gap-2 px-5 pb-5">
            <p className="mb-2 line-clamp-3 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">{previewText(state, deleting, deleting.body, s)}</p>
            {!deleting.local && !deleting.deletedAt && (deleting.senderId === me ? Date.now() - new Date(deleting.createdAt).getTime() < 48 * 3600_000 : conversation.kind === 'group' && isAdmin) && (
              <Button variant="danger" block onClick={() => { void engine.deleteMessage(conversationId, deleting.id, 'everyone').catch(fail); setDeleting(null); }}>
                {s.deleteForEveryone}
              </Button>
            )}
            <Button
              variant="outline"
              block
              onClick={() => {
                if (deleting.local) useChat.setState((st) => ({ threads: { ...st.threads, [conversationId]: { ...st.threads[conversationId]!, items: st.threads[conversationId]!.items.filter((m) => m.id !== deleting.id) } } }));
                else {
                  // Gone from the screen at once; the server is asked only after the Undo window (easy reversal).
                  const id = deleting.id;
                  const restore = engine.hideMessageLocally(conversationId, id);
                  let undone = false;
                  toast(s.messageDeleted, 'info', { label: s.undo, onClick: () => ((undone = true), restore()) });
                  setTimeout(() => {
                    if (!undone) void engine.deleteMessage(conversationId, id, 'me').catch((error) => (restore(), fail(error)));
                  }, 5500);
                }
                setDeleting(null);
              }}
            >
              {s.deleteForMe}
            </Button>
            <Button variant="ghost" block onClick={() => setDeleting(null)}>
              {s.cancel}
            </Button>
          </div>
        )}
      </Dialog>

      {/* Message info */}
      <Dialog open={!!info} onClose={() => setInfo(null)} title={s.info}>
        {info && (
          <div className="space-y-4 px-5 pb-6">
            <p className="rounded-2xl bg-brand-soft px-4 py-3 text-sm">{previewText(state, info.message, info.message.body, s)}</p>
            {[
              { label: s.readBy, ids: info.readBy, tone: 'text-sky-500' },
              { label: s.deliveredTo, ids: info.deliveredTo, tone: 'text-muted' },
            ].map((group) => (
              <div key={group.label}>
                <h3 className={clsx('mb-2 text-sm font-bold', group.tone)}>{group.label}</h3>
                {group.ids.length ? (
                  <ul className="space-y-2">
                    {group.ids.map((id) => (
                      <li key={id} className="flex items-center gap-3">
                        <Avatar name={nameOf(state, id)} src={state.profiles[id]?.avatarUrl} size={36} />
                        <span className="font-medium">{nameOf(state, id)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-subtle">-</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </section>
  );
}
