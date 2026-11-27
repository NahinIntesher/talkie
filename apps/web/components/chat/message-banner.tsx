'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Send, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { sendText } from '@/lib/chat/engine';
import { useChat } from '@/lib/chat/store';
import { useToast } from '@/components/ui/toast';

interface Notice { conversationId: string; title: string; body: string; deviceId: string; userId: string }

export function MessageBanner() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const toast = useToast();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const data = event.data;
      const me = useChat.getState().me;
      if (!me || data?.userId !== me.userId || data.deviceId !== me.deviceId || !/^[1-9]\d{0,19}$/.test(data.conversationId)) return;
      if (data.action === 'open') { router.push(`/app?c=${data.conversationId}`); return; }
      if (data.action !== 'reply' && (editing || data.conversationId === useChat.getState().activeId && location.pathname === '/app')) return;
      setNotice(data);
      setEditing(data.action === 'reply');
      setDraft('');
    };
    navigator.serviceWorker.addEventListener('message', receive);
    return () => navigator.serviceWorker.removeEventListener('message', receive);
  }, [router, editing]);
  useEffect(() => {
    if (!notice || editing) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice, editing]);
  if (!notice) return null;
  const reply = locale === 'bn' ? 'উত্তর দিন' : 'Reply';
  return <aside aria-live="polite" className="fixed inset-x-3 top-3 z-[115] mx-auto max-w-sm rounded-2xl border border-border bg-surface p-4 text-text shadow-float sm:right-4 sm:left-auto">
    <div className="flex items-center gap-3">
      <MessageCircle className="size-5 text-brand" />
      <button className="min-w-0 flex-1 text-left" onClick={() => { router.push(`/app?c=${notice.conversationId}`); setNotice(null); }}>
        <strong className="block truncate">{notice.title}</strong><span className="text-sm text-muted">{notice.body}</span>
      </button>
      <button aria-label={locale === 'bn' ? 'বন্ধ করুন' : 'Dismiss'} onClick={() => setNotice(null)}><X className="size-5" /></button>
    </div>
    {editing ? <form className="mt-3 flex gap-2" onSubmit={async e => {
      e.preventDefault();
      if (!draft.trim() || sending) return;
      const owner = useChat.getState().me;
      if (owner?.userId !== notice.userId || owner.deviceId !== notice.deviceId) { setDraft(''); setNotice(null); return; }
      setSending(true);
      try { await sendText(notice.conversationId, draft.trim()); setNotice(null); }
      catch { toast(t.errors.generic, 'error'); }
      finally { setSending(false); }
    }}><input autoFocus maxLength={65000} aria-label={reply} placeholder={reply} value={draft} onChange={e => setDraft(e.target.value)} className="min-w-0 flex-1 rounded-xl bg-surface-2 px-3 py-2" />
      <button disabled={sending || !draft.trim()} aria-label={reply} className="rounded-xl bg-brand px-3 text-on-brand"><Send className="size-4" /></button>
    </form> : <button className="mt-2 text-sm font-bold text-brand" onClick={() => setEditing(true)}>{reply}</button>}
  </aside>;
}
