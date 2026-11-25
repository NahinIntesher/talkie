'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Avatar, Button } from '@/components/ui/primitives';
import { adminStrings, formatDate } from '@/lib/admin/strings';
import { nameOf, type AuditEntry } from '@/lib/admin/types';
import { Empty, ListSkeleton } from '@/components/admin/ui';

export default function AdminAuditPage() {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api<{ entries: AuditEntry[]; next: string | null }>('/admin/audit')
      .then((result) => {
        setEntries(result.entries);
        setNext(result.next);
      })
      .catch(() => setEntries([]));
  }, []);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const result = await api<{ entries: AuditEntry[]; next: string | null }>(`/admin/audit?before=${next}`);
      setEntries((list) => [...(list ?? []), ...result.entries]);
      setNext(result.next);
    } finally {
      setLoadingMore(false);
    }
  };

  const detail = (entry: AuditEntry) => {
    const d = entry.details ?? {};
    if (entry.action === 'user.role') return `${s.roles[String(d.from)] ?? d.from} → ${s.roles[String(d.to)] ?? d.to}`;
    if (typeof d.reason === 'string' && d.reason) return d.reason;
    if (typeof d.resolution === 'string' && d.resolution) return d.resolution;
    return null;
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <h2 className="text-2xl font-extrabold tracking-tight">{s.audit}</h2>
      <div className="mt-5 rounded-3xl border border-border bg-surface p-2 shadow-card">
        {entries === null ? (
          <ListSkeleton />
        ) : entries.length === 0 ? (
          <Empty>{s.noAudit}</Empty>
        ) : (
          <ol>
            {entries.map((entry) => {
              const extra = detail(entry);
              return (
                <li key={entry.id} className="flex items-start gap-3 rounded-2xl px-3 py-3">
                  <Avatar name={nameOf(entry.actor)} src={entry.actor.avatarUrl} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.95rem]">
                      <span className="font-semibold">{nameOf(entry.actor)}</span> {s.actions[entry.action] ?? entry.action}{' '}
                      {entry.target && (
                        <Link href={`/app/admin/users/${entry.targetId}`} className="font-semibold text-brand hover:underline">
                          {nameOf(entry.target)}
                        </Link>
                      )}
                    </p>
                    {extra && <p className="mt-0.5 truncate text-sm text-muted">{extra}</p>}
                  </div>
                  <time className="shrink-0 text-xs text-subtle" dateTime={entry.createdAt}>
                    {formatDate(entry.createdAt, locale, true)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {next && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void more()}>
            {s.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}
