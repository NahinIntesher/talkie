'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Users, Video } from 'lucide-react';
import type { CallInfo } from '@talkie/contracts';
import { Avatar, IconButton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { loadProfiles } from '@/lib/chat/engine';
import { conversationTitle, nameOf, useChat } from '@/lib/chat/store';
import { dayLabel, timeOf } from '@/lib/chat/strings';
import { startCall, useCall } from '@/lib/call/engine';

const copy = {
  en: { title: 'Calls', recent: 'Recent', empty: 'No calls yet', missed: 'Missed', incoming: 'Incoming', outgoing: 'Outgoing', all: 'All', voice: 'Voice call', video: 'Video call' },
  bn: { title: 'কল', recent: 'সাম্প্রতিক', empty: 'এখনো কোনো কল নেই', missed: 'মিসড', incoming: 'ইনকামিং', outgoing: 'আউটগোয়িং', all: 'সব', voice: 'ভয়েস কল', video: 'ভিডিও কল' },
};

export default function CallsPage() {
  const { locale } = useI18n();
  const t = copy[locale];
  const toast = useToast();
  const chat = useChat();
  const active = useCall((s) => s.session);
  const [calls, setCalls] = useState<CallInfo[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');

  useEffect(() => {
    if (!chat.ready) return;
    api<{ calls: CallInfo[] }>('/meet/calls')
      .then(({ calls: list }) => {
        setCalls(list);
        void loadProfiles(list.flatMap((c) => c.participants.map((p) => p.userId)));
      })
      .catch(() => setCalls([]));
  }, [chat.ready, active?.phase]);

  const me = chat.me?.userId;
  const missed = (call: CallInfo) => call.initiatorId !== me && call.participants.find((p) => p.userId === me)?.state === 'missed';
  const list = (calls ?? []).filter((call) => filter === 'all' || missed(call));

  return (
    <div className="flex h-full">
      <section className="flex h-full w-full flex-col border-r border-border bg-surface md:w-[380px] lg:w-[420px]">
        <div className="px-5 pt-5 pb-3">
          <h1 className="text-2xl font-extrabold tracking-tight">{t.title}</h1>
        </div>
        <div className="flex gap-2 px-4 pb-3" role="tablist">
          {(['all', 'missed'] as const).map((value) => (
            <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)} className={clsx('h-8 rounded-full px-3.5 text-sm font-semibold', filter === value ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted hover:text-text')}>
              {t[value]}
            </button>
          ))}
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4">
          {calls === null && <div className="mx-auto mt-10 size-8 animate-spin rounded-full border-[3px] border-brand/25 border-t-brand" />}
          {list.map((call) => {
            const conversation = call.conversationId ? chat.conversations[call.conversationId] : undefined;
            const other = call.participants.find((p) => p.userId !== me)?.userId ?? call.initiatorId;
            const title = conversation ? conversationTitle(chat, conversation) : nameOf(chat, other);
            const wasMissed = missed(call);
            const Arrow = wasMissed ? PhoneMissed : call.initiatorId === me ? PhoneOutgoing : PhoneIncoming;
            const seconds = call.answeredAt && call.endedAt ? Math.round((new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000) : 0;
            return (
              <motion.div key={call.id} layout className="flex items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-surface-2">
                {conversation?.group ? (
                  <span className="inline-flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-white">
                    <Users className="size-5" aria-hidden />
                  </span>
                ) : (
                  <Avatar name={title} src={chat.profiles[other]?.avatarUrl} size={48} />
                )}
                <Link href={call.conversationId ? `/app?c=${call.conversationId}` : '/app'} className="min-w-0 flex-1">
                  <span className={clsx('block truncate font-semibold', wasMissed && 'text-danger')}>{title}</span>
                  <span className="flex items-center gap-1.5 text-sm text-muted">
                    <Arrow className={clsx('size-4', wasMissed ? 'text-danger' : 'text-success')} aria-hidden />
                    {dayLabel(call.createdAt, locale)}, {timeOf(call.createdAt, locale)}
                    {seconds > 0 && ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
                  </span>
                </Link>
                {call.conversationId && (
                  <IconButton label={call.media === 'video' ? t.video : t.voice} onClick={() => void startCall(call.conversationId!, call.media).then((error) => error && toast(error, 'error'))}>
                    {call.media === 'video' ? <Video className="size-5 text-brand" /> : <Phone className="size-5 text-brand" />}
                  </IconButton>
                )}
              </motion.div>
            );
          })}
          {calls !== null && !list.length && (
            <div className="px-8 py-16 text-center">
              <span className="mx-auto inline-flex size-20 items-center justify-center rounded-[1.6rem] bg-brand-soft text-brand">
                <Phone className="size-9" aria-hidden />
              </span>
              <p className="mt-6 font-bold">{t.empty}</p>
            </div>
          )}
        </div>
      </section>
      <section className="ambient hidden flex-1 flex-col items-center justify-center px-10 text-center md:flex">
        <span className="bg-brand-gradient inline-flex size-24 items-center justify-center rounded-[2rem] text-on-brand shadow-float">
          <Phone className="size-11" aria-hidden />
        </span>
      </section>
    </div>
  );
}
