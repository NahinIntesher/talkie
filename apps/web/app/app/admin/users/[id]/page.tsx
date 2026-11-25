'use client';

import { use, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Laptop, LogOut, RotateCcw, ShieldCheck, Smartphone, UserX } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Avatar, Button, Segmented, TextField } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { adminStrings, ago, formatBytes, formatDate, formatNumber } from '@/lib/admin/strings';
import { nameOf, rank, type PersonDetail, type Role } from '@/lib/admin/types';
import { Empty, ListSkeleton, Panel, Pill, RoleBadge } from '@/components/admin/ui';
import { ReportCard } from '@/components/admin/report-card';

export default function AdminPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { locale, digits } = useI18n();
  const s = adminStrings(locale);
  const toast = useToast();
  const { user: me } = useSession();
  const myRole = (me?.role ?? 'user') as Role;
  const [data, setData] = useState<PersonDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<PersonDetail>(`/admin/users/${id}`));
    } catch {
      setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, path: string, method: 'POST' | 'PUT', body?: unknown, done?: (result: unknown) => void) => {
    setBusy(key);
    try {
      const result = await api(path, { method, body: body ?? {} });
      done?.(result);
      await load();
    } catch (error) {
      toast(error instanceof ApiError && (error.status === 403 || error.status === 409) ? error.message : s.failed, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (missing) return <Empty>{s.nobody}</Empty>;
  if (!data)
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <ListSkeleton rows={4} />
      </div>
    );

  const person = data.user;
  const canManage = me?.id !== person.id && rank[myRole] > rank[person.role];
  const n = (value: number | undefined) => (value === undefined ? '—' : formatNumber(value, locale));

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-8 sm:py-8">
      <Link href="/app/admin/users" className="inline-flex items-center gap-2 rounded-xl px-2 py-1 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden />
        {s.back}
      </Link>

      <section className="rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={nameOf(person)} src={person.avatarUrl} size={80} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-2xl font-extrabold tracking-tight">{nameOf(person)}</h2>
              <RoleBadge role={person.role} />
              <Pill tone={person.status}>{s.statuses[person.status]}</Pill>
            </div>
            <p className="mt-1 text-muted">
              {person.username && <span>@{person.username} · </span>}
              {person.email}
            </p>
            {person.about && <p className="mt-2 text-[0.95rem]">{person.about}</p>}
          </div>
        </div>
        {person.status === 'suspended' && person.suspendedReason && (
          <p className="mt-4 rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger">
            <span className="font-bold">{s.suspendedReason}: </span>
            {person.suspendedReason}
          </p>
        )}
        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact label={s.joined}>{formatDate(person.createdAt, locale)}</Fact>
          <Fact label={s.lastActive}>{ago(person.lastActiveAt, locale) ?? s.never}</Fact>
          <Fact label={s.devices}>{digits(person.devices)}</Fact>
          <Fact label={s.reportsFiled}>{digits(data.reportsFiled)}</Fact>
        </dl>
        {canManage && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-5">
            {person.status === 'active' && (
              <Button variant="danger" size="sm" leading={<UserX className="size-4" />} onClick={() => setSuspending(true)}>
                {s.suspend}
              </Button>
            )}
            {person.status === 'suspended' && (
              <Button size="sm" leading={<RotateCcw className="size-4" />} loading={busy === 'restore'} onClick={() => void act('restore', `/admin/users/${id}/restore`, 'POST')}>
                {s.restore}
              </Button>
            )}
            {rank[myRole] >= rank.admin && person.devices > 0 && (
              <Button
                variant="outline"
                size="sm"
                leading={<LogOut className="size-4" />}
                loading={busy === 'signout'}
                onClick={() =>
                  void act('signout', `/admin/users/${id}/sign-out`, 'POST', {}, (result) =>
                    toast(s.signOutDone.replace('{n}', digits((result as { revoked: number }).revoked)), 'success'),
                  )
                }
              >
                {s.signOutEverywhere}
              </Button>
            )}
          </div>
        )}
      </section>

      {myRole === 'owner' && canManage && person.status === 'active' && (
        <Panel title={s.changeRole} action={<ShieldCheck className="size-5 text-brand" aria-hidden />}>
          <Segmented<Exclude<Role, 'owner'>>
            label={s.changeRole}
            value={person.role as Exclude<Role, 'owner'>}
            onChange={(role) => void act('role', `/admin/users/${id}/role`, 'PUT', { role })}
            options={(['user', 'moderator', 'admin'] as const).map((role) => ({ value: role, label: s.roles[role]! }))}
          />
        </Panel>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Panel title={s.activity}>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <Fact label={s.messagesSent}>{n(data.activity?.messagesSent)}</Fact>
            <Fact label={s.lastMessage}>{ago(data.activity?.lastMessageAt ?? null, locale) ?? '—'}</Fact>
            <Fact label={s.directChats}>{n(data.activity?.directChats)}</Fact>
            <Fact label={s.groups}>{n(data.activity?.groups)}</Fact>
            <Fact label={s.groupsOwned}>{n(data.activity?.groupsOwned)}</Fact>
            <Fact label={s.storageUsed}>{data.storage ? formatBytes(data.storage.bytes, locale) : '—'}</Fact>
          </dl>
        </Panel>
        <Panel title={s.linkedDevices}>
          {data.devices.length === 0 ? (
            <p className="text-sm text-muted">—</p>
          ) : (
            <ul className="space-y-2">
              {data.devices.map((device) => (
                <li key={device.id} className="flex items-center gap-3">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    {device.platform === 'android' || device.platform === 'ios' ? <Smartphone className="size-4" aria-hidden /> : <Laptop className="size-4" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{device.name}</span>
                    <span className="block text-xs text-muted">{device.revokedAt ? s.signedOut : ago(device.lastActiveAt, locale)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {data.reports.length > 0 && (
        <section className="space-y-3">
          <h3 className="px-1 font-bold">{s.reportsAgainst}</h3>
          {data.reports.map((report) => (
            <ReportCard key={report.id} report={{ ...report, target: { id: person.id, status: person.status } }} onChanged={() => void load()} showTarget={false} />
          ))}
        </section>
      )}

      <Dialog open={suspending} onClose={() => setSuspending(false)} title={s.suspendTitle}>
        <form
          className="space-y-4 px-5 pt-2 pb-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            void act('suspend', `/admin/users/${id}/suspend`, 'POST', { reason: reason.trim() }, () => {
              setSuspending(false);
              setReason('');
            });
          }}
        >
          <TextField label={s.reason} value={reason} required maxLength={255} onChange={(event) => setReason(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setSuspending(false)}>
              {s.cancel}
            </Button>
            <Button type="submit" variant="danger" loading={busy === 'suspend'} disabled={!reason.trim()}>
              {s.suspend}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{children}</dd>
    </div>
  );
}
