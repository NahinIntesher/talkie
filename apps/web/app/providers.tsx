'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { I18nProvider, type Locale } from '@/lib/i18n';
import { SessionProvider } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import { Toaster } from '@/components/ui/toast';

export function Providers({ children, locale }: { children: ReactNode; locale: Locale }) {
  return (
    <ThemeProvider>
      <I18nProvider initial={locale}>
        <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
          <SessionProvider>
            <Toaster>{children}</Toaster>
          </SessionProvider>
        </MotionConfig>
      </I18nProvider>
    </ThemeProvider>
  );
}
