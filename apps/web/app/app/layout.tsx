'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { CircleDashed, LogOut, MessageCircle, Phone, Settings, ShieldCheck, Video } from 'lucide-react';
import { Avatar, LogoMark } from '@/components/ui/primitives';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { startChat, stopChat } from '@/lib/chat/engine';
import { useChat } from '@/lib/chat/store';
import { CallOverlay } from '@/components/call/call-overlay';
import { bindCalls, unbindCalls } from '@/lib/call/engine';
import { registerWebPush } from '@/lib/push';
import { adminStrings } from '@/lib/admin/strings';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, user, signOut } = useSession();
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  // On phones an open chat uses the whole screen, like native messengers.
  const params = useSearchParams();
  const inChat = pathname === '/app' && !!params.get('c');

  useEffect(() => {
    if (status === 'signed_out') router.replace('/signin');
  }, [status, router]);

  // The chat engine (encryption keys, live connection) runs for as long as the person is signed in.
  useEffect(() => {
    if (status !== 'signed_in' || !user) return;
    void startChat(user.id)
      .then(() => bindCalls())
      .then(() => registerWebPush())
      .catch(() => {});
    return () => {
      unbindCalls();
      stopChat();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, user?.id]);

  const unread = useChat((state) => Object.values(state.conversations).filter((c) => !c.archived && (c.unreadCount > 0 || c.markedUnread) && !c.mutedUntil).length);

  useEffect(() => {
    document.title = unread ? `(${unread}) Talkie` : 'Talkie';
  }, [unread]);

  if (status !== 'signed_in' || !user) {
    return (
      <div className="ambient flex min-h-dvh items-center justify-center" role="status" aria-label={t.app.loading}>
        <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 1.4 }}>
          <LogoMark size={64} />
        </motion.div>
      </div>
    );
  }

  const nav = [
    { href: '/app', label: t.app.chats, icon: MessageCircle, exact: true, badge: unread },
    { href: '/app/status', label: t.app.status, icon: CircleDashed },
    { href: '/app/calls', label: t.app.calls, icon: Phone },
    { href: '/app/meet', label: t.app.meet, icon: Video },
    ...(user.role !== 'user' ? [{ href: '/app/admin', label: adminStrings(locale).admin, icon: ShieldCheck }] : []),
  ];
  const active = (href: string, exact?: boolean) => (exact ? pathname === href : pathname.startsWith(href));

  return (
    <div className="flex h-dvh flex-col-reverse bg-bg md:flex-row">
      {/* Navigation rail (desktop) / tab bar (mobile) */}
      <nav aria-label="App" className={clsx('z-30 shrink-0', inChat ? 'hidden md:flex' : 'flex', ' items-center justify-around border-t border-border bg-surface px-2 pt-1.5 pb-[max(0.4rem,env(safe-area-inset-bottom))] md:w-[76px] md:flex-col md:justify-start md:gap-2 md:border-t-0 md:border-r md:px-0 md:py-4')}>
        <Link href="/" className="mb-4 hidden md:block" aria-label="Talkie home">
          <LogoMark size={40} />
        </Link>
        {nav.map((item) => (
          <RailLink key={item.href} href={item.href} label={item.label} icon={item.icon} active={active(item.href, item.exact)} badge={'badge' in item ? item.badge : 0} />
        ))}
        <div className="hidden md:block md:flex-1" />
        <RailLink href="/app/settings" label={t.app.settings} icon={Settings} active={active('/app/settings')} />
        <button onClick={() => void signOut()} className="hidden size-12 items-center justify-center rounded-2xl text-muted transition-colors hover:bg-danger-soft hover:text-danger md:inline-flex" aria-label={t.app.signOut} title={t.app.signOut}>
          <LogOut className="size-5" />
        </button>
        <Link href="/app/settings" className="mt-1 hidden md:block" aria-label={user.displayName}>
          <Avatar name={user.displayName} src={user.avatarUrl} size={40} className="ring-2 ring-border transition hover:ring-brand" />
        </Link>
      </nav>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      <CallOverlay />
    </div>
  );
}

function RailLink({ href, label, icon: Icon, active, badge = 0 }: { href: string; label: string; icon: typeof MessageCircle; active: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex flex-col items-center gap-0.5 rounded-2xl px-3 py-1.5 text-[0.7rem] font-semibold transition-colors md:size-12 md:justify-center md:p-0',
        active ? 'text-brand' : 'text-muted hover:text-text',
      )}
      title={label}
    >
      {active && <motion.span layoutId="rail-active" className="absolute inset-0 rounded-2xl bg-brand-soft" />}
      <Icon className="relative size-[1.4rem]" aria-hidden strokeWidth={active ? 2.4 : 2} />
      <span className="relative md:sr-only">{label}</span>
      {badge > 0 && (
        <span className="bg-brand-gradient absolute top-0 right-1 inline-flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[0.65rem] font-bold text-on-brand md:top-1 md:right-1">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}
