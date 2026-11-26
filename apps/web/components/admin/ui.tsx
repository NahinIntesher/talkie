'use client';

import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { adminStrings, formatNumber } from '@/lib/admin/strings';
import type { Series } from '@/lib/admin/types';

export function StatTile({ label, value, icon, tone = 'brand', loading }: { label: string; value: ReactNode; icon?: ReactNode; tone?: 'brand' | 'danger' | 'success' | 'muted'; loading?: boolean }) {
  return (
    <div className="rounded-3xl border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-muted">{label}</span>
        {icon && (
          <span
            className={clsx(
              'inline-flex size-9 items-center justify-center rounded-xl',
              tone === 'brand' && 'bg-brand-soft text-brand',
              tone === 'danger' && 'bg-danger-soft text-danger',
              tone === 'success' && 'bg-success-soft text-success',
              tone === 'muted' && 'bg-surface-2 text-muted',
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
      {loading ? <div className="mt-3 h-8 w-20 animate-pulse rounded-lg bg-surface-3" /> : <div className="mt-2 text-3xl font-extrabold tracking-tight tabular-nums">{value}</div>}
    </div>
  );
}

/** Single-series daily bar chart: thin bars, rounded tops on the baseline, hover tooltip, optional table view. */
export function DailyBars({ title, series }: { title: string; series: Series[] | null | undefined }) {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const data = useMemo(() => series ?? [], [series]);
  const max = Math.max(1, ...data.map((d) => d.total));
  const total = data.reduce((sum, d) => sum + d.total, 0);
  const width = 600;
  const height = 160;
  const gap = 2;
  const barWidth = data.length ? width / data.length : width;
  const dayLabel = (day: string, long = false) =>
    new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  const ticks = data.length ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : [];

  return (
    <div className="rounded-3xl border border-border bg-surface p-5 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-bold">{title}</h3>
        <span className="text-lg font-extrabold tabular-nums">{series ? formatNumber(total, locale) : '-'}</span>
      </div>
      {!series ? (
        <div className="mt-4 flex h-40 items-center justify-center rounded-2xl bg-surface-2 text-sm text-muted">{s.unavailable}</div>
      ) : (
        <div className="relative mt-4">
          <div className="mb-1 text-xs text-subtle tabular-nums">{formatNumber(max, locale)}</div>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block h-36 w-full" role="img" aria-label={`${title}: ${formatNumber(total, locale)}`} onMouseLeave={() => setHover(null)}>
            <line x1={0} x2={width} y1={0.5} y2={0.5} stroke="var(--border)" strokeDasharray="3 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} x2={width} y1={height} y2={height} stroke="var(--border-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {data.map((d, index) => {
              const h = d.total ? Math.max(3, (d.total / max) * (height - 4)) : 0;
              const x = index * barWidth + gap / 2;
              const w = Math.max(1, barWidth - gap);
              const r = Math.min(4, w / 2, h);
              const y = height - h;
              return (
                <g key={d.day} onMouseEnter={() => setHover(index)}>
                  <rect x={index * barWidth} y={0} width={barWidth} height={height} fill="transparent" />
                  {h > 0 && (
                    <path
                      d={`M${x},${height} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${height} Z`}
                      fill="var(--brand)"
                      opacity={hover === null || hover === index ? 1 : 0.45}
                    />
                  )}
                </g>
              );
            })}
          </svg>
          <div className="mt-1.5 flex justify-between text-xs text-subtle">
            {ticks.map((index) => (
              <span key={index}>{dayLabel(data[index]!.day)}</span>
            ))}
          </div>
          {hover !== null && data[hover] && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-xl border border-border bg-elevated px-3 py-1.5 text-xs shadow-float"
              style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / data.length) * 100))}%`, top: 20 }}
            >
              <div className="text-muted">{dayLabel(data[hover].day, true)}</div>
              <div className="font-bold tabular-nums">{formatNumber(data[hover].total, locale)}</div>
            </div>
          )}
          <button onClick={() => setTable((v) => !v)} className="mt-2 text-xs font-semibold text-brand hover:underline">
            {table ? s.hideTable : s.showTable}
          </button>
          {table && (
            <div className="scrollbar-thin mt-2 max-h-56 overflow-y-auto rounded-2xl border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-semibold">{s.day}</th>
                    <th className="px-3 py-2 text-right font-semibold">{s.count}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data].reverse().map((d) => (
                    <tr key={d.day} className="border-t border-border">
                      <td className="px-3 py-1.5">{dayLabel(d.day, true)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(d.total, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const statusTone: Record<string, string> = {
  active: 'bg-success-soft text-success',
  suspended: 'bg-danger-soft text-danger',
  pending_profile: 'bg-surface-2 text-muted',
  deleted: 'bg-surface-2 text-subtle',
  open: 'bg-brand-soft text-brand',
  reviewing: 'bg-brand-soft text-brand',
  actioned: 'bg-success-soft text-success',
  dismissed: 'bg-surface-2 text-muted',
};

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={clsx('inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-bold', statusTone[tone] ?? 'bg-surface-2 text-muted')}>{children}</span>;
}

export function RoleBadge({ role }: { role: string }) {
  const { locale } = useI18n();
  if (role === 'user') return null;
  return (
    <span className={clsx('inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-bold', role === 'owner' ? 'bg-brand-gradient text-on-brand' : 'bg-brand-soft text-brand')}>
      {adminStrings(locale).roles[role]}
    </span>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-3xl border border-border bg-surface shadow-card">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 className="font-bold">{title}</h2>
        {action}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center px-6 py-16 text-center text-muted">{children}</div>;
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-2xl px-3 py-3">
          <div className="size-11 animate-pulse rounded-full bg-surface-3" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 animate-pulse rounded bg-surface-3" style={{ width: `${40 + ((index * 17) % 30)}%` }} />
            <div className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${25 + ((index * 23) % 30)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
