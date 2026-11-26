'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { Flag, LayoutDashboard, ScrollText, ShieldAlert, Users } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { adminStrings } from '@/lib/admin/strings';
import { rank } from '@/lib/admin/types';

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const { user } = useSession();
  const pathname = usePathname();
  const role = user?.role ?? 'user';

  if (rank[role] < rank.moderator) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <span className="inline-flex size-16 items-center justify-center rounded-[1.4rem] bg-danger-soft text-danger">
          <ShieldAlert className="size-8" aria-hidden />
        </span>
        <p className="font-semibold">{s.noAccess}</p>
      </div>
    );
  }

  const sections = [
    { href: '/app/admin', label: s.overview, icon: LayoutDashboard, exact: true },
    { href: '/app/admin/users', label: s.users, icon: Users },
    { href: '/app/admin/reports', label: s.reports, icon: Flag },
    ...(rank[role] >= rank.admin ? [{ href: '/app/admin/audit', label: s.audit, icon: ScrollText }] : []),
  ];
  const isActive = (href: string, exact?: boolean) => (exact ? pathname === href : pathname.startsWith(href));

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:w-[260px] md:shrink-0 md:border-r md:border-b-0">
        <h1 className="px-5 pt-5 pb-3 text-2xl font-extrabold tracking-tight">{s.admin}</h1>
        <nav className="scrollbar-thin flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible [mask-image:linear-gradient(to_right,black_88%,transparent)] md:[mask-image:none]" aria-label={s.admin}>
          {sections.map((item) => {
            const active = isActive(item.href, item.exact);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'relative flex shrink-0 items-center gap-3 rounded-2xl px-4 py-3 text-[0.95rem] font-semibold transition-colors',
                  active ? 'text-brand' : 'text-muted hover:bg-surface-2 hover:text-text',
                )}
              >
                {active && <motion.span layoutId="admin-active" className="absolute inset-0 rounded-2xl bg-brand-soft" />}
                <item.icon className="relative size-5" aria-hidden />
                <span className="relative">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
