'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog } from './overlay';
import { useI18n } from '@/lib/i18n';

/** The chat search field's id: Ctrl/⌘ + K puts the cursor there from anywhere in the app. */
export const CHAT_SEARCH_ID = 'chat-search';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Keyboard shortcuts for frequent users (Shneiderman: enable shortcuts for frequent users), and a "?" sheet that lists
 * them so nobody has to remember them (reduce short-term memory load).
 */
export function Shortcuts() {
  const { locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const focusSearch = () => document.getElementById(CHAT_SEARCH_ID)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (pathname === '/app') focusSearch();
        else {
          router.push('/app');
          setTimeout(focusSearch, 350);
        }
        return;
      }
      const question = event.key === '?' || (event.key === '/' && event.shiftKey); // layouts report Shift + / either way
      if (question && !isTyping(event.target) && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pathname, router]);

  const bn = locale === 'bn';
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows: Array<[string[], string]> = [
    [[mod, 'K'], bn ? 'চ্যাট খুঁজুন' : 'Search chats'],
    [['Enter'], bn ? 'মেসেজ পাঠান' : 'Send a message'],
    [['Shift', 'Enter'], bn ? 'নতুন লাইন' : 'New line'],
    [['Esc'], bn ? 'প্যানেল বা চ্যাট বন্ধ করুন' : 'Close a panel or the chat'],
    [[mod, 'D'], bn ? 'মিটিংয়ে মাইক চালু/বন্ধ' : 'Mute or unmute in a meeting'],
    [[mod, 'E'], bn ? 'মিটিংয়ে ক্যামেরা চালু/বন্ধ' : 'Camera on or off in a meeting'],
    [['?'], bn ? 'এই তালিকা' : 'This list'],
  ];

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={bn ? 'কিবোর্ড শর্টকাট' : 'Keyboard shortcuts'}>
      <ul className="px-5 pb-5">
        {rows.map(([keys, label]) => (
          <li key={label} className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
            <span className="text-[0.95rem]">{label}</span>
            <span className="flex shrink-0 gap-1">
              {keys.map((key) => (
                <kbd key={key} className="min-w-7 rounded-lg border border-border-strong bg-surface-2 px-2 py-0.5 text-center font-sans text-xs font-bold text-muted shadow-soft">
                  {key}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
