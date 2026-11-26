'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import clsx from 'clsx';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const Context = createContext<(message: string, tone?: Tone) => void>(() => {});

/** Short confirmations and errors, announced to screen readers, dismissed automatically. */
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, tone, message }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 4200);
  }, []);
  const icons = { success: CheckCircle2, error: AlertCircle, info: Info };
  return (
    <Context.Provider value={push}>
      {children}
      {/* Phones: top of the screen, so a message never covers the composer or the keyboard. Larger screens: bottom. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[100] flex flex-col items-center gap-2 px-4 sm:top-auto sm:bottom-6">
        <AnimatePresence>
          {toasts.map((toast) => {
            const Icon = icons[toast.tone];
            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                className="glass pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-border px-4 py-3 text-sm font-medium shadow-float sm:w-auto"
              >
                <Icon className={clsx('size-5 shrink-0', toast.tone === 'success' && 'text-success', toast.tone === 'error' && 'text-danger', toast.tone === 'info' && 'text-brand')} />
                {toast.message}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </Context.Provider>
  );
}

export const useToast = () => useContext(Context);
