'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Eye, Image as ImageIcon, Pause, Pencil, Play, Plus, SendHorizontal, Trash2, Type, X } from 'lucide-react';
import { Avatar, IconButton } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { nameOf, useChat } from '@/lib/chat/store';
import { lastSeenText, timeOf } from '@/lib/chat/strings';
import { openAttachment } from '@/lib/chat/media';
import * as engine from '@/lib/chat/engine';
import {
  deleteStatus,
  loadStatus,
  markViewed,
  postMediaStatus,
  postTextStatus,
  reactToStatus,
  STATUS_BACKGROUNDS,
  STATUS_FONTS,
  statusViewers,
  useStatus,
  watchStatus,
  type StatusItem,
} from '@/lib/chat/status';

const copy = {
  en: {
    title: 'Status',
    myStatus: 'My status',
    addUpdate: 'Tap to add a status update',
    recent: 'Recent updates',
    viewed: 'Viewed updates',
    none: 'No updates from your contacts yet',
    text: 'Text',
    photo: 'Photo or video',
    typeStatus: 'Type a status',
    caption: 'Add a caption…',
    posting: 'Sharing…',
    posted: 'Status shared',
    viewers: '{n} views',
    reply: 'Reply…',
    deleteStatus: 'Delete status',
    sent: 'Reply sent',
    ago: 'Just now',
    sharedWith: 'shared with {n}',
    nobody: 'Shared with no one yet: add people to your contacts, or change who can see your status in Settings → Privacy.',
  },
  bn: {
    title: 'স্ট্যাটাস',
    myStatus: 'আমার স্ট্যাটাস',
    addUpdate: 'স্ট্যাটাস যোগ করতে চাপুন',
    recent: 'সাম্প্রতিক আপডেট',
    viewed: 'দেখা আপডেট',
    none: 'আপনার কন্টাক্টদের কোনো আপডেট এখনো নেই',
    text: 'লেখা',
    photo: 'ছবি বা ভিডিও',
    typeStatus: 'স্ট্যাটাস লিখুন',
    caption: 'ক্যাপশন যোগ করুন…',
    posting: 'শেয়ার হচ্ছে…',
    posted: 'স্ট্যাটাস শেয়ার হয়েছে',
    viewers: '{n} জন দেখেছেন',
    reply: 'রিপ্লাই…',
    deleteStatus: 'স্ট্যাটাস মুছুন',
    sent: 'রিপ্লাই পাঠানো হয়েছে',
    ago: 'এইমাত্র',
    sharedWith: '{n} জনের সাথে',
    nobody: 'এখনো কারো সাথে শেয়ার হয়নি: কন্টাক্টে মানুষ যোগ করুন, অথবা সেটিংস → গোপনীয়তা → স্ট্যাটাস বদলান।',
  },
};

export default function StatusPage() {
  const { locale } = useI18n();
  const t = copy[locale];
  const { user } = useSession();
  const chat = useChat();
  const status = useStatus();
  const toast = useToast();
  const [viewing, setViewing] = useState<{ ownerId: string; index: number } | null>(null);
  const [composer, setComposer] = useState<'text' | null>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [posting, setPosting] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!chat.ready) return;
    void loadStatus().catch(() => toast(locale === 'bn' ? 'স্ট্যাটাস লোড হয়নি' : 'Could not load status', 'error'));
    watchStatus();
  }, [chat.ready, locale, toast]);

  const recent = status.groups.filter((g) => !g.allViewed && !status.muted.includes(g.ownerId));
  const seen = status.groups.filter((g) => g.allViewed && !status.muted.includes(g.ownerId));
  const ownerItems = (ownerId: string) => (ownerId === user?.id ? status.mine : status.groups.find((g) => g.ownerId === ownerId)?.items ?? []);

  const share = async (job: () => Promise<number>) => {
    setPosting(0);
    try {
      const count = await job();
      if (count) toast(`${t.posted} · ${t.sharedWith.replace('{n}', String(count))}`, 'success');
      else toast(t.nobody, 'info');
    } catch (error) {
      toast((error as Error).message || 'Error', 'error');
    } finally {
      setPosting(null);
    }
  };

  return (
    <div className="flex h-full">
      <section className="flex h-full w-full flex-col border-r border-border bg-surface md:w-[380px] lg:w-[420px]">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h1 className="text-2xl font-extrabold tracking-tight">{t.title}</h1>
          <div className="flex gap-1">
            <IconButton label={t.text} onClick={() => setComposer('text')}>
              <Pencil className="size-5" />
            </IconButton>
            <IconButton label={t.photo} onClick={() => fileInput.current?.click()}>
              <ImageIcon className="size-5" />
            </IconButton>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) setMediaFile(file);
            event.target.value = '';
          }}
        />

        <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4">
          {/* My status */}
          <button
            onClick={() => (status.mine.length ? setViewing({ ownerId: user!.id, index: 0 }) : setComposer('text'))}
            className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-surface-2"
          >
            <span className="relative">
              <StatusRing count={status.mine.length} viewed={0} size={56}>
                <Avatar name={user?.displayName ?? ''} src={user?.avatarUrl} size={status.mine.length ? 48 : 54} />
              </StatusRing>
              {!status.mine.length && (
                <span className="bg-brand-gradient absolute -right-0.5 -bottom-0.5 inline-flex size-6 items-center justify-center rounded-full border-2 border-surface text-on-brand">
                  <Plus className="size-3.5" strokeWidth={3} />
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block font-bold">{t.myStatus}</span>
              <span className="block truncate text-sm text-muted">
                {posting !== null ? `${t.posting} ${Math.round(posting * 100)}%` : status.mine.length ? lastSeenText(status.mine.at(-1)!.createdAt, locale).replace(/^(last seen|সর্বশেষ দেখা) ?/, '') : t.addUpdate}
              </span>
            </span>
          </button>

          {!!recent.length && <ListTitle>{t.recent}</ListTitle>}
          {recent.map((group) => (
            <OwnerRow key={group.ownerId} ownerId={group.ownerId} items={group.items} onOpen={() => setViewing({ ownerId: group.ownerId, index: Math.max(0, group.items.findIndex((i) => !i.viewed)) })} />
          ))}
          {!!seen.length && <ListTitle>{t.viewed}</ListTitle>}
          {seen.map((group) => (
            <OwnerRow key={group.ownerId} ownerId={group.ownerId} items={group.items} onOpen={() => setViewing({ ownerId: group.ownerId, index: 0 })} />
          ))}
          {status.loaded && !status.groups.length && (
            <div className="px-8 py-12 text-center">
              <div className="mx-auto mb-5 flex w-fit -space-x-3">
                {STATUS_BACKGROUNDS.slice(0, 4).map((color, index) => (
                  <motion.span key={color} animate={{ y: [0, index % 2 ? -5 : 5, 0] }} transition={{ repeat: Infinity, duration: 3 + index * 0.3 }} className="size-12 rounded-full border-4 border-surface" style={{ background: color }} />
                ))}
              </div>
              <p className="font-bold">{t.none}</p>
            </div>
          )}
        </div>
      </section>

      <section className="ambient hidden flex-1 flex-col items-center justify-center gap-6 px-10 text-center md:flex">
        <div className="flex gap-4">
          <motion.button whileHover={{ y: -4 }} onClick={() => setComposer('text')} className="flex w-40 flex-col items-center gap-3 rounded-3xl border border-border bg-surface p-6 shadow-card">
            <span className="bg-brand-gradient inline-flex size-14 items-center justify-center rounded-2xl text-on-brand">
              <Type className="size-7" />
            </span>
            <span className="font-semibold">{t.text}</span>
          </motion.button>
          <motion.button whileHover={{ y: -4 }} onClick={() => fileInput.current?.click()} className="flex w-40 flex-col items-center gap-3 rounded-3xl border border-border bg-surface p-6 shadow-card">
            <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white">
              <ImageIcon className="size-7" />
            </span>
            <span className="font-semibold">{t.photo}</span>
          </motion.button>
        </div>
      </section>

      <TextComposer
        open={composer === 'text'}
        onClose={() => setComposer(null)}
        onShare={(text, background, font) => {
          setComposer(null);
          void share(() => postTextStatus(text, background, font));
        }}
      />
      <MediaComposer
        file={mediaFile}
        onClose={() => setMediaFile(null)}
        onShare={(file, caption) => {
          setMediaFile(null);
          void share(() => postMediaStatus(file, caption, setPosting));
        }}
      />
      {viewing && (
        <Viewer
          key={viewing.ownerId}
          ownerId={viewing.ownerId}
          items={ownerItems(viewing.ownerId)}
          start={viewing.index}
          mine={viewing.ownerId === user?.id}
          onClose={() => setViewing(null)}
          onNextOwner={() => {
            const order = [...recent, ...seen].map((g) => g.ownerId);
            const next = order[order.indexOf(viewing.ownerId) + 1];
            setViewing(next ? { ownerId: next, index: 0 } : null);
          }}
        />
      )}
    </div>
  );
}

function ListTitle({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pt-4 pb-2 text-xs font-bold tracking-wide text-subtle uppercase">{children}</p>;
}

/** Avatar ring split into one segment per update; seen segments turn grey. */
function StatusRing({ count, viewed, size, children }: { count: number; viewed: number; size: number; children: React.ReactNode }) {
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const gap = count > 1 ? 4 : 0;
  const segment = count ? c / count - gap : 0;
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {count > 0 && (
        <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
          <defs>
            <linearGradient id="status-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fbbf24" />
              <stop offset="1" stopColor="#ea580c" />
            </linearGradient>
          </defs>
          {Array.from({ length: count }, (_, index) => (
            <circle
              key={index}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={2.5}
              strokeLinecap="round"
              stroke={index < viewed ? 'var(--border-strong)' : 'url(#status-ring)'}
              strokeDasharray={`${segment} ${c - segment}`}
              strokeDashoffset={-index * (segment + gap)}
            />
          ))}
        </svg>
      )}
      {children}
    </span>
  );
}

function OwnerRow({ ownerId, items, onOpen }: { ownerId: string; items: StatusItem[]; onOpen: () => void }) {
  const { locale } = useI18n();
  const chat = useChat();
  const profile = chat.profiles[ownerId];
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2">
      <StatusRing count={items.length} viewed={items.filter((i) => i.viewed).length} size={56}>
        <Avatar name={nameOf(chat, ownerId)} src={profile?.avatarUrl} size={48} />
      </StatusRing>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{nameOf(chat, ownerId)}</span>
        <span className="block text-sm text-muted">{timeOf(items.at(-1)!.createdAt, locale)}</span>
      </span>
    </button>
  );
}

// ───────── Composers ─────────

function TextComposer({ open, onClose, onShare }: { open: boolean; onClose: () => void; onShare: (text: string, background: string, font: number) => void }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const [text, setText] = useState('');
  const [background, setBackground] = useState(0);
  const [font, setFont] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) {
      setTimeout(() => area.current?.focus(), 80);
      setText('');
      setBackground(Math.floor(Math.random() * STATUS_BACKGROUNDS.length));
    }
  }, [open]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex flex-col text-white transition-colors duration-300" style={{ background: STATUS_BACKGROUNDS[background] }} role="dialog" aria-modal="true" aria-label={t.text}>
          <div className="flex items-center justify-between p-4">
            <button onClick={onClose} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/15">
              <X className="size-6" />
            </button>
            <div className="flex gap-2">
              <button onClick={() => setFont((font + 1) % STATUS_FONTS.length)} aria-label="Font" className={clsx('inline-flex size-11 items-center justify-center rounded-full text-lg font-bold hover:bg-white/15', STATUS_FONTS[font])}>
                T
              </button>
              <button onClick={() => setBackground((background + 1) % STATUS_BACKGROUNDS.length)} aria-label="Colour" className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/15">
                <span className="size-6 rounded-full border-2 border-white" style={{ background: STATUS_BACKGROUNDS[(background + 1) % STATUS_BACKGROUNDS.length] }} />
              </button>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center px-6">
            <textarea
              ref={area}
              value={text}
              maxLength={700}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.typeStatus}
              rows={4}
              className={clsx('w-full max-w-2xl resize-none bg-transparent text-center text-3xl leading-snug font-bold text-white outline-none placeholder:text-white/60 sm:text-4xl', STATUS_FONTS[font])}
            />
          </div>
          <div className="flex justify-end p-5">
            <motion.button whileTap={{ scale: 0.9 }} disabled={!text.trim()} onClick={() => onShare(text.trim(), STATUS_BACKGROUNDS[background]!, font)} aria-label="Share" className="inline-flex size-14 items-center justify-center rounded-full bg-white text-[#3730a3] shadow-float disabled:opacity-50">
              <SendHorizontal className="size-6" />
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function MediaComposer({ file, onClose, onShare }: { file: File | null; onClose: () => void; onShare: (file: File, caption: string) => void }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const [caption, setCaption] = useState('');
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  useEffect(() => setCaption(''), [file]);
  return (
    <Dialog open={!!file} onClose={onClose} title={t.photo} wide>
      {file && url && (
        <div className="space-y-4 px-5 pb-5">
          <div className="flex h-80 items-center justify-center overflow-hidden rounded-2xl bg-black">
            {file.type.startsWith('video/') ? <video src={url} controls className="max-h-full" /> : <img src={url} alt="" className="max-h-full object-contain" />}
          </div>
          <div className="flex gap-3">
            <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={700} placeholder={t.caption} autoFocus onKeyDown={(e) => e.key === 'Enter' && onShare(file, caption.trim())} className="h-12 flex-1 rounded-2xl border border-border-strong bg-surface px-4 outline-none focus:border-brand focus:ring-4 focus:ring-[var(--ring)]" />
            <button onClick={() => onShare(file, caption.trim())} aria-label="Share" className="bg-brand-gradient inline-flex size-12 items-center justify-center rounded-full text-on-brand">
              <SendHorizontal className="size-5" />
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ───────── Viewer ─────────

const DURATION = 5_000;

function Viewer({ ownerId, items, start, mine, onClose, onNextOwner }: { ownerId: string; items: StatusItem[]; start: number; mine: boolean; onClose: () => void; onNextOwner: () => void }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const toast = useToast();
  const chat = useChat();
  const [index, setIndex] = useState(Math.min(start, Math.max(0, items.length - 1)));
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [media, setMedia] = useState<string | null>(null);
  const [length, setLength] = useState(DURATION);
  const [reply, setReply] = useState('');
  const [viewers, setViewers] = useState<Awaited<ReturnType<typeof statusViewers>> | null>(null);
  const item = items[index];

  const next = useCallback(() => {
    if (index < items.length - 1) setIndex(index + 1);
    else onNextOwner();
  }, [index, items.length, onNextOwner]);

  useEffect(() => {
    setElapsed(0);
    setMedia(null);
    setLength(DURATION);
    if (!item) return;
    markViewed(item);
    const attachment = item.body?.attachment;
    if (attachment) {
      setPaused(true);
      openAttachment(attachment)
        .then((url) => {
          setMedia(url);
          if (item.kind === 'video' && attachment.durationMs) setLength(Math.min(30_000, attachment.durationMs));
          setPaused(false);
        })
        .catch(() => setPaused(false));
    }
  }, [item]);

  useEffect(() => {
    if (paused || !item) return;
    const started = Date.now() - elapsed;
    const timer = setInterval(() => {
      const value = Date.now() - started;
      if (value >= length) next();
      else setElapsed(value);
    }, 50);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, item, length, next]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') next();
      if (event.key === 'ArrowLeft') setIndex(Math.max(0, index - 1));
      if (event.key === ' ') setPaused((p) => !p);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, next, onClose]);

  if (!item) return null;
  const body = item.body;
  const sendReply = async () => {
    const text = reply.trim();
    if (!text) return;
    setReply('');
    try {
      const conversationId = await engine.startDirect(ownerId);
      const quoted = body?.text ? `“${body.text.slice(0, 60)}”` : item.kind === 'video' ? '🎥' : '📷';
      await engine.sendText(conversationId, `↩ ${locale === 'bn' ? 'স্ট্যাটাস' : 'Status'} ${quoted}\n${text}`);
      toast(t.sent, 'success');
    } catch {
      toast('Error', 'error');
    }
  };

  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[90] flex items-center justify-center bg-black" role="dialog" aria-modal="true" aria-label={nameOf(chat, ownerId)}>
      <div className="relative flex h-full w-full max-w-[480px] flex-col">
        {/* Progress */}
        <div className="absolute inset-x-0 top-0 z-20 flex gap-1 p-3">
          {items.map((entry, i) => (
            <div key={entry.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full bg-white" style={{ width: i < index ? '100%' : i === index ? `${(elapsed / length) * 100}%` : '0%' }} />
            </div>
          ))}
        </div>
        <div className="absolute inset-x-0 top-5 z-20 flex items-center gap-3 px-3 py-2 text-white">
          <Avatar name={nameOf(chat, ownerId, locale === 'bn' ? 'আপনি' : 'You')} src={mine ? undefined : chat.profiles[ownerId]?.avatarUrl} size={38} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{mine ? copy[locale].myStatus : nameOf(chat, ownerId)}</p>
            <p className="text-xs text-white/70">{timeOf(item.createdAt, locale)}</p>
          </div>
          <button onClick={() => setPaused(!paused)} aria-label={paused ? 'Play' : 'Pause'} className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15">
            {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          </button>
          {mine && (
            <button
              onClick={async () => {
                await deleteStatus(item.id);
                if (items.length <= 1) onClose();
                else setIndex(Math.max(0, index - 1));
              }}
              aria-label={t.deleteStatus}
              className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15"
            >
              <Trash2 className="size-5" />
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15">
            <X className="size-5" />
          </button>
        </div>

        {/* Content */}
        <div
          className="relative flex flex-1 items-center justify-center overflow-hidden"
          style={{ background: item.kind === 'text' ? body?.background ?? '#d97706' : '#000' }}
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
        >
          <AnimatePresence mode="wait">
            <motion.div key={item.id} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex h-full w-full items-center justify-center">
              {item.kind === 'text' ? (
                <p className={clsx('px-8 text-center text-3xl leading-snug font-bold whitespace-pre-wrap text-white', STATUS_FONTS[body?.font ?? 0])}>{body?.text}</p>
              ) : media ? (
                item.kind === 'video' ? <video src={media} autoPlay playsInline muted={false} className="max-h-full max-w-full" /> : <img src={media} alt="" className="max-h-full max-w-full object-contain" />
              ) : body?.attachment?.thumb ? (
                <img src={body.attachment.thumb} alt="" className="size-full scale-110 object-cover blur-xl" />
              ) : null}
            </motion.div>
          </AnimatePresence>
          {item.kind !== 'text' && body?.text && <p className="absolute inset-x-0 bottom-24 bg-black/40 px-6 py-3 text-center text-white">{body.text}</p>}
          <button className="absolute inset-y-0 left-0 w-1/3" aria-label="Previous" onClick={() => setIndex(Math.max(0, index - 1))} />
          <button className="absolute inset-y-0 right-0 w-1/3" aria-label="Next" onClick={next} />
          <ChevronLeft className="pointer-events-none absolute left-2 hidden size-8 text-white/50 sm:block" aria-hidden />
          <ChevronRight className="pointer-events-none absolute right-2 hidden size-8 text-white/50 sm:block" aria-hidden />
        </div>

        {/* Footer */}
        <div className="absolute inset-x-0 bottom-0 z-20 p-3">
          {mine ? (
            <button
              onClick={async () => {
                setPaused(true);
                setViewers(await statusViewers(item.id));
              }}
              className="mx-auto flex items-center gap-2 rounded-full bg-black/40 px-4 py-2 text-sm font-semibold text-white"
            >
              <Eye className="size-4" aria-hidden />
              {copy[locale].viewers.replace('{n}', String(item.viewCount ?? 0))}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onFocus={() => setPaused(true)}
                onBlur={() => setPaused(false)}
                onKeyDown={(e) => e.key === 'Enter' && void sendReply()}
                placeholder={t.reply}
                className="h-12 flex-1 rounded-full border border-white/30 bg-black/40 px-5 text-white outline-none placeholder:text-white/60 focus:border-white"
              />
              {['❤️', '😂', '😮'].map((emoji) => (
                <button key={emoji} onClick={() => void reactToStatus(item.id, emoji).then(() => toast(emoji, 'success'))} className="text-2xl transition-transform hover:scale-125" aria-label={emoji}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!viewers} onClose={() => (setViewers(null), setPaused(false))} title={copy[locale].viewers.replace('{n}', String(viewers?.length ?? 0))}>
        <ul className="space-y-2 px-5 pb-6">
          {viewers?.map((viewer) => (
            <li key={viewer.userId} className="flex items-center gap-3">
              <Avatar name={nameOf(chat, viewer.userId)} src={chat.profiles[viewer.userId]?.avatarUrl} size={40} />
              <div className="flex-1">
                <p className="font-semibold">{nameOf(chat, viewer.userId)}</p>
                <p className="text-xs text-muted">{timeOf(viewer.viewedAt, locale)}</p>
              </div>
              {viewer.reaction && <span className="text-xl">{viewer.reaction}</span>}
            </li>
          ))}
        </ul>
      </Dialog>
    </motion.div>,
    document.body,
  );
}
