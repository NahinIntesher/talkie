'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button, Switch } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';

const reasons = ['spam', 'harassment', 'impersonation', 'inappropriate', 'other'] as const;
type Reason = (typeof reasons)[number];

const strings = {
  en: {
    title: 'Report {name}',
    reasons: { spam: 'Spam', harassment: 'Harassment', impersonation: 'Pretending to be someone', inappropriate: 'Inappropriate content', other: 'Something else' },
    note: 'Details (optional)',
    block: 'Also block',
    send: 'Report',
    cancel: 'Cancel',
    sent: 'Report sent',
  },
  bn: {
    title: '{name}-কে রিপোর্ট করুন',
    reasons: { spam: 'স্প্যাম', harassment: 'হয়রানি', impersonation: 'অন্য কেউ সেজে আছে', inappropriate: 'অনুপযুক্ত কনটেন্ট', other: 'অন্য কিছু' },
    note: 'বিস্তারিত (ঐচ্ছিক)',
    block: 'ব্লকও করুন',
    send: 'রিপোর্ট',
    cancel: 'বাতিল',
    sent: 'রিপোর্ট পাঠানো হয়েছে',
  },
};

/** Report a person to Talkie's moderators (optionally blocking them too). */
export function ReportDialog({ open, onClose, userId, name, onBlocked }: { open: boolean; onClose: () => void; userId: string; name: string; onBlocked?: () => void }) {
  const { locale } = useI18n();
  const s = strings[locale];
  const toast = useToast();
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [block, setBlock] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!reason) return;
    setSending(true);
    try {
      await api(`/users/${userId}/report`, { method: 'POST', body: { reason, note: note.trim(), block } });
      toast(s.sent, 'success');
      if (block) onBlocked?.();
      setReason(null);
      setNote('');
      setBlock(false);
      onClose();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : s.cancel, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={s.title.replace('{name}', name)}>
      <div className="space-y-4 px-5 pt-1 pb-5">
        <div role="radiogroup" className="space-y-1.5">
          {reasons.map((value) => (
            <button
              key={value}
              role="radio"
              aria-checked={reason === value}
              onClick={() => setReason(value)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left font-semibold transition-colors',
                reason === value ? 'border-brand bg-brand-soft text-brand' : 'border-border hover:bg-surface-2',
              )}
            >
              <span className={clsx('size-4 rounded-full border-2', reason === value ? 'border-brand bg-brand shadow-[inset_0_0_0_2px_var(--surface)]' : 'border-border-strong')} />
              {s.reasons[value]}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={3}
          placeholder={s.note}
          aria-label={s.note}
          className="w-full resize-none rounded-2xl border border-border-strong bg-surface px-4 py-3 outline-none placeholder:text-subtle focus:border-brand focus:ring-4 focus:ring-[var(--ring)]"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold">{s.block}</span>
          <Switch checked={block} onChange={setBlock} label={s.block} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            {s.cancel}
          </Button>
          <Button variant="danger" className="flex-1" disabled={!reason} loading={sending} onClick={() => void send()}>
            {s.send}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
