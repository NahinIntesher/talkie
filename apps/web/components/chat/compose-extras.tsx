'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { FileText, Mic, Plus, SendHorizontal, Trash2, X } from 'lucide-react';
import type { PollBody } from '@talkie/contracts';
import { Button, Switch } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { chatStrings, fill } from '@/lib/chat/strings';
import { formatBytes, formatDuration, kindOf, startRecording, type Recording } from '@/lib/chat/media';

const MAX_FILE = 2 * 1024 * 1024 * 1024;

/** Preview of files about to be sent, with a caption and the HD option for photos. */
export function AttachDialog({ files, onClose, onSend }: { files: File[]; onClose: () => void; onSend: (files: File[], caption: string, hd: boolean) => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const [list, setList] = useState<File[]>(files);
  const [selected, setSelected] = useState(0);
  const [caption, setCaption] = useState('');
  const [hd, setHd] = useState(false);
  useEffect(() => {
    setList(files);
    setSelected(0);
    setCaption('');
  }, [files]);
  const previews = useMemo(() => list.map((file) => (kindOf(file) === 'image' || kindOf(file) === 'video' ? URL.createObjectURL(file) : null)), [list]);
  useEffect(() => () => previews.forEach((url) => url && URL.revokeObjectURL(url)), [previews]);
  const current = list[selected];
  const hasPhotos = list.some((file) => kindOf(file) === 'image');
  return (
    <Dialog open={files.length > 0} onClose={onClose} title={s.sendFiles.replace('{n}', String(list.length))} wide>
      {current && (
        <div className="flex min-h-0 flex-col gap-4 px-5 pb-5">
          <div className="chat-wallpaper flex h-72 items-center justify-center overflow-hidden rounded-2xl">
            {kindOf(current) === 'image' && previews[selected] ? (
              <img src={previews[selected]!} alt={current.name} className="max-h-full max-w-full object-contain" />
            ) : kindOf(current) === 'video' && previews[selected] ? (
              <video src={previews[selected]!} controls className="max-h-full max-w-full" />
            ) : (
              <div className="flex flex-col items-center text-center">
                <span className="inline-flex size-20 items-center justify-center rounded-3xl bg-brand-soft text-brand">
                  <FileText className="size-10" aria-hidden />
                </span>
                <p className="mt-3 max-w-xs truncate font-semibold">{current.name}</p>
                <p className="text-sm text-muted">{formatBytes(current.size, locale)}</p>
              </div>
            )}
          </div>
          {list.length > 1 && (
            <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
              {list.map((file, index) => (
                <div key={`${file.name}-${index}`} className="relative shrink-0">
                  <button onClick={() => setSelected(index)} className={clsx('size-14 overflow-hidden rounded-xl border-2', index === selected ? 'border-brand' : 'border-transparent')}>
                    {previews[index] && kindOf(file) === 'image' ? <img src={previews[index]!} alt="" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center bg-surface-2 text-[0.6rem] font-bold">{file.name.split('.').pop()?.toUpperCase()}</span>}
                  </button>
                  <button
                    onClick={() => {
                      const next = list.filter((_, i) => i !== index);
                      setList(next);
                      setSelected(Math.min(selected, next.length - 1));
                      if (!next.length) onClose();
                    }}
                    aria-label="Remove"
                    className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full bg-text text-bg"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onSend(list, caption.trim(), hd))}
              placeholder={s.addCaption}
              maxLength={4000}
              autoFocus
              className="h-12 min-w-0 flex-1 rounded-2xl border border-border-strong bg-surface px-4 outline-none focus:border-brand/60 focus:ring-2 focus:ring-[var(--ring-soft)]"
            />
            {hasPhotos && (
              <label className="flex shrink-0 items-center gap-2 text-sm font-bold">
                {s.hd}
                <Switch checked={hd} onChange={setHd} label={s.hd} />
              </label>
            )}
            <button onClick={() => onSend(list, caption.trim(), hd)} aria-label={s.send} className="bg-brand-gradient inline-flex size-12 shrink-0 items-center justify-center rounded-full text-on-brand shadow-card">
              <SendHorizontal className="size-5" />
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function PollDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (poll: PollBody) => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  useEffect(() => {
    if (open) {
      setQuestion('');
      setOptions(['', '']);
      setMultiple(false);
    }
  }, [open]);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim() && filled.length >= 2 && new Set(filled).size === filled.length;
  return (
    <Dialog open={open} onClose={onClose} title={s.createPoll}>
      <form
        className="space-y-4 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onCreate({ question: question.trim(), options: filled, multiple });
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">{s.question}</span>
          <input value={question} maxLength={255} onChange={(e) => setQuestion(e.target.value)} placeholder={s.questionPlaceholder} autoFocus className="h-12 w-full rounded-2xl border border-border-strong bg-surface px-4 outline-none focus:border-brand/60 focus:ring-2 focus:ring-[var(--ring-soft)]" />
        </label>
        <div className="space-y-2">
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={option}
                maxLength={100}
                onChange={(e) => {
                  const next = [...options];
                  next[index] = e.target.value;
                  if (index === options.length - 1 && e.target.value && options.length < 12) next.push('');
                  setOptions(next);
                }}
                placeholder={fill(s.option, { n: index + 1 })}
                aria-label={fill(s.option, { n: index + 1 })}
                className="h-11 flex-1 rounded-xl border border-border bg-surface-2 px-4 outline-none focus:border-brand/60 focus:bg-surface focus:ring-2 focus:ring-[var(--ring-soft)]"
              />
              {options.length > 2 && (
                <button type="button" onClick={() => setOptions(options.filter((_, i) => i !== index))} aria-label="Remove" className="inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2">
                  <X className="size-4" />
                </button>
              )}
            </div>
          ))}
          {options.length < 12 && options.every((o) => o.trim()) && (
            <button type="button" onClick={() => setOptions([...options, ''])} className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Plus className="size-4" aria-hidden />
              {s.addOption}
            </button>
          )}
        </div>
        <label className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-3">
          <span className="text-sm font-semibold">{s.allowMultiple}</span>
          <Switch checked={multiple} onChange={setMultiple} label={s.allowMultiple} />
        </label>
        <Button type="submit" block disabled={!valid}>
          {s.send}
        </Button>
      </form>
    </Dialog>
  );
}

/** Voice note recorder bar: live level, timer, cancel and send. */
export function VoiceRecorder({ onSend, onCancel }: { onSend: (result: { blob: Blob; durationMs: number; waveform: number[] }) => void; onCancel: () => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const toast = useToast();
  const recording = useRef<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    startRecording()
      .then((rec) => {
        if (cancelled) return rec.cancel();
        recording.current = rec;
        timer = setInterval(() => {
          setElapsed(Date.now() - rec.startedAt);
          setLevels((list) => [...list.slice(-39), rec.level()]);
          if (Date.now() - rec.startedAt > 15 * 60_000) void finish();
        }, 100);
      })
      .catch(() => {
        toast(s.micDenied, 'error');
        onCancel();
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      recording.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async () => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    const result = await rec.stop();
    if (result.durationMs < 700) return onCancel();
    onSend(result);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-1 items-center gap-3" role="status" aria-label={s.recording}>
      <button
        onClick={() => {
          recording.current?.cancel();
          recording.current = null;
          onCancel();
        }}
        aria-label={s.cancel}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-danger hover:bg-danger-soft"
      >
        <Trash2 className="size-5" />
      </button>
      <div className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-[1.5rem] bg-surface-2 px-4">
        <motion.span className="size-2.5 shrink-0 rounded-full bg-danger" animate={{ opacity: [1, 0.25, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} />
        <span className="w-12 shrink-0 font-semibold tabular-nums">{formatDuration(elapsed)}</span>
        <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-hidden>
          {levels.map((level, index) => (
            <span key={index} className="w-[3px] shrink-0 rounded-full bg-brand" style={{ height: `${Math.max(10, level * 100)}%` }} />
          ))}
        </div>
      </div>
      <motion.button whileTap={{ scale: 0.9 }} onClick={() => void finish()} aria-label={s.send} className="bg-brand-gradient inline-flex size-12 shrink-0 items-center justify-center rounded-full text-on-brand shadow-card">
        <SendHorizontal className="size-5" />
      </motion.button>
    </motion.div>
  );
}

export const MicButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <motion.button whileTap={{ scale: 0.9 }} onClick={onClick} aria-label={label} className="bg-brand-gradient inline-flex size-12 shrink-0 items-center justify-center rounded-full text-on-brand shadow-[0_10px_24px_-10px_var(--brand)]">
    <Mic className="size-5" />
  </motion.button>
);

export const validFiles = (files: File[], s: ReturnType<typeof chatStrings>, toast: (m: string, t?: 'error') => void) => {
  const ok = files.filter((file) => file.size <= MAX_FILE);
  if (ok.length < files.length) toast(s.tooLarge, 'error');
  return ok.slice(0, 30);
};

export { AnimatePresence };
