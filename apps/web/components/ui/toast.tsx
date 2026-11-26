'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import clsx from 'clsx';

type Tone = 'success' | 'error' | 'info';
/** An action on the toast itself, e.g. Undo (Shneiderman: permit easy reversal of actions). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface Toast {
  id: number;
  tone: Tone;
  message: string;
  action?: ToastAction;
}

type Push = (message: string, tone?: Tone, action?: ToastAction) => void;
const Context = createContext<Push>(() => {});

/** Short confirmations and errors, announced to screen readers, dismissed automatically. */
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const push = useCallback<Push>(
    (message, tone = 'info', action) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list.slice(-2), { id, tone, message, action }]);
      // A toast with an action stays a little longer, so there is time to use it.
      setTimeout(() => dismiss(id), action ? 5500 : 4200);
    },
    [dismiss],
  );
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
                role={toast.tone === 'error' ? 'alert' : 'status'}
                className="glass pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-border px-4 py-3 text-sm font-medium shadow-float sm:w-auto"
              >
                <Icon className={clsx('size-5 shrink-0', toast.tone === 'success' && 'text-success', toast.tone === 'error' && 'text-danger', toast.tone === 'info' && 'text-brand')} />
                <span className="min-w-0 flex-1">{toast.message}</span>
                {toast.action && (
                  <button
                    onClick={() => {
                      toast.action!.onClick();
                      dismiss(toast.id);
                    }}
                    className="-my-1 shrink-0 rounded-xl px-3 py-1.5 font-bold text-brand transition-colors hover:bg-brand-soft"
                  >
                    {toast.action.label}
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </Context.Provider>
  );
}

export const useToast = () => useContext(Context);
