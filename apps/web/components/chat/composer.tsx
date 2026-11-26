'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { BarChart3, FileText, Image as ImageIcon, Paperclip, Pencil, Reply, SendHorizontal, Smile, X } from 'lucide-react';
import type { PollBody } from '@talkie/contracts';
import { Menu } from '@/components/ui/overlay';
import { AttachDialog, MicButton, PollDialog, validFiles, VoiceRecorder } from './compose-extras';
import { useI18n } from '@/lib/i18n';
import { nameOf, useChat, type ChatMessage } from '@/lib/chat/store';
import { chatStrings } from '@/lib/chat/strings';
import { setTyping } from '@/lib/chat/engine';
import { useToast } from '@/components/ui/toast';
import { previewText } from './text';

const EMOJI = {
  smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😜', '🤪', '🤗', '🤭', '🤔', '😐', '😏', '😌', '😴', '😎', '🥳', '😢', '😭', '😤', '😡', '🥺', '😱', '🤯', '😬'],
  gestures: ['👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌', '🙏', '💪', '👋', '🤙', '👀', '🫶'],
  hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕', '💯', '🔥', '✨', '⭐', '🎉', '🎊'],
  things: ['☕', '🍵', '🍕', '🍔', '🍰', '🎂', '⚽', '🏏', '🎮', '🎧', '📚', '✈️', '🏕️', '🌙', '☀️', '🌧️', '🌸', '🌹'],
};

/**
 * Unsent text per chat, kept while the tab is open, including when switching chats (the composer is recreated per
 * chat). Memory only: drafts of end-to-end encrypted chats are never written to disk.
 */
const drafts = new Map<string, string>();

export function Composer({
  conversationId,
  replyTo,
  editing,
  disabledReason,
  onCancelReply,
  onCancelEdit,
  onSend,
  onSaveEdit,
  onSendFiles,
  onSendVoice,
  onSendPoll,
  dropped,
}: {
  conversationId: string;
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  disabledReason: string | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (text: string) => void;
  onSaveEdit: (text: string) => void;
  onSendFiles: (files: File[], caption: string, hd: boolean) => void;
  onSendVoice: (result: { blob: Blob; durationMs: number; waveform: number[] }) => void;
  onSendPoll: (poll: PollBody) => void;
  /** Files dropped onto the conversation. */
  dropped: File[];
}) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const toast = useToast();
  const state = useChat();
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pollOpen, setPollOpen] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dropped.length) setFiles(validFiles(dropped, s, toast));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);
  const input = useRef<HTMLTextAreaElement>(null);

  // Each conversation keeps its own unsent draft.
  useEffect(() => {
    setText(drafts.get(conversationId) ?? '');
    setEmoji(false);
    input.current?.focus();
  }, [conversationId]);

  useEffect(() => {
    if (editing) {
      setText(editing.body?.text ?? '');
      input.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  // Auto-grow up to six lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    if (!editing) drafts.set(conversationId, value);
    setTyping(conversationId, value.trim().length > 0);
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (value.length > 65_000) return toast(locale === 'bn' ? 'মেসেজটি অনেক বড়।' : 'This message is too long.', 'error');
    if (editing) onSaveEdit(value);
    else onSend(value);
    setText('');
    drafts.delete(conversationId);
    setTyping(conversationId, false);
    setEmoji(false);
  };

  if (disabledReason)
    return <div className="border-t border-border bg-surface px-6 py-4 text-center text-sm font-medium text-muted">{disabledReason}</div>;

  const banner = editing ?? replyTo;
  return (
    <div className="relative border-t border-border bg-surface/95 px-3 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-4">
      <AnimatePresence>
        {banner && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mb-2 flex items-center gap-3 rounded-2xl bg-surface-2 py-2 pr-2 pl-3">
              <span className="text-brand">{editing ? <Pencil className="size-4" /> : <Reply className="size-4" />}</span>
              <div className="min-w-0 flex-1 border-l-2 border-brand pl-3">
                <p className="text-xs font-bold text-brand">{editing ? s.editing : s.replyingTo.replace('{name}', nameOf(state, banner.senderId, s.you))}</p>
                <p className="truncate text-sm text-muted">{previewText(state, banner, banner.body, s)}</p>
              </div>
              <button
                onClick={() => {
                  if (editing) {
                    onCancelEdit();
                    setText(drafts.get(conversationId) ?? '');
                  } else onCancelReply();
                }}
                aria-label={s.cancel}
                className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-3"
              >
                <X className="size-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {emoji && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="glass absolute right-3 bottom-full left-3 z-20 mb-2 max-h-72 overflow-y-auto rounded-3xl border border-border p-3 shadow-float sm:right-auto sm:w-96"
          >
            {Object.entries(EMOJI).map(([group, list]) => (
              <div key={group} className="mb-2">
                <div className="grid grid-cols-8 gap-1">
                  {list.map((char) => (
                    <button
                      key={char}
                      onClick={() => {
                        const el = input.current;
                        const start = el?.selectionStart ?? text.length;
                        const end = el?.selectionEnd ?? text.length;
                        update(text.slice(0, start) + char + text.slice(end));
                        requestAnimationFrame(() => {
                          el?.focus();
                          el?.setSelectionRange(start + char.length, start + char.length);
                        });
                      }}
                      className="inline-flex size-10 items-center justify-center rounded-xl text-2xl transition-transform hover:scale-110 hover:bg-surface-2"
                    >
                      {char}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <input
        ref={mediaInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(event) => {
          setFiles(validFiles([...(event.target.files ?? [])], s, toast));
          event.target.value = '';
        }}
      />
      <input
        ref={docInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          setFiles(validFiles([...(event.target.files ?? [])], s, toast));
          event.target.value = '';
        }}
      />
      <div className="flex items-end gap-2">
        {recording ? (
          <VoiceRecorder
            onCancel={() => setRecording(false)}
            onSend={(result) => {
              setRecording(false);
              onSendVoice(result);
            }}
          />
        ) : (
          <>
            <div className="flex min-h-12 flex-1 items-end gap-1 rounded-[1.5rem] border border-border bg-surface-2 px-2 py-1.5 transition focus-within:border-transparent focus-within:bg-surface focus-within:ring-1 focus-within:ring-[var(--ring-field)]">
              <button onClick={() => setEmoji((v) => !v)} aria-label="Emoji" aria-pressed={emoji} className={clsx('inline-flex size-9 shrink-0 items-center justify-center rounded-full transition-colors', emoji ? 'text-brand' : 'text-muted hover:text-text')}>
                <Smile className="size-[1.35rem]" />
              </button>
              <textarea
                ref={input}
                rows={1}
                value={text}
                onChange={(event) => update(event.target.value)}
                onPaste={(event) => {
                  const pasted = [...event.clipboardData.files];
                  if (pasted.length) {
                    event.preventDefault();
                    setFiles(validFiles(pasted, s, toast));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  } else if (event.key === 'Escape') {
                    if (editing) onCancelEdit();
                    else if (replyTo) onCancelReply();
                  } else if (event.key === 'ArrowUp' && !text) {
                    const mine = [...(state.threads[conversationId]?.items ?? [])].reverse().find((m) => m.senderId === state.me?.userId && m.body?.text && !m.deletedAt && !m.local);
                    if (mine) document.getElementById(`m-${mine.id}`)?.scrollIntoView({ block: 'center' });
                  }
                }}
                placeholder={s.message}
                aria-label={s.message}
                className="max-h-42 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[0.97rem] leading-6 outline-none placeholder:text-subtle"
              />
              {!editing && (
                <div className="shrink-0 [&>div>div[role=menu]]:top-auto [&>div>div[role=menu]]:bottom-full [&>div>div[role=menu]]:mb-2">
                  <Menu
                    label="Attach"
                    trigger={(props) => (
                      <button {...props} aria-label="Attach" className="inline-flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:text-text">
                        <Paperclip className="size-5" />
                      </button>
                    )}
                    items={[
                      { label: s.photosVideos, icon: <ImageIcon className="text-amber-500" />, onSelect: () => mediaInput.current?.click() },
                      { label: s.document, icon: <FileText className="text-sky-500" />, onSelect: () => docInput.current?.click() },
                      { label: s.poll, icon: <BarChart3 className="text-amber-500" />, onSelect: () => setPollOpen(true) },
                    ]}
                  />
                </div>
              )}
            </div>
            {text.trim() || editing ? (
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={submit}
                disabled={!text.trim()}
                aria-label={editing ? s.edit : s.send}
                className="bg-brand-gradient inline-flex size-12 shrink-0 items-center justify-center rounded-full text-on-brand shadow-[0_10px_24px_-10px_var(--brand)] transition-opacity disabled:opacity-45"
              >
                <SendHorizontal className="size-5" />
              </motion.button>
            ) : (
              <MicButton label={s.voice} onClick={() => setRecording(true)} />
            )}
          </>
        )}
      </div>
      <AttachDialog
        files={files}
        onClose={() => setFiles([])}
        onSend={(list, caption, hd) => {
          setFiles([]);
          onSendFiles(list, caption, hd);
        }}
      />
      <PollDialog
        open={pollOpen}
        onClose={() => setPollOpen(false)}
        onCreate={(poll) => {
          setPollOpen(false);
          onSendPoll(poll);
        }}
      />
    </div>
  );
}
