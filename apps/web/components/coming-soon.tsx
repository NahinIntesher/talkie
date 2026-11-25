'use client';

import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/** A designed placeholder for sections that ship in a later phase. */
export function ComingSoon({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  const { t } = useI18n();
  return (
    <div className="ambient flex h-full items-center justify-center px-6 text-center">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm">
        <div className="relative mx-auto w-fit">
          <div className="absolute -inset-6 rounded-full bg-brand-gradient opacity-25 blur-2xl" />
          <span className="bg-brand-gradient relative inline-flex size-24 items-center justify-center rounded-[2rem] text-white shadow-float">
            <Icon className="size-11" aria-hidden />
          </span>
        </div>
        <h1 className="mt-8 text-2xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-3 leading-relaxed text-muted">{body}</p>
        <p className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3.5 py-1.5 text-sm font-semibold text-brand">
          <Sparkles className="size-4" aria-hidden />
          {t.app.comingSoon}
        </p>
      </motion.div>
    </div>
  );
}
