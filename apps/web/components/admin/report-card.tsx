'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Users, Video } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Avatar, Button, TextField } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { adminStrings, ago } from '@/lib/admin/strings';
import { nameOf, type Report } from '@/lib/admin/types';
import { Pill } from './ui';

/** One report in the moderation queue, with its review actions. */
export function ReportCard({ report, onChanged, showTarget = true }: { report: Report; onChanged: () => void; showTarget?: boolean }) {
  const { locale, digits } = useI18n();
  const s = adminStrings(locale);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [note, setNote] = useState('');
  const [suspend, setSuspend] = useState(report.targetType === 'user' && report.target?.status === 'active');

  const update = async (status: Report['status'], extra: { resolution?: string; suspend?: boolean } = {}) => {
    setBusy(status);
    try {
      await api(`/admin/reports/${report.id}`, { method: 'POST', body: { status, ...extra } });
      setActing(false);
      onChanged();
    } catch (error) {
      toast(error instanceof ApiError && error.status === 403 ? error.message : s.failed, 'error');
    } finally {
      setBusy(null);
    }
  };

  const closed = report.status === 'actioned' || report.status === 'dismissed';
  const target = report.target;

  return (
    <article className="rounded-3xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={report.status}>{s.reportStatus[report.status]}</Pill>
        <span className="inline-flex h-6 items-center rounded-full bg-danger-soft px-2.5 text-xs font-bold text-danger">{s.reasons[report.reason] ?? report.reason}</span>
        <span className="ml-auto text-xs text-subtle">{ago(report.createdAt, locale)}</span>
      </div>

      {showTarget && target && (
        <div className="mt-3 flex items-center gap-3">
          {report.targetType === 'user' ? (
            <>
              <Avatar name={nameOf(target)} src={target.avatarUrl} size={44} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{nameOf(target)}</div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  {target.username && <span>@{target.username}</span>}
                  {target.status && target.status !== 'active' && <Pill tone={target.status}>{s.statuses[target.status]}</Pill>}
                  {(target.openReports ?? 0) > 1 && <span className="font-semibold text-danger">{s.openReportsAbout.replace('{n}', digits(target.openReports!))}</span>}
                </div>
              </div>
              <Link href={`/app/admin/users/${report.targetId}`} className="shrink-0 rounded-xl px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand-soft">
                {s.viewPerson}
              </Link>
            </>
          ) : (
            <>
              <span className="inline-flex size-11 items-center justify-center rounded-full bg-brand-soft text-brand">
                {report.targetType === 'group' ? <Users className="size-5" aria-hidden /> : <Video className="size-5" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{target.name ?? (report.targetType === 'group' ? s.group : s.meeting)}</div>
                {report.targetType === 'group' && <div className="text-sm text-muted">{s.members.replace('{n}', digits(target.members ?? 0))}</div>}
              </div>
            </>
          )}
        </div>
      )}

      {report.note && <p className="mt-3 rounded-2xl bg-surface-2 px-4 py-3 text-[0.95rem] break-words whitespace-pre-wrap">{report.note}</p>}

      <div className="mt-3 flex items-center gap-2 text-sm text-muted">
        <span>{s.reportedBy}</span>
        <Avatar name={nameOf(report.reporter)} src={report.reporter?.avatarUrl} size={22} />
        <span className="truncate font-semibold text-text">{nameOf(report.reporter)}</span>
      </div>

      {closed && report.resolution && (
        <p className="mt-3 border-l-4 border-border-strong pl-3 text-sm text-muted">
          {report.assignee && <span className="font-semibold text-text">{nameOf(report.assignee)}: </span>}
          {report.resolution}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {closed ? (
          <Button size="sm" variant="ghost" loading={busy === 'open'} onClick={() => void update('open')}>
            {s.reopen}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => setActing(true)}>
              {s.takeAction}
            </Button>
            {report.status === 'open' && (
              <Button size="sm" variant="secondary" loading={busy === 'reviewing'} onClick={() => void update('reviewing')}>
                {s.review}
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={busy === 'dismissed'} onClick={() => void update('dismissed')}>
              {s.dismiss}
            </Button>
          </>
        )}
      </div>

      <Dialog open={acting} onClose={() => setActing(false)} title={s.takeAction}>
        <form
          className="space-y-4 px-5 pt-2 pb-5"
          onSubmit={(event) => {
            event.preventDefault();
            void update('actioned', { resolution: note.trim(), suspend: report.targetType === 'user' && suspend });
          }}
        >
          <TextField label={s.resolution} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          {report.targetType === 'user' && target?.status !== 'suspended' && (
            <label className="flex items-center gap-3 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">
              <input type="checkbox" checked={suspend} onChange={(event) => setSuspend(event.target.checked)} className="size-4 accent-[var(--danger)]" />
              {s.suspendTarget}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setActing(false)}>
              {s.cancel}
            </Button>
            <Button type="submit" variant={suspend && report.targetType === 'user' ? 'danger' : 'primary'} loading={busy === 'actioned'}>
              {s.confirm}
            </Button>
          </div>
        </form>
      </Dialog>
    </article>
  );
}
