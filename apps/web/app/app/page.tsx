'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { BellRing, X } from 'lucide-react';
import { Avatar } from '@/components/ui/primitives';
import { ConversationList } from '@/components/chat/conversation-list';
import { Thread } from '@/components/chat/thread';
import { InfoPanel } from '@/components/chat/info-panel';
import { NewChatDialog } from '@/components/chat/new-chat-dialog';
import { useI18n } from '@/lib/i18n';
import { useChat } from '@/lib/chat/store';
import { openConversation } from '@/lib/chat/engine';
import { registerWebPush } from '@/lib/push';

export default function ChatsPage() {
  return (
    <Suspense>
      <ChatScreen />
    </Suspense>
  );
}

function ChatScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get('c');
  const ready = useChat((state) => state.ready);
  const [infoOpen, setInfoOpen] = useState(false);
  const [newChat, setNewChat] = useState<{ open: boolean; query?: string }>({ open: false });
  const [askNotify, setAskNotify] = useState(false);

  const select = useCallback((id: string | null) => router.push(id ? `/app?c=${id}` : '/app', { scroll: false }), [router]);

  useEffect(() => {
    if (ready) void openConversation(activeId);
    setInfoOpen(false);
  }, [activeId, ready]);

  useEffect(() => () => void openConversation(null), []);

  useEffect(() => {
    try {
      setAskNotify(typeof Notification !== 'undefined' && Notification.permission === 'default' && localStorage.getItem('talkie.notify.dismissed') !== '1');
    } catch {}
  }, []);

  // Keyboard: Escape closes the info panel, then the chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (infoOpen) setInfoOpen(false);
      else if (activeId && !(event.target instanceof HTMLTextAreaElement)) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [infoOpen, activeId, select]);

  return (
    <div className="flex h-full">
      <div className={clsx('flex h-full w-full flex-col border-r border-border md:w-[380px] lg:w-[420px] md:shrink-0', activeId && 'hidden md:flex')}>
        <AnimatePresence>
          {askNotify && (
            <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
              <div className="bg-brand-gradient flex items-center gap-3 px-4 py-3 text-on-brand">
                <BellRing className="size-5 shrink-0" aria-hidden />
                <button
                  className="flex-1 text-left text-sm font-semibold"
                  onClick={async () => {
                    if ((await Notification.requestPermission()) === 'granted') void registerWebPush();
                    setAskNotify(false);
                  }}
                >
                  {locale === 'bn' ? 'নতুন মেসেজের নোটিফিকেশন চালু করুন' : 'Turn on notifications for new messages'}
                </button>
                <button
                  aria-label="Dismiss"
                  onClick={() => {
                    setAskNotify(false);
                    try {
                      localStorage.setItem('talkie.notify.dismissed', '1');
                    } catch {}
                  }}
                  className="rounded-full p-1 hover:bg-white/15"
                >
                  <X className="size-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="min-h-0 flex-1">
          <ConversationList activeId={activeId} onOpen={select} onNewChat={(query) => setNewChat({ open: true, query })} />
        </div>
      </div>

      <div className={clsx('relative h-full min-w-0 flex-1', !activeId && 'hidden md:flex')}>
        {activeId ? (
          <div className="flex h-full">
            <Thread key={activeId} conversationId={activeId} onBack={() => select(null)} onInfo={() => setInfoOpen((v) => !v)} />
            <AnimatePresence>{infoOpen && <InfoPanel conversationId={activeId} onClose={() => setInfoOpen(false)} onLeft={() => setInfoOpen(false)} />}</AnimatePresence>
          </div>
        ) : (
          <section className="ambient flex flex-1 flex-col items-center justify-center px-10 text-center">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-md">
              <div className="relative mx-auto w-fit">
                <div className="absolute -inset-8 rounded-full bg-brand-gradient opacity-20 blur-3xl" />
                <div className="relative grid rotate-[-4deg] grid-cols-3 gap-2">
                  {['Ayesha', 'Rafi', 'Mim', 'Tanvir', 'Nabila', 'Sakib'].map((name, index) => (
                    <motion.div key={name} animate={{ y: [0, index % 2 ? -6 : 6, 0] }} transition={{ repeat: Infinity, duration: 4 + index * 0.4, ease: 'easeInOut' }}>
                      <Avatar name={name} size={56} className="shadow-card ring-4 ring-surface" />
                    </motion.div>
                  ))}
                </div>
              </div>
              <h2 className="mt-10 text-2xl font-extrabold tracking-tight">{t.app.emptyPaneTitle}</h2>
            </motion.div>
          </section>
        )}
      </div>

      <NewChatDialog open={newChat.open} initialQuery={newChat.query} onClose={() => setNewChat({ open: false })} onOpened={(id) => select(id)} />
    </div>
  );
}
