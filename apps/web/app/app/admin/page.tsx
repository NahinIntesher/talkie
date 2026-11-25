'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Activity, Flag, HardDrive, MessageCircle, Phone, UserX, Users, Video } from 'lucide-react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { adminStrings, formatBytes, formatNumber } from '@/lib/admin/strings';
import type { Overview } from '@/lib/admin/types';
import { DailyBars, StatTile } from '@/components/admin/ui';

export default function AdminOverviewPage() {
  const { locale } = useI18n();
  const s = adminStrings(locale);
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Overview>('/admin/overview')
        .then((value) => alive && (setData(value), setFailed(false)))
        .catch(() => alive && setFailed(true));
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const n = (value: number | undefined | null) => (value === undefined || value === null ? '—' : formatNumber(value, locale));
  const loading = !data && !failed;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
      <h2 className="text-2xl font-extrabold tracking-tight">{s.overview}</h2>
      {failed && !data && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">{s.failed}</p>}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile loading={loading} label={s.activeAccounts} value={n(data?.accounts?.accounts.active)} icon={<Users className="size-5" />} />
        <StatTile loading={loading} label={s.activeToday} value={n(data?.accounts?.activeUsers.day)} icon={<Activity className="size-5" />} tone="success" />
        <StatTile loading={loading} label={s.messagesToday} value={n(data?.chat?.messages.today)} icon={<MessageCircle className="size-5" />} />
        <StatTile loading={loading} label={s.openReports} value={n(data?.reports.open)} icon={<Flag className="size-5" />} tone={data?.reports.open ? 'danger' : 'muted'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DailyBars title={s.signupsChart} series={loading ? [] : data?.accounts?.signups} />
        <DailyBars title={s.messagesChart} series={loading ? [] : data?.chat?.messagesDaily} />
        <DailyBars title={s.callsChart} series={loading ? [] : data?.meet?.callsDaily} />
        <DailyBars title={s.meetingsChart} series={loading ? [] : data?.meet?.meetingsDaily} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile loading={loading} label={s.activeWeek} value={n(data?.accounts?.activeUsers.week)} />
        <StatTile loading={loading} label={s.suspended} value={n(data?.accounts?.accounts.suspended)} icon={<UserX className="size-5" />} tone="muted" />
        <StatTile loading={loading} label={s.groups} value={n(data?.chat?.groups)} />
        <StatTile loading={loading} label={s.totalMessages} value={n(data?.chat?.messages.total)} />
        <StatTile loading={loading} label={s.liveCalls} value={n(data?.meet?.calls.live)} icon={<Phone className="size-5" />} tone="success" />
        <StatTile loading={loading} label={s.liveMeetings} value={n(data?.meet?.meetings.live)} icon={<Video className="size-5" />} tone="success" />
        <StatTile loading={loading} label={s.callMinutes} value={n(data?.meet?.minutes.calls)} />
        <StatTile loading={loading} label={s.meetingMinutes} value={n(data?.meet?.minutes.meetings)} />
        <StatTile loading={loading} label={s.storage} value={data?.media ? formatBytes(data.media.bytes, locale) : '—'} icon={<HardDrive className="size-5" />} tone="muted" />
        <StatTile loading={loading} label={s.files} value={n(data?.media?.files)} />
        <StatTile loading={loading} label={s.liveStatuses} value={n(data?.chat?.liveStatuses)} />
        <StatTile
          loading={loading}
          label={s.devices}
          value={data?.accounts ? n(Object.values(data.accounts.devices).reduce((a, b) => a + b, 0)) : '—'}
        />
      </div>
    </motion.div>
  );
}
