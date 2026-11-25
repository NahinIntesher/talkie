'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { CalendarClock, Copy, Keyboard, Link2, Lock, Plus, Users, Video } from 'lucide-react';
import type { MeetingInfo } from '@talkie/contracts';
import { Button, TextField } from '@/components/ui/primitives';
import { Dialog, Menu } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { dayLabel, timeOf } from '@/lib/chat/strings';
import { nameOf, useChat } from '@/lib/chat/store';
import { loadProfiles } from '@/lib/chat/engine';

const copy = {
  en: {
    title: 'Meetings for everyone',
    newMeeting: 'New meeting',
    instant: 'Start an instant meeting',
    later: 'Create a meeting for later',
    schedule: 'Schedule a meeting',
    code: 'Enter a code or link',
    join: 'Join',
    upcoming: 'Your meetings',
    none: 'No meetings yet. Create one and share the link.',
    live: 'Live now',
    copy: 'Copy link',
    copied: 'Link copied',
    ready: 'Here is your meeting link',
    name: 'Title',
    namePlaceholder: 'e.g. Weekly team sync',
    starts: 'Starts',
    ends: 'Ends',
    access: 'Who can join without asking',
    open: 'Anyone with the link',
    trusted: 'Invited people',
    restricted: 'Only invited people (others can’t ask)',
    create: 'Create',
    host: 'Host',
    start: 'Join now',
  },
  bn: {
    title: 'সবার জন্য মিটিং',
    newMeeting: 'নতুন মিটিং',
    instant: 'এখনই মিটিং শুরু করুন',
    later: 'পরে ব্যবহারের জন্য মিটিং তৈরি',
    schedule: 'মিটিংয়ের সময় ঠিক করুন',
    code: 'কোড বা লিংক লিখুন',
    join: 'যোগ দিন',
    upcoming: 'আপনার মিটিং',
    none: 'এখনো কোনো মিটিং নেই। একটি তৈরি করে লিংক শেয়ার করুন।',
    live: 'এখন চলছে',
    copy: 'লিংক কপি',
    copied: 'লিংক কপি হয়েছে',
    ready: 'আপনার মিটিং লিংক',
    name: 'শিরোনাম',
    namePlaceholder: 'যেমন: সাপ্তাহিক টিম মিটিং',
    starts: 'শুরু',
    ends: 'শেষ',
    access: 'কে না জিজ্ঞেস করেই যোগ দিতে পারবে',
    open: 'লিংক আছে এমন যে কেউ',
    trusted: 'আমন্ত্রিতরা',
    restricted: 'শুধু আমন্ত্রিতরা (অন্যরা অনুরোধও করতে পারবে না)',
    create: 'তৈরি করুন',
    host: 'হোস্ট',
    start: 'এখন যোগ দিন',
  },
};

const linkOf = (code: string) => `${typeof window === 'undefined' ? '' : window.location.origin}/meet/${code}`;

export default function MeetPage() {
  const { locale } = useI18n();
  const t = copy[locale];
  const router = useRouter();
  const toast = useToast();
  const chat = useChat();
  const [code, setCode] = useState('');
  const [meetings, setMeetings] = useState<MeetingInfo[] | null>(null);
  const [created, setCreated] = useState<MeetingInfo | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ meetings: MeetingInfo[] }>('/meet/meetings')
      .then(({ meetings: list }) => {
        setMeetings(list);
        void loadProfiles(list.map((m) => m.hostId));
      })
      .catch(() => setMeetings([]));
  useEffect(() => {
    void load();
  }, []);

  const create = async (body: object, open: boolean) => {
    setBusy(true);
    try {
      const { meeting } = await api<{ meeting: MeetingInfo }>('/meet/meetings', { method: 'POST', body });
      if (open) router.push(`/meet/${meeting.code}`);
      else {
        setCreated(meeting);
        void load();
      }
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Error', 'error');
    } finally {
      setBusy(false);
    }
  };

  const joinCode = (event: FormEvent) => {
    event.preventDefault();
    const match = /([a-z]{3}-?[a-z]{4}-?[a-z]{3})/i.exec(code.trim());
    if (!match) return toast(locale === 'bn' ? 'সঠিক মিটিং কোড লিখুন' : 'Enter a valid meeting code', 'error');
    const clean = match[1]!.toLowerCase().replace(/-/g, '');
    router.push(`/meet/${clean.slice(0, 3)}-${clean.slice(3, 7)}-${clean.slice(7)}`);
  };

  const copyLink = (value: string) => void navigator.clipboard.writeText(linkOf(value)).then(() => toast(t.copied, 'success'));

  return (
    <div className="ambient scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8 lg:py-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              {t.title}
            </motion.h1>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Menu
                label={t.newMeeting}
                align="start"
                trigger={(props) => (
                  <Button size="lg" leading={<Video className="size-5" aria-hidden />} loading={busy} {...props}>
                    {t.newMeeting}
                  </Button>
                )}
                items={[
                  { label: t.instant, icon: <Plus />, onSelect: () => void create({ title: '', access: 'open' }, true) },
                  { label: t.later, icon: <Link2 />, onSelect: () => void create({ title: '' }, false) },
                  { label: t.schedule, icon: <CalendarClock />, onSelect: () => setScheduling(true) },
                ]}
              />
              <form onSubmit={joinCode} className="flex flex-1 items-center gap-2">
                <label className="flex h-13 flex-1 items-center gap-2.5 rounded-2xl border border-border-strong bg-surface px-4 focus-within:border-brand focus-within:ring-4 focus-within:ring-[var(--ring)]">
                  <Keyboard className="size-5 text-subtle" aria-hidden />
                  <span className="sr-only">{t.code}</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.code} className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle" />
                </label>
                <Button type="submit" variant="ghost" size="lg" disabled={!code.trim()} className={clsx(code.trim() && '!text-brand')}>
                  {t.join}
                </Button>
              </form>
            </div>
            <p className="mt-6 flex items-center gap-1.5 text-sm text-subtle">
              <Lock className="size-4" aria-hidden />
              talkie.kodofact.com/meet/abc-defg-hij
            </p>
          </div>
          <Illustration />
        </div>

        <section className="mt-14">
          <h2 className="text-lg font-bold">{t.upcoming}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {meetings?.map((meeting) => (
              <motion.div key={meeting.id} layout className="flex flex-col rounded-3xl border border-border bg-surface p-5 shadow-soft">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold">{meeting.title || meeting.code}</p>
                    <p className="mt-1 text-sm text-muted">
                      {meeting.status === 'live' ? (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-success">
                          <span className="size-2 animate-pulse rounded-full bg-success" />
                          {t.live} · {meeting.participantCount}
                        </span>
                      ) : meeting.scheduledStartAt ? (
                        `${dayLabel(meeting.scheduledStartAt, locale)}, ${timeOf(meeting.scheduledStartAt, locale)}`
                      ) : (
                        meeting.code
                      )}
                    </p>
                    <p className="mt-1 text-xs text-subtle">
                      {t.host}: {nameOf(chat, meeting.hostId, locale === 'bn' ? 'আপনি' : 'You')}
                    </p>
                  </div>
                  <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <Users className="size-5" aria-hidden />
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button size="sm" className="flex-1" onClick={() => router.push(`/meet/${meeting.code}`)}>
                    {t.start}
                  </Button>
                  <Button size="sm" variant="secondary" leading={<Copy className="size-4" aria-hidden />} onClick={() => copyLink(meeting.code)}>
                    {t.copy}
                  </Button>
                </div>
              </motion.div>
            ))}
          </div>
          {meetings && !meetings.length && <p className="mt-4 text-sm text-muted">{t.none}</p>}
        </section>
      </div>

      <Dialog open={!!created} onClose={() => setCreated(null)} title={t.ready}>
        {created && (
          <div className="space-y-4 px-5 pb-6">
            <div className="flex items-center gap-2 rounded-2xl bg-surface-2 p-2 pl-4">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{linkOf(created.code)}</span>
              <Button size="sm" variant="secondary" onClick={() => copyLink(created.code)} leading={<Copy className="size-4" aria-hidden />}>
                {t.copy}
              </Button>
            </div>
            <Button block onClick={() => router.push(`/meet/${created.code}`)}>
              {t.start}
            </Button>
          </div>
        )}
      </Dialog>

      <ScheduleDialog
        open={scheduling}
        onClose={() => setScheduling(false)}
        onCreate={(body) => {
          setScheduling(false);
          void create(body, false);
        }}
      />
    </div>
  );
}

function ScheduleDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (body: object) => void }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [access, setAccess] = useState<'open' | 'trusted' | 'restricted'>('trusted');
  useEffect(() => {
    if (!open) return;
    const next = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
    setTitle('');
    setStart(local(next));
    setEnd(local(new Date(next.getTime() + 3_600_000)));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={t.schedule}>
      <form
        className="space-y-4 px-5 pb-6"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ title: title.trim(), access, scheduledStartAt: start ? new Date(start).toISOString() : null, scheduledEndAt: end ? new Date(end).toISOString() : null });
        }}
      >
        <TextField label={t.name} placeholder={t.namePlaceholder} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label={t.starts} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label={t.ends} type="datetime-local" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">{t.access}</legend>
          {(['open', 'trusted', 'restricted'] as const).map((value) => (
            <label key={value} className={clsx('flex cursor-pointer items-center gap-3 rounded-2xl border p-3 text-sm', access === value ? 'border-brand bg-brand-soft' : 'border-border')}>
              <input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} className="accent-[var(--brand)]" />
              {t[value]}
            </label>
          ))}
        </fieldset>
        <Button type="submit" block>
          {t.create}
        </Button>
      </form>
    </Dialog>
  );
}

function Illustration() {
  const tiles = ['from-indigo-500 to-violet-600', 'from-fuchsia-500 to-pink-600', 'from-sky-500 to-indigo-600', 'from-emerald-500 to-teal-600'];
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-8 rounded-full bg-brand-gradient opacity-20 blur-3xl" />
      <div className="relative grid grid-cols-2 gap-3 rounded-[2rem] bg-[#0b0d1a] p-3 shadow-float">
        {tiles.map((tone, index) => (
          <motion.div
            key={tone}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + index * 0.08 }}
            className={clsx('relative flex aspect-video items-center justify-center rounded-2xl bg-gradient-to-br', tone, index === 0 && 'ring-[3px] ring-emerald-400')}
          >
            <span className="size-12 rounded-full bg-white/25" />
            {index === 2 && <span className="absolute top-2 left-2 rounded-full bg-amber-400 px-2 py-0.5 text-[0.65rem] font-bold text-black">✋</span>}
          </motion.div>
        ))}
        <div className="col-span-2 flex justify-center gap-2 pt-1">
          {['bg-white/15', 'bg-white/15', 'bg-white/15', 'bg-red-500'].map((tone, index) => (
            <span key={index} className={clsx('h-9 rounded-full', tone, index === 3 ? 'w-14' : 'w-9')} />
          ))}
        </div>
      </div>
    </div>
  );
}
