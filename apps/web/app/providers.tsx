'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MotionConfig } from 'motion/react';
import { I18nProvider, type Locale } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { startChat, stopChat } from '@/lib/chat/engine';
import { bindCalls, unbindCalls } from '@/lib/call/engine';
import { registerWebPush } from '@/lib/push';
import { resetMeet, useMeet, leave, toggleMic } from '@/lib/meet/engine';
import { CallOverlay } from '@/components/call/call-overlay';
import { RoomAudio } from '@/components/call/room-audio';
import { MessageBanner } from '@/components/chat/message-banner';
import { ThemeProvider } from '@/lib/theme';
import { Toaster } from '@/components/ui/toast';

export function Providers({ children, locale }: { children: ReactNode; locale: Locale }) {
  return (
    <ThemeProvider>
      <I18nProvider initial={locale}>
        <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
          <SessionProvider>
            <Toaster>{children}<LiveSessions /></Toaster>
          </SessionProvider>
        </MotionConfig>
      </I18nProvider>
    </ThemeProvider>
  );
}

function LiveSessions() {
  const { status, user } = useSession();
  const userId = status === 'signed_in' ? user?.id : null;
  const pathname = usePathname();
  const { locale } = useI18n();
  const code = useMeet(state => state.code);
  const phase = useMeet(state => state.phase);
  const room = useMeet(state => state.room);
  const micOn = useMeet(state => state.micOn);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void startChat(userId).then(() => { if (active) { bindCalls(); void registerWebPush(); } }).catch(() => {});
    return () => { active = false; unbindCalls(); resetMeet(); stopChat(); };
  }, [userId]);
  if (!userId) return null;
  return <><CallOverlay /><MessageBanner key={userId} /><RoomAudio room={room} />
    {phase === 'in' && pathname !== `/meet/${code}` && <aside className="fixed inset-x-3 top-3 z-[105] mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-emerald-950 px-4 py-3 text-white shadow-lg">
      <Link href={`/meet/${code}`} className="flex-1 font-bold">{locale === 'bn' ? 'মিটিংয়ে ফিরুন' : 'Return to meeting'} · {code}</Link>
      <button onClick={() => void toggleMic()}>{micOn ? (locale === 'bn' ? 'মিউট' : 'Mute') : (locale === 'bn' ? 'আনমিউট' : 'Unmute')}</button>
      <button onClick={() => void leave()} className="rounded-full bg-red-600 px-3 py-2">{locale === 'bn' ? 'বের হন' : 'Leave'}</button>
    </aside>}</>;
}
