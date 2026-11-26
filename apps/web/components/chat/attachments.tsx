'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { Check, Download, FileArchive, FileAudio, FileSpreadsheet, FileText, FileVideo, File as FileIcon, Loader2, Pause, Play, RotateCw, X } from 'lucide-react';
import type { AttachmentRef, PollBody } from '@talkie/contracts';
import { Avatar } from '@/components/ui/primitives';
import { useI18n } from '@/lib/i18n';
import { cachedAttachment, formatBytes, formatDuration, openAttachment } from '@/lib/chat/media';
import { nameOf, useChat } from '@/lib/chat/store';
import { chatStrings, fill } from '@/lib/chat/strings';
import * as engine from '@/lib/chat/engine';
import { Dialog } from '@/components/ui/overlay';

/** Loads (downloads + decrypts) an attachment; `auto` starts at once, otherwise on demand. */
function useAttachment(ref: AttachmentRef, auto: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const local = ref.mediaId.startsWith('local-');
  const load = useCallback(() => {
    setFailed(false);
    setProgress(0);
    const job = cachedAttachment(ref.mediaId) ?? (local ? undefined : openAttachment(ref, setProgress));
    if (!job) return;
    job
      .then((value) => {
        setUrl(value);
        setProgress(null);
      })
      .catch(() => {
        setFailed(true);
        setProgress(null);
      });
  }, [ref, local]);
  useEffect(() => {
    if (cachedAttachment(ref.mediaId) || auto) load();
  }, [ref.mediaId, auto, load]);
  return { url, progress, failed, load };
}

function ProgressRing({ value, size = 48, label }: { value: number | null; size?: number; label: string }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  return (
    <span role="img" aria-label={label} className="relative inline-flex items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.25)" strokeWidth="3" fill="none" />
        {value !== null && <circle cx={size / 2} cy={size / 2} r={r} stroke="white" strokeWidth="3" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.03, value))} strokeLinecap="round" className="transition-[stroke-dashoffset] duration-300" />}
      </svg>
      {value === null ? <Download className="size-5" /> : <span className="text-[0.62rem] font-bold tabular-nums">{Math.round(value * 100)}%</span>}
    </span>
  );
}

// ───────── Photo ─────────

export function ImageAttachment({ attachment, uploading }: { attachment: AttachmentRef; uploading: number | null }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const auto = attachment.size < 15 * 1024 * 1024;
  const { url, progress, failed, load } = useAttachment(attachment, auto);
  const [open, setOpen] = useState(false);
  const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : 4 / 3;
  const width = Math.min(320, ratio >= 1 ? 320 : 320 * ratio);
  return (
    <>
      <button
        onClick={() => (url ? setOpen(true) : load())}
        className="relative -mx-2 -mt-0.5 mb-1 block overflow-hidden rounded-xl bg-surface-3"
        style={{ width: `min(${width}px, 62vw)`, aspectRatio: String(Math.max(0.5, Math.min(2.2, ratio))) }}
        aria-label={s.photo}
      >
        {attachment.thumb && <img src={attachment.thumb} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-md" />}
        {url && <motion.img initial={{ opacity: 0 }} animate={{ opacity: 1 }} src={url} alt="" className="absolute inset-0 size-full object-cover" />}
        {(!url || uploading !== null) && (
          <span className="absolute inset-0 flex items-center justify-center">
            {failed ? <RotateCw className="size-8 text-white drop-shadow" aria-label={s.downloadFailed} /> : <ProgressRing value={uploading ?? progress} label={uploading !== null ? s.uploading : s.download} />}
          </span>
        )}
        {!url && !failed && progress === null && uploading === null && <span className="absolute right-2 bottom-2 rounded-full bg-black/50 px-2 py-0.5 text-[0.7rem] font-semibold text-white">{formatBytes(attachment.size, locale)}</span>}
      </button>
      {url && <Lightbox open={open} onClose={() => setOpen(false)} url={url} name={attachment.name} kind="image" />}
    </>
  );
}

// ───────── Video ─────────

export function VideoAttachment({ attachment, uploading }: { attachment: AttachmentRef; uploading: number | null }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const { url, progress, failed, load } = useAttachment(attachment, false);
  const [open, setOpen] = useState(false);
  const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9;
  const width = Math.min(320, ratio >= 1 ? 320 : 320 * ratio);
  useEffect(() => {
    if (url && progress === null && !open && !uploading) setOpen((wasRequested) => wasRequested);
  }, [url, progress, open, uploading]);
  return (
    <>
      <button
        onClick={() => (url ? setOpen(true) : (load(), setOpen(true)))}
        className="relative -mx-2 -mt-0.5 mb-1 block overflow-hidden rounded-xl bg-black"
        style={{ width: `min(${width}px, 62vw)`, aspectRatio: String(Math.max(0.5, Math.min(2.2, ratio))) }}
        aria-label={s.video}
      >
        {attachment.thumb && <img src={attachment.thumb} alt="" className="absolute inset-0 size-full object-cover blur-[2px]" />}
        <span className="absolute inset-0 flex items-center justify-center">
          {uploading !== null || progress !== null ? (
            <ProgressRing value={uploading ?? progress} label={uploading !== null ? s.uploading : s.download} />
          ) : failed ? (
            <RotateCw className="size-8 text-white" />
          ) : (
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm">
              <Play className="ml-0.5 size-6 fill-white" />
            </span>
          )}
        </span>
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[0.7rem] font-semibold text-white">
          <FileVideo className="size-3" aria-hidden />
          {attachment.durationMs ? formatDuration(attachment.durationMs) : formatBytes(attachment.size, locale)}
        </span>
      </button>
      {url && <Lightbox open={open} onClose={() => setOpen(false)} url={url} name={attachment.name} kind="video" />}
    </>
  );
}

// ───────── Document ─────────

const docIcon = (name: string, mime: string) => {
  if (/zip|rar|7z|tar|gz/.test(name)) return FileArchive;
  if (/xlsx?|csv|ods/.test(name)) return FileSpreadsheet;
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime.startsWith('video/')) return FileVideo;
  if (/pdf|docx?|txt|odt|pptx?/.test(name)) return FileText;
  return FileIcon;
};

export function DocumentAttachment({ attachment, uploading, mine }: { attachment: AttachmentRef; uploading: number | null; mine: boolean }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const { url, progress, failed, load } = useAttachment(attachment, false);
  const Icon = docIcon(attachment.name.toLowerCase(), attachment.mime);
  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()!.toUpperCase().slice(0, 5) : '';
  const save = () => {
    if (!url) return load();
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.name;
    link.click();
  };
  return (
    <button onClick={save} className={clsx('-mx-1 mb-1 flex w-72 max-w-full items-center gap-3 rounded-xl p-2.5 text-left', mine ? 'bg-black/12' : 'bg-surface-2')}>
      <span className={clsx('relative inline-flex size-11 shrink-0 items-center justify-center rounded-xl', mine ? 'bg-white/20' : 'bg-brand-soft text-brand')}>
        <Icon className="size-6" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{attachment.name}</span>
        <span className="block text-xs opacity-75">
          {uploading !== null ? `${s.uploading} ${Math.round(uploading * 100)}%` : progress !== null ? `${Math.round(progress * 100)}%` : failed ? s.downloadFailed : [formatBytes(attachment.size, locale), extension].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="shrink-0 opacity-80" aria-label={s.download}>
        {uploading !== null || progress !== null ? <Loader2 className="size-5 animate-spin" /> : url ? <Check className="size-5" /> : <Download className="size-5" />}
      </span>
    </button>
  );
}

// ───────── Voice note ─────────

const SPEEDS = [1, 1.5, 2];

export function VoiceAttachment({ attachment, uploading, mine, senderId }: { attachment: AttachmentRef; uploading: number | null; mine: boolean; senderId: string }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const state = useChat();
  const { url, progress, failed, load } = useAttachment(attachment, attachment.size < 5 * 1024 * 1024);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(0);
  const duration = attachment.durationMs ?? 0;
  const bars = attachment.waveform?.length ? attachment.waveform : Array.from({ length: 48 }, (_, i) => 20 + ((i * 37) % 50));

  useEffect(() => {
    if (!url) return;
    const element = new Audio(url);
    element.preload = 'auto';
    element.ontimeupdate = () => setPosition(element.currentTime * 1000);
    element.onended = () => {
      setPlaying(false);
      setPosition(0);
    };
    audio.current = element;
    return () => {
      element.pause();
      audio.current = null;
    };
  }, [url]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = SPEEDS[speed]!;
  }, [speed]);

  const toggle = () => {
    if (!audio.current) return load();
    if (playing) audio.current.pause();
    else {
      // Only one voice note plays at a time.
      document.dispatchEvent(new CustomEvent('talkie:voice-play', { detail: audio.current }));
      void audio.current.play();
    }
    setPlaying(!playing);
  };

  useEffect(() => {
    const stop = (event: Event) => {
      if ((event as CustomEvent).detail !== audio.current && audio.current && !audio.current.paused) {
        audio.current.pause();
        setPlaying(false);
      }
    };
    document.addEventListener('talkie:voice-play', stop);
    return () => document.removeEventListener('talkie:voice-play', stop);
  }, []);

  const seek = (fraction: number) => {
    if (!audio.current || !duration) return;
    audio.current.currentTime = (fraction * duration) / 1000;
    setPosition(fraction * duration);
  };

  const done = duration ? Math.min(1, position / duration) : 0;
  return (
    <div className="-mx-1 flex w-72 max-w-full items-center gap-2.5 py-1">
      <span className="relative shrink-0">
        <Avatar name={nameOf(state, senderId)} src={state.profiles[senderId]?.avatarUrl} size={44} />
        <span className={clsx('absolute -right-1 -bottom-1 inline-flex size-5 items-center justify-center rounded-full text-[0.6rem]', mine ? 'bg-[var(--bubble-out-text)] text-[var(--bubble-out)]' : 'bg-brand text-[var(--surface)]')}>🎤</span>
      </span>
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className={clsx('inline-flex size-10 shrink-0 items-center justify-center rounded-full', mine ? 'bg-white/20' : 'bg-brand-soft text-brand')}>
        {uploading !== null || progress !== null ? <Loader2 className="size-5 animate-spin" /> : failed ? <RotateCw className="size-5" /> : playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className="flex h-8 cursor-pointer items-center gap-[2px]"
          role="slider"
          aria-label={s.voice}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(done * 100)}
          tabIndex={0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            seek((event.clientX - rect.left) / rect.width);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') seek(Math.min(1, done + 0.05));
            if (event.key === 'ArrowLeft') seek(Math.max(0, done - 0.05));
          }}
        >
          {bars.map((bar, index) => (
            <span
              key={index}
              className={clsx('w-[3px] flex-1 rounded-full transition-colors', index / bars.length < done ? (mine ? 'bg-white' : 'bg-brand') : mine ? 'bg-white/40' : 'bg-subtle/40')}
              style={{ height: `${Math.max(12, bar)}%` }}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-[0.7rem] opacity-80">
          <span className="tabular-nums">{formatDuration(playing || position ? position : duration)}</span>
          {url && (
            <button onClick={() => setSpeed((speed + 1) % SPEEDS.length)} aria-label={s.speed} className={clsx('rounded-full px-1.5 font-bold', mine ? 'bg-white/20' : 'bg-surface-3')}>
              {SPEEDS[speed]}×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── Poll ─────────

export function PollView({ poll, conversationId, messageId, votes, mine }: { poll: PollBody; conversationId: string; messageId: string; votes: Array<{ option: number; userIds: string[] }>; mine: boolean }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const state = useChat();
  const me = state.me?.userId ?? '';
  const [showVotes, setShowVotes] = useState(false);
  const total = new Set(votes.flatMap((v) => v.userIds)).size;
  const chosen = votes.filter((v) => v.userIds.includes(me)).map((v) => v.option);
  const max = Math.max(1, ...votes.map((v) => v.userIds.length));
  const choose = (index: number) => {
    const next = poll.multiple ? (chosen.includes(index) ? chosen.filter((o) => o !== index) : [...chosen, index]) : chosen.includes(index) ? [] : [index];
    void engine.vote(conversationId, messageId, next);
  };
  return (
    <div className="w-72 max-w-full py-1">
      <p className="text-[1rem] font-bold">{poll.question}</p>
      <p className="mb-2 text-xs opacity-70">{poll.multiple ? s.selectMany : s.selectOne}</p>
      <div className="space-y-2" role="group" aria-label={poll.question}>
        {poll.options.map((option, index) => {
          const count = votes.find((v) => v.option === index)?.userIds.length ?? 0;
          const selected = chosen.includes(index);
          return (
            <button key={index} onClick={() => choose(index)} className="block w-full text-left" aria-pressed={selected}>
              <span className="flex items-center gap-2.5">
                <span className={clsx('inline-flex size-5 shrink-0 items-center justify-center border-2', poll.multiple ? 'rounded-md' : 'rounded-full', selected ? (mine ? 'border-[var(--bubble-out-text)] bg-[var(--bubble-out-text)] text-[var(--bubble-out)]' : 'border-brand bg-brand text-[var(--surface)]') : 'border-current opacity-60')}>
                  {selected && <Check className="size-3" strokeWidth={3.5} />}
                </span>
                <span className="flex-1 text-sm font-medium">{option}</span>
                <span className="text-sm font-semibold tabular-nums opacity-80">{count}</span>
              </span>
              <span className={clsx('mt-1.5 ml-7.5 block h-1.5 overflow-hidden rounded-full', mine ? 'bg-white/25' : 'bg-surface-3')}>
                <motion.span className={clsx('block h-full rounded-full', mine ? 'bg-white' : 'bg-brand')} initial={false} animate={{ width: `${(count / max) * 100}%` }} />
              </span>
            </button>
          );
        })}
      </div>
      <button onClick={() => setShowVotes(true)} className={clsx('mt-3 w-full border-t pt-2 text-center text-sm font-semibold', mine ? 'border-white/25' : 'border-border text-brand')}>
        {total ? s.viewVotes : fill(s.votes, { n: 0 })}
      </button>
      <Dialog open={showVotes} onClose={() => setShowVotes(false)} title={poll.question}>
        <div className="space-y-4 px-5 pb-6">
          {poll.options.map((option, index) => {
            const voters = votes.find((v) => v.option === index)?.userIds ?? [];
            return (
              <div key={index}>
                <p className="mb-2 flex justify-between text-sm font-bold">
                  <span>{option}</span>
                  <span className="text-muted">{fill(s.votes, { n: voters.length })}</span>
                </p>
                <ul className="space-y-1.5">
                  {voters.map((id) => (
                    <li key={id} className="flex items-center gap-2.5 text-sm">
                      <Avatar name={nameOf(state, id, s.you)} src={state.profiles[id]?.avatarUrl} size={28} />
                      {nameOf(state, id, s.you)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Dialog>
    </div>
  );
}

// ───────── Lightbox ─────────

function Lightbox({ open, onClose, url, name, kind }: { open: boolean; onClose: () => void; url: string; name: string; kind: 'image' | 'video' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex flex-col bg-black/92 backdrop-blur" role="dialog" aria-modal="true" aria-label={name}>
          <div className="flex items-center justify-between p-3 text-white">
            <span className="truncate px-2 text-sm font-medium">{name}</span>
            <div className="flex gap-1">
              <a href={url} download={name} className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" aria-label="Download">
                <Download className="size-5" />
              </a>
              <button onClick={onClose} className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" aria-label="Close">
                <X className="size-5" />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={onClose}>
            {kind === 'image' ? (
              <motion.img initial={{ scale: 0.94 }} animate={{ scale: 1 }} src={url} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
            ) : (
              <video src={url} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
