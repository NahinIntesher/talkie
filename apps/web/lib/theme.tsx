'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'talkie.theme';

/** Runs before React hydrates so the first paint already has the right theme (no flash). */
export const themeScript = `(() => { try {
  var c = localStorage.getItem('${STORAGE_KEY}') || 'system';
  var dark = c === 'dark' || (c === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) { document.documentElement.dataset.theme = 'light'; } })();`;

interface Theme {
  choice: ThemeChoice;
  resolved: 'light' | 'dark';
  setChoice: (choice: ThemeChoice) => void;
}

const Context = createContext<Theme | null>(null);

const systemDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    let stored: ThemeChoice = 'system';
    try {
      stored = (localStorage.getItem(STORAGE_KEY) as ThemeChoice) || 'system';
    } catch {}
    setChoiceState(stored);
  }, []);

  useEffect(() => {
    const apply = () => {
      const next = choice === 'system' ? (systemDark() ? 'dark' : 'light') : choice;
      document.documentElement.dataset.theme = next;
      setResolved(next);
    };
    apply();
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  return <Context.Provider value={{ choice, resolved, setChoice }}>{children}</Context.Provider>;
}

export function useTheme(): Theme {
  const value = useContext(Context);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
