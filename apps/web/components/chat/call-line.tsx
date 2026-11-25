'use client';

import clsx from 'clsx';
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useChat, type ChatMessage } from '@/lib/chat/store';
import { timeOf } from '@/lib/chat/strings';
import { startCall } from '@/lib/call/engine';
import { useToast } from '@/components/ui/toast';
import { callText } from './text';

/** A call in the chat history: icon, outcome, length, and a button to call back. */
export function CallLine({ message }: { message: ChatMessage }) {
  const { locale } = useI18n();
  const toast = useToast();
  const me = useChat((s) => s.me?.userId);
  const event = message.systemEvent!;
  const call = event.call!;
  const mine = event.actorId === me;
  const missed = !call.durationSeconds && ['missed', 'cancelled', 'busy', 'declined'].includes(call.outcome);
  const Icon = call.media === 'video' ? Video : missed && !mine ? PhoneMissed : mine ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className={clsx('my-2 flex px-3 sm:px-6', mine ? 'justify-end' : 'justify-start')} id={`m-${message.id}`}>
      <button
        onClick={() => void startCall(message.conversationId, call.media).then((error) => error && toast(error, 'error'))}
        className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-2.5 text-left shadow-soft transition hover:shadow-card"
        aria-label={locale === 'bn' ? 'আবার কল করুন' : 'Call back'}
      >
        <span className={clsx('inline-flex size-10 items-center justify-center rounded-full', missed && !mine ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand')}>
          <Icon className="size-5" aria-hidden />
        </span>
        <span>
          <span className={clsx('block text-sm font-semibold', missed && !mine && 'text-danger')}>{callText(event, mine, locale)}</span>
          <span className="block text-xs text-subtle">{timeOf(message.createdAt, locale)}</span>
        </span>
      </button>
    </div>
  );
}
