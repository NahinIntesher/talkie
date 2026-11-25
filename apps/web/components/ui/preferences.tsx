'use client';

import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { IconButton } from './primitives';

/** Compact header controls: language switch and theme cycle. */
export function PreferenceControls() {
  const { locale, setLocale, t } = useI18n();
  const { choice, setChoice } = useTheme();
  const next = choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light';
  const ThemeIcon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor;
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
        className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
        aria-label={t.settings.language}
      >
        <Languages className="size-4" aria-hidden />
        {locale === 'bn' ? 'English' : 'বাংলা'}
      </button>
      <IconButton label={`${t.settings.theme}: ${t.settings[choice]}`} onClick={() => setChoice(next)}>
        <ThemeIcon className="size-[1.15rem]" />
      </IconButton>
    </div>
  );
}
