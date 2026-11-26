'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { AlertCircle, Ban, ChevronDown, Clock, Copy, Forward, Info, Lock, Pencil, Pin, PinOff, Reply, SmilePlus, Star, StarOff, Trash2 } from 'lucide-react';
import { DELETE_FOR_EVERYONE_WINDOW_MS, EDIT_WINDOW_MS, type AttachmentRef, type PollBody } from '@talkie/contracts';
import { DocumentAttachment, ImageAttachment, PollView, VideoAttachment, VoiceAttachment } from './attachments';
import { CallLine } from './call-line';
import { useI18n } from '@/lib/i18n';
import { nameOf, useChat, type ChatMessage } from '@/lib/chat/store';
import { chatStrings, timeOf } from '@/lib/chat/strings';
import { Ticks } from './conversation-list';
import { previewText, systemText } from './text';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface BubbleActions {
  reply: (message: ChatMessage) => void;
  edit: (message: ChatMessage) => void;
  remove: (message: ChatMessage) => void;
  react: (message: ChatMessage, emoji: string | null) => void;
  star: (message: ChatMessage) => void;
  pin: (message: ChatMessage, pinned: boolean) => void;
  info: (message: ChatMessage) => void;
  retry: (message: ChatMessage) => void;
  jumpTo: (messageId: string) => void;
  copy: (text: string) => void;
}

const linkify = (text: string) =>
  text.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a key={index} href={part} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline underline-offset-2 hover:opacity-80">
        {part}
      </a>
    ) : (
      part
    ),
  );

const onlyEmoji = (text: string) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,12}$/u.test(text) && [...text.replace(/\s/g, '')].length <= 6;

export const MessageBubble = memo(function MessageBubble({
  message,
  conversationId,
  isGroup,
  firstOfRun,
  lastOfRun,
  pinned,
  canModerate,
  actions,
  highlighted,
}: {
  message: ChatMessage;
  conversationId: string;
  isGroup: boolean;
  firstOfRun: boolean;
  lastOfRun: boolean;
  pinned: boolean;
  canModerate: boolean;
  actions: BubbleActions;
  highlighted: boolean;
}) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const state = useChat();
  const me = state.me?.userId;
  const mine = message.senderId === me;
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [upward, setUpward] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu && !picker) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setMenu(false);
        setPicker(false);
      }
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (setMenu(false), setPicker(false));
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu, picker]);

  if (message.systemEvent?.type === 'call' && message.systemEvent.call) return <CallLine message={message} />;

  if (message.kind === 'system' && message.systemEvent) {
    return (
      <div className="my-2 flex justify-center px-4">
        <span className="max-w-[85%] rounded-xl bg-surface/90 px-3 py-1.5 text-center text-xs font-medium text-muted shadow-soft">{systemText(state, message.systemEvent, s)}</span>
      </div>
    );
  }

  const deleted = !!message.deletedAt;
  const text = message.body?.text ?? '';
  const attachments = message.body?.attachments as AttachmentRef[] | undefined;
  const poll = message.body?.poll as PollBody | undefined;
  const uploading = state.uploads[message.id] ?? null;
  const emojiOnly = !deleted && !!text && !attachments && onlyEmoji(text);
  const age = Date.now() - new Date(message.createdAt).getTime();
  const local = message.id.startsWith('local:');
  const canEdit = mine && !deleted && !local && message.kind === 'text' && age < EDIT_WINDOW_MS;
  const canDeleteEveryone = !deleted && !local && ((mine && age < DELETE_FOR_EVERYONE_WINDOW_MS) || (isGroup && canModerate));
  const myReaction = message.reactions.find((r) => me && r.userIds.includes(me))?.emoji ?? null;
  const reply = message.replyToId ? state.threads[conversationId]?.items.find((m) => m.id === message.replyToId) : undefined;

  const menuItems = [
    { label: s.reply, icon: <Reply />, run: () => actions.reply(message), show: !deleted && !local },
    { label: s.copy, icon: <Copy />, run: () => actions.copy(text), show: !!text && !deleted },
    { label: s.edit, icon: <Pencil />, run: () => actions.edit(message), show: canEdit },
    { label: message.starred ? s.unstar : s.star, icon: message.starred ? <StarOff /> : <Star />, run: () => actions.star(message), show: !deleted && !local },
    { label: pinned ? s.unpin : s.pin, icon: pinned ? <PinOff /> : <Pin />, run: () => actions.pin(message, !pinned), show: !deleted && !local },
    { label: s.info, icon: <Info />, run: () => actions.info(message), show: mine && !local && !deleted },
    { label: s.delete, icon: <Trash2 />, run: () => actions.remove(message), show: !local || message.local === 'failed', danger: true },
  ].filter((item) => item.show);

  return (
    <div
      ref={box}
      id={`m-${message.id}`}
      className={clsx('group/msg relative flex px-3 sm:px-6', mine ? 'justify-end' : 'justify-start', firstOfRun ? 'mt-2' : 'mt-0.5', message.reactions.length && 'mb-3')}
      onDoubleClick={() => !deleted && !local && actions.react(message, myReaction === '❤️' ? null : '❤️')}
    >
      <div className={clsx('relative flex max-w-[min(78%,38rem)] flex-col', mine ? 'items-end' : 'items-start')}>
        <motion.div
          initial={local ? { opacity: 0, y: 8, scale: 0.98 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className={clsx(
            'relative min-w-[5.5rem] px-3 pt-1.5 pb-1 text-[0.95rem] leading-relaxed shadow-soft transition-[box-shadow,background]',
            emojiOnly && '!bg-transparent px-1 !shadow-none',
            mine ? 'bg-[var(--bubble-out)] text-[var(--bubble-out-text)]' : 'bg-surface text-text',
            mine ? (lastOfRun ? 'rounded-2xl rounded-br-md' : 'rounded-2xl rounded-r-md') : lastOfRun ? 'rounded-2xl rounded-bl-md' : 'rounded-2xl rounded-l-md',
            highlighted && 'ring-4 ring-[var(--ring)]',
            message.local === 'failed' && 'ring-2 ring-danger/60',
          )}
        >
          {isGroup && !mine && firstOfRun && <p className={clsx('mb-0.5 text-[0.8rem] font-bold', senderTone(message.senderId))}>{nameOf(state, message.senderId, s.you)}</p>}
          {message.forwardedCount > 0 && !deleted && (
            <p className="mb-0.5 flex items-center gap-1 text-xs font-medium opacity-75">
              <Forward className="size-3.5" aria-hidden />
              {s.forwarded}
            </p>
          )}
          {message.replyToId && !deleted && (
            <button
              onClick={() => actions.jumpTo(message.replyToId!)}
              className={clsx('mb-1 block w-full rounded-lg border-l-4 px-2.5 py-1.5 text-left text-[0.82rem]', mine ? 'border-[var(--bubble-ink-70)] bg-[var(--bubble-ink-12)]' : 'border-brand bg-surface-2')}
            >
              <span className={clsx('block text-xs font-bold', mine ? 'text-[var(--bubble-out-text)]' : 'text-brand')}>{reply ? nameOf(state, reply.senderId, s.you) : '…'}</span>
              <span className="line-clamp-2 opacity-80">{reply ? previewText(state, reply, reply.body, s) : '…'}</span>
            </button>
          )}
          {deleted ? (
            <p className="flex items-center gap-1.5 text-[0.92rem] opacity-75">
              <Ban className="size-4" aria-hidden />
              {mine ? s.deletedByMe : s.deleted}
            </p>
          ) : message.body ? (
            <>
              {attachments?.map((attachment) =>
                message.kind === 'image' ? (
                  <ImageAttachment key={attachment.mediaId} attachment={attachment} uploading={uploading} />
                ) : message.kind === 'video' ? (
                  <VideoAttachment key={attachment.mediaId} attachment={attachment} uploading={uploading} />
                ) : message.kind === 'voice' ? (
                  <VoiceAttachment key={attachment.mediaId} attachment={attachment} uploading={uploading} mine={mine} senderId={message.senderId} />
                ) : (
                  <DocumentAttachment key={attachment.mediaId} attachment={attachment} uploading={uploading} mine={mine} />
                ),
              )}
              {poll && <PollView poll={poll} conversationId={conversationId} messageId={message.id} votes={message.pollVotes ?? []} mine={mine} />}
              {text && <p className={clsx('break-words whitespace-pre-wrap', emojiOnly && 'text-5xl leading-tight')}>{linkify(text)}</p>}
            </>
          ) : (
            <p className="flex items-center gap-1.5 text-[0.9rem] leading-snug opacity-75">
              <Lock className="size-4" aria-hidden />
              {message.unreadable === 'not_for_this_device' ? s.notForDevice : s.decryptFailed}
            </p>
          )}
          <span className={clsx('float-right mt-1 ml-3 flex translate-y-0.5 items-center gap-1 text-[0.68rem] select-none', mine ? 'text-[var(--bubble-out-meta)]' : 'text-subtle', emojiOnly && 'rounded-full bg-surface/80 px-2 py-0.5 text-subtle')}>
            {message.starred && <Star className="size-3 fill-current" aria-label={s.star} />}
            {message.expiresAt && <Clock className="size-3" aria-hidden />}
            {message.editedAt && !deleted && <span>{s.edited}</span>}
            <time dateTime={message.createdAt}>{timeOf(message.createdAt, locale)}</time>
            {mine && !deleted && (message.local === 'failed' ? <AlertCircle className="size-3.5 text-danger" /> : <Ticks state={state} conversationId={conversationId} messageId={message.id} className={clsx(!emojiOnly && '[&:not(.text-sky-500)]:opacity-90')} />)}
          </span>
        </motion.div>

        {message.local === 'failed' && (
          <button onClick={() => actions.retry(message)} className="mt-1 text-xs font-semibold text-danger hover:underline">
            {s.failed}
          </button>
        )}

        {message.reactions.length > 0 && (
          <div className={clsx('absolute -bottom-3.5 z-10 flex gap-0.5 rounded-full border border-border bg-surface px-1.5 py-0.5 text-sm shadow-soft', mine ? 'right-16' : 'left-2')}>
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => actions.react(message, reaction.userIds.includes(me ?? '') ? null : reaction.emoji)}
                title={reaction.userIds.map((id) => nameOf(state, id, s.you)).join(', ')}
                className={clsx('flex items-center gap-0.5 rounded-full px-1', reaction.userIds.includes(me ?? '') && 'bg-brand-soft')}
              >
                {reaction.emoji}
                {reaction.userIds.length > 1 && <span className="text-[0.7rem] font-semibold text-muted">{reaction.userIds.length}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Hover actions */}
        {!deleted && !local && (
          <div className={clsx('absolute top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100', mine ? '-left-20' : '-right-20', (menu || picker) && 'opacity-100')}>
            <button aria-label={s.react} onClick={() => { setPicker((v) => !v); setMenu(false); }} className="inline-flex size-8 items-center justify-center rounded-full bg-surface text-muted shadow-soft hover:text-text">
              <SmilePlus className="size-4" />
            </button>
            <button aria-label={s.reply} onClick={() => actions.reply(message)} className="inline-flex size-8 items-center justify-center rounded-full bg-surface text-muted shadow-soft hover:text-text">
              <Reply className="size-4" />
            </button>
          </div>
        )}
        <button
          aria-label="Message options"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            // Open above the bubble when it sits near the bottom of the screen.
            const rect = box.current?.getBoundingClientRect();
            setUpward(!!rect && window.innerHeight - rect.top < 330);
            setMenu((v) => !v);
            setPicker(false);
          }}
          className={clsx('absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-full opacity-0 transition-opacity group-hover/msg:opacity-100 focus:opacity-100', mine ? 'bg-[var(--bubble-out)] text-[var(--bubble-out-meta)]' : 'bg-surface text-subtle', menu && 'opacity-100')}
        >
          <ChevronDown className="size-4" />
        </button>

        <AnimatePresence>
          {picker && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 6 }}
              className={clsx('glass absolute bottom-full z-30 mb-2 flex gap-1 rounded-full border border-border p-1.5 shadow-float', mine ? 'right-0' : 'left-0')}
              role="menu"
              aria-label={s.react}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  role="menuitem"
                  onClick={() => {
                    actions.react(message, myReaction === emoji ? null : emoji);
                    setPicker(false);
                  }}
                  className={clsx('inline-flex size-10 items-center justify-center rounded-full text-2xl transition-transform hover:scale-125', myReaction === emoji && 'bg-brand-soft')}
                >
                  {emoji}
                </button>
              ))}
            </motion.div>
          )}
          {menu && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.12 }}
              className={clsx('absolute z-30 min-w-48 rounded-2xl border border-border bg-surface p-1.5 shadow-float', upward ? 'bottom-full mb-1' : 'top-8', mine ? 'right-0' : 'left-0')}
            >
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    item.run();
                  }}
                  className={clsx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium [&_svg]:size-4', item.danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-surface-2')}
                >
                  <span className={item.danger ? '' : 'text-muted'}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});

const tones = ['text-indigo-500', 'text-fuchsia-500', 'text-emerald-600', 'text-amber-600', 'text-sky-600', 'text-rose-500', 'text-teal-600', 'text-violet-500'];
const senderTone = (id: string) => tones[Number(BigInt(id) % BigInt(tones.length))];
