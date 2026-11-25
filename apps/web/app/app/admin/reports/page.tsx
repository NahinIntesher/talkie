'use client';

import { useCallback, useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button, Segmented } from '@/components/ui/primitives';
import { adminStrings } from '@/lib/admin/strings';
import type { Report } from '@/lib/admin/types';
import { Empty, ListSkeleton } from '@/components/admin/ui';
import { ReportCard } from '@/components/admin/report-card';

type Tab = 'open' | 'closed' | 'all';

export default function AdminReportsPage() {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const [tab, setTab] = useState<Tab>('open');
  const [reports, setReports] = useState<Report[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    const result = await api<{ reports: Report[]; next: string | null }>(`/admin/reports?status=${tab}`).catch(() => ({ reports: [], next: null }));
    setReports(result.reports);
    setNext(result.next);
  }, [tab]);

  useEffect(() => {
    setReports(null);
    void load();
  }, [load]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const result = await api<{ reports: Report[]; next: string | null }>(`/admin/reports?status=${tab}&before=${next}`);
      setReports((list) => [...(list ?? []), ...result.reports]);
      setNext(result.next);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-extrabold tracking-tight">{s.reports}</h2>
        <Segmented
          label={s.reports}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: s.open },
            { value: 'closed', label: s.closed },
            { value: 'all', label: s.all },
          ]}
        />
      </div>
      <div className="mt-5 space-y-3">
        {reports === null ? (
          <ListSkeleton rows={3} />
        ) : reports.length === 0 ? (
          <Empty>
            <span className="mb-4 inline-flex size-16 items-center justify-center rounded-[1.4rem] bg-brand-soft text-brand">
              <Flag className="size-7" aria-hidden />
            </span>
            <span className="font-semibold">{s.noReports}</span>
          </Empty>
        ) : (
          reports.map((report) => <ReportCard key={report.id} report={report} onChanged={() => void load()} />)
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
