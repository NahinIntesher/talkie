'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Avatar, Button } from '@/components/ui/primitives';
import { adminStrings, ago } from '@/lib/admin/strings';
import { nameOf, type Person } from '@/lib/admin/types';
import { Empty, ListSkeleton, Pill, RoleBadge } from '@/components/admin/ui';

type Filter = 'all' | 'active' | 'suspended' | 'staff';

export default function AdminUsersPage() {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const url = useCallback(
    (before?: string) => {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (filter === 'active' || filter === 'suspended') params.set('status', filter);
      if (filter === 'staff') params.set('staff', 'true');
      if (before) params.set('before', before);
      return `/admin/users?${params}`;
    },
    [debounced, filter],
  );

  useEffect(() => {
    let alive = true;
    setPeople(null);
    setFailed(false);
    api<{ users: Person[]; next: string | null }>(url())
      .then((result) => {
        if (!alive) return;
        setPeople(result.users);
        setNext(result.next);
      })
      .catch(() => alive && (setFailed(true), setPeople([])));
    return () => {
      alive = false;
    };
  }, [url]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const result = await api<{ users: Person[]; next: string | null }>(url(next));
      setPeople((list) => [...(list ?? []), ...result.users]);
      setNext(result.next);
    } finally {
      setLoadingMore(false);
    }
  };

  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: s.all },
    { id: 'active', label: s.active },
    { id: 'suspended', label: s.suspended },
    { id: 'staff', label: s.staff },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <h2 className="text-2xl font-extrabold tracking-tight">{s.users}</h2>
      <label className="mt-5 flex h-12 items-center gap-2.5 rounded-2xl bg-surface-2 px-4 transition focus-within:bg-surface focus-within:ring-1 focus-within:ring-[var(--ring-field)]">
        <Search className="size-[1.1rem] text-subtle" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={s.searchPeople}
          aria-label={s.searchPeople}
          autoCapitalize="none"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label={s.cancel} className="text-subtle hover:text-text">
            <X className="size-4" />
          </button>
        )}
      </label>
      <div className="scrollbar-thin mt-3 flex gap-2 overflow-x-auto" role="tablist" aria-label={s.users}>
        {filters.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={clsx('h-8 shrink-0 rounded-full px-3.5 text-sm font-semibold transition-colors', filter === item.id ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted hover:text-text')}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-3xl border border-border bg-surface p-2 shadow-card">
        {people === null ? (
          <ListSkeleton />
        ) : failed ? (
          <Empty>{s.failed}</Empty>
        ) : people.length === 0 ? (
          <Empty>{s.nobody}</Empty>
        ) : (
          <ul>
            {people.map((person) => (
              <li key={person.id}>
                <Link href={`/app/admin/users/${person.id}`} className="flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors hover:bg-surface-2">
                  <Avatar name={person.displayName ?? person.email ?? '?'} src={person.avatarUrl} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{nameOf(person)}</span>
                      <RoleBadge role={person.role} />
                    </span>
                    <span className="block truncate text-sm text-muted">
                      {person.username ? `@${person.username} · ` : ''}
                      {person.email}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-right text-sm text-muted sm:block">{ago(person.lastActiveAt, locale) ?? s.never}</span>
                  {person.status !== 'active' && <Pill tone={person.status}>{s.statuses[person.status]}</Pill>}
                </Link>
              </li>
            ))}
          </ul>
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
