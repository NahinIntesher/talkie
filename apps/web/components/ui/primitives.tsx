'use client';

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

// ───────── Logo ─────────

/** The Talkie app icon (public/icon.svg, generated from assets/brand/talkie in the repository). */
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icon.svg" width={size} height={size} alt="" aria-hidden="true" draggable={false} className={clsx('shrink-0 select-none', className)} />
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={34} />
      <span className="text-[1.3rem] font-extrabold tracking-tight">Talkie</span>
    </span>
  );
}

// ───────── Button ─────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-gradient text-on-brand shadow-[0_10px_30px_-10px_var(--brand)] hover:brightness-110 hover:shadow-[0_14px_34px_-10px_var(--brand)] active:brightness-95',
  secondary: 'bg-surface-2 text-text hover:bg-surface-3',
  outline: 'border border-border-strong bg-surface text-text hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger text-white hover:brightness-110',
};
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5 rounded-xl',
  md: 'h-11 px-5 text-[0.95rem] gap-2 rounded-2xl',
  lg: 'h-13 px-7 text-base gap-2.5 rounded-2xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, leading, trailing, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'relative inline-flex select-none items-center justify-center font-semibold whitespace-nowrap transition-all duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] disabled:opacity-55 disabled:shadow-none',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-[1.1em] animate-spin" aria-hidden /> : leading}
      <span>{children}</span>
      {!loading && trailing}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-text',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ───────── Text field ─────────

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, hint, error, leading, trailing, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label htmlFor={inputId} className="block text-sm font-semibold text-text">
        {label}
      </label>
      <div
        className={clsx(
          'group flex h-12 items-center gap-2.5 rounded-2xl border bg-surface px-4 transition-all duration-200',
          'focus-within:ring-4',
          error
            ? 'border-danger focus-within:ring-[color-mix(in_srgb,var(--danger)_25%,transparent)]'
            : 'border-border-strong hover:border-[color-mix(in_srgb,var(--brand)_45%,var(--border-strong))] focus-within:border-brand focus-within:ring-[var(--ring)]',
        )}
      >
        {leading && <span className="text-subtle group-focus-within:text-brand">{leading}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="h-full min-w-0 flex-1 bg-transparent text-[0.98rem] text-text outline-none placeholder:text-subtle"
          {...rest}
        />
        {trailing}
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-sm text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

// ───────── Avatar ─────────

const avatarTones = ['from-indigo-500 to-violet-500', 'from-fuchsia-500 to-pink-500', 'from-sky-500 to-indigo-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500', 'from-rose-500 to-red-500'];

export function Avatar({ name, src, size = 40, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  const tone = avatarTones[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarTones.length];
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} className={clsx('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
  ) : (
    <span
      aria-hidden="true"
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white', tone, className)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </span>
  );
}

// ───────── Segmented control & switch ─────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-2xl bg-surface-2 p-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={clsx(
              'inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition-all duration-200',
              active ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]',
        checked ? 'bg-brand' : 'bg-surface-3',
      )}
    >
      <span className={clsx('inline-block size-5 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-out-expo)]', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-3xl border border-border bg-surface shadow-card', className)}>{children}</div>;
}
