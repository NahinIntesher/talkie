'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';

/**
 * Six separate boxes that behave like one field: typing moves forward, Backspace moves back, arrow keys move,
 * pasting a whole code fills every box, and the browser can autofill it (autocomplete="one-time-code").
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  label: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (invalid) refs.current[Math.min(value.length, length - 1)]?.focus();
  }, [invalid, value.length, length]);

  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete(clean);
    refs.current[Math.min(clean.length, length - 1)]?.focus();
  };

  return (
    <div role="group" aria-label={label} className="flex justify-between gap-2 sm:gap-3">
      {Array.from({ length }, (_, index) => {
        const char = value[index] ?? '';
        return (
          <input
            key={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            value={char}
            disabled={disabled}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            aria-label={`${label} ${index + 1}`}
            maxLength={length}
            onFocus={(event) => event.target.select()}
            onChange={(event) => {
              const typed = event.target.value.replace(/\D/g, '');
              if (!typed) return;
              if (typed.length > 1) return set(value.slice(0, index) + typed);
              set((value.slice(0, index) + typed + value.slice(index + 1)).slice(0, length));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace') {
                event.preventDefault();
                if (char) onChange(value.slice(0, index) + value.slice(index + 1));
                else if (index > 0) {
                  onChange(value.slice(0, index - 1) + value.slice(index));
                  refs.current[index - 1]?.focus();
                }
              } else if (event.key === 'ArrowLeft' && index > 0) refs.current[index - 1]?.focus();
              else if (event.key === 'ArrowRight' && index < length - 1) refs.current[index + 1]?.focus();
            }}
            onPaste={(event) => {
              event.preventDefault();
              set(event.clipboardData.getData('text'));
            }}
            className={clsx(
              'aspect-[4/5] w-full max-w-14 rounded-2xl border bg-surface text-center text-2xl font-bold tabular-nums transition-all duration-150 outline-none',
              'focus:border-transparent focus:ring-1',
              invalid
                ? 'animate-[shake_.35s] border-danger text-danger focus:ring-[var(--danger)]'
                : char
                  ? 'border-brand text-text focus:ring-[var(--ring-field)]'
                  : 'border-border-strong text-text focus:ring-[var(--ring-field)]',
            )}
          />
        );
      })}
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}`}</style>
    </div>
  );
}
