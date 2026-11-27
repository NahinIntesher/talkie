'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { Camera, Globe, Laptop, Loader2, LogOut, Monitor, Moon, Palette, Shield, Smartphone, Sun, Trash2, User } from 'lucide-react';
import { uploadPhoto } from '@/lib/chat/media';
import { historyApprovalCode, historyTransferCode, transferHistory } from '@/lib/chat/history';
import { about as aboutRule, displayName as displayNameRule, type DeviceInfo, type PrivacyAudience, type PrivacyKey } from '@talkie/contracts';
import { Avatar, Button, Segmented, Switch, TextField } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';

type Section = 'profile' | 'privacy' | 'devices' | 'appearance';

export default function SettingsPage() {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>('profile');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('section') === 'devices') setSection('devices');
  }, []);
  const sections: Array<{ id: Section; label: string; icon: typeof User }> = [
    { id: 'profile', label: t.settings.profile, icon: User },
    { id: 'privacy', label: t.settings.privacy, icon: Shield },
    { id: 'devices', label: t.settings.devices, icon: Laptop },
    { id: 'appearance', label: t.settings.appearance, icon: Palette },
  ];
  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:w-[300px] md:border-r md:border-b-0">
        <h1 className="px-5 pt-5 pb-3 text-2xl font-extrabold tracking-tight">{t.settings.title}</h1>
        {/* Phones: every section visible at once (2 × 2); wider screens: a side list. */}
        <nav className="grid grid-cols-2 gap-1 px-3 pb-3 md:flex md:flex-col" aria-label={t.settings.title}>
          {sections.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? 'page' : undefined}
              className={clsx(
                'relative flex min-w-0 items-center gap-2 rounded-2xl px-2.5 py-3 text-left text-[0.84rem] font-semibold transition-colors md:gap-3 md:px-4 md:text-[0.95rem]',
                section === item.id ? 'text-brand' : 'text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {section === item.id && <motion.span layoutId="settings-active" className="absolute inset-0 rounded-2xl bg-brand-soft" />}
              <item.icon className="relative size-5 shrink-0" aria-hidden />
              <span className="relative truncate">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="scrollbar-thin flex-1 overflow-y-auto">
        <motion.div key={section} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
          {section === 'profile' && <ProfileSection />}
          {section === 'privacy' && <PrivacySection />}
          {section === 'devices' && (
            <div className="space-y-6">
              <DevicesSection />
              <HistorySection />
            </div>
          )}
          {section === 'appearance' && <AppearanceSection />}
        </motion.div>
      </main>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-border bg-surface p-6 shadow-soft">
      <h2 className="text-lg font-bold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ProfileSection() {
  const { t } = useI18n();
  const { user, updateUser } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [about, setAbout] = useState(user?.about ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const { locale } = useI18n();
  if (!user) return null;
  const dirty = name.trim() !== user.displayName || about.trim() !== user.about;

  const save = async () => {
    const parsedName = displayNameRule.safeParse(name);
    const parsedAbout = aboutRule.safeParse(about);
    if (!parsedName.success) return setError(parsedName.error.issues[0]?.message ?? null);
    if (!parsedAbout.success) return setError(parsedAbout.error.issues[0]?.message ?? null);
    setSaving(true);
    setError(null);
    try {
      const { profile } = await api<{ profile: { displayName: string; about: string } }>('/users/me', { method: 'PATCH', body: { displayName: parsedName.data, about: parsedAbout.data } });
      updateUser({ displayName: profile.displayName, about: profile.about });
      toast(t.settings.saved, 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.errors.generic);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-5">
        <label className="group relative cursor-pointer rounded-full focus-within:ring-1 focus-within:ring-[var(--ring-field)]" aria-label={locale === 'bn' ? 'প্রোফাইল ছবি বদলান' : 'Change profile photo'}>
          <Avatar name={name || user.displayName} src={user.avatarUrl} size={88} className="shadow-card ring-4 ring-surface" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
            {photoBusy ? <Loader2 className="size-6 animate-spin" /> : <Camera className="size-6" />}
          </span>
          {photoBusy && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white"><Loader2 className="size-6 animate-spin" /></span>}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setPhotoBusy(true);
              try {
                const mediaId = await uploadPhoto(file, 'avatar');
                const { avatarUrl } = await api<{ avatarUrl: string }>('/users/me/avatar', { method: 'PUT', body: { mediaId } });
                updateUser({ avatarUrl });
                toast(t.settings.saved, 'success');
              } catch (err) {
                toast(err instanceof ApiError ? err.message : t.errors.generic, 'error');
              } finally {
                setPhotoBusy(false);
              }
            }}
          />
        </label>
        <div className="min-w-0">
          <p className="truncate text-xl font-extrabold">{user.displayName}</p>
          <p className="truncate text-muted">@{user.username}</p>
          <p className="truncate text-sm text-subtle">{user.email}</p>
        </div>
      </div>
      <Panel title={t.settings.profile}>
        <div className="space-y-5">
          <TextField label={t.auth.nameLabel} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <TextField label={t.settings.about} value={about} maxLength={140} placeholder={t.settings.aboutPlaceholder} onChange={(e) => setAbout(e.target.value)} hint={`${about.length}/140`} />
          {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
              {t.settings.save}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function PrivacySection() {
  const { t } = useI18n();
  const toast = useToast();
  const [privacy, setPrivacy] = useState<Record<PrivacyKey, PrivacyAudience> | null>(null);
  const [readReceipts, setReadReceipts] = useState(true);

  useEffect(() => {
    api<{ privacy: Record<PrivacyKey, PrivacyAudience>; readReceipts: boolean }>('/users/me')
      .then((data) => {
        setPrivacy(data.privacy);
        setReadReceipts(data.readReceipts);
      })
      .catch(() => toast(t.errors.generic, 'error'));
  }, [t.errors.generic, toast]);

  const update = async (body: object, revert: () => void) => {
    try {
      await api('/users/me/privacy', { method: 'PUT', body });
      toast(t.settings.saved, 'success');
    } catch {
      revert();
      toast(t.errors.generic, 'error');
    }
  };

  const rows: Array<{ key: PrivacyKey; label: string }> = [
    { key: 'last_seen', label: t.settings.lastSeen },
    { key: 'online', label: t.settings.online },
    { key: 'profile_photo', label: t.settings.profilePhoto },
    { key: 'about', label: t.settings.aboutPrivacy },
    { key: 'status', label: t.settings.statusPrivacy },
    { key: 'groups_add', label: t.settings.groupsAdd },
  ];
  const audiences: Array<{ value: PrivacyAudience; label: string }> = [
    { value: 'everyone', label: t.settings.everyone },
    { value: 'contacts', label: t.settings.contacts },
    { value: 'nobody', label: t.settings.nobody },
  ];

  if (!privacy) return <Skeleton rows={6} />;
  return (
    <div className="space-y-6">
      <Panel title={t.settings.privacy}>
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-semibold">{row.label}</span>
              <Segmented
                label={row.label}
                value={privacy[row.key]}
                options={audiences}
                onChange={(audience) => {
                  const previous = privacy[row.key];
                  setPrivacy({ ...privacy, [row.key]: audience });
                  void update({ settings: [{ key: row.key, audience }] }, () => setPrivacy((p) => (p ? { ...p, [row.key]: previous } : p)));
                }}
              />
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={t.settings.readReceipts}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">{t.settings.readReceipts}</span>
          <Switch
            checked={readReceipts}
            label={t.settings.readReceipts}
            onChange={(value) => {
              setReadReceipts(value);
              void update({ readReceipts: value }, () => setReadReceipts(!value));
            }}
          />
        </div>
      </Panel>
    </div>
  );
}

function DevicesSection() {
  const { t, locale } = useI18n();
  const { signOut } = useSession();
  const toast = useToast();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);

  const load = () => api<{ devices: DeviceInfo[] }>('/auth/devices').then((data) => setDevices(data.devices)).catch(() => toast(t.errors.generic, 'error'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (device: DeviceInfo) => {
    if (device.current) return void signOut();
    if (!window.confirm(locale === 'bn' ? `${device.name} থেকে সাইন আউট করবেন?` : `Sign out ${device.name}?`)) return;
    try {
      await api(`/auth/devices/${device.id}`, { method: 'DELETE' });
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null);
    } catch {
      toast(t.errors.generic, 'error');
    }
  };

  const when = (iso: string) => new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  if (!devices) return <Skeleton rows={3} />;
  return (
    <Panel title={t.settings.devices} description={locale === 'bn' ? 'একসঙ্গে সর্বোচ্চ তিনটি ডিভাইস সক্রিয় থাকবে।' : 'Up to three devices can stay signed in.'}>
      <ul className="space-y-3">
        {devices.map((device) => {
          const Icon = device.platform === 'web' || device.platform === 'desktop' ? Monitor : Smartphone;
          return (
            <li key={device.id} className="flex items-center gap-4 rounded-2xl border border-border p-4">
              <span className={clsx('inline-flex size-12 items-center justify-center rounded-2xl', device.current ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted')}>
                <Icon className="size-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {device.name}
                  {device.current && <span className="ml-2 rounded-full bg-success-soft px-2 py-0.5 text-xs font-bold text-success">{t.settings.thisDevice}</span>}
                </p>
                <p className="text-sm text-subtle">{device.platform === 'web' ? 'Web' : device.platform === 'android' ? 'Android' : device.platform === 'ios' ? 'iOS' : 'Desktop'} · {t.settings.lastActive} {when(device.lastActiveAt)}</p>
                <p className="text-sm text-subtle">{locale === 'bn' ? 'সংযুক্ত' : 'Linked'} {when(device.createdAt)}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void remove(device)} leading={device.current ? <LogOut className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} className="hover:!bg-danger-soft hover:!text-danger">
                {t.settings.signOutDevice}
              </Button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function HistorySection() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [transferCode, setTransferCode] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [pending, setPending] = useState(false);
  const [incoming, setIncoming] = useState<Array<{ deviceId: string; identityKey: string; name: string }>>([]);
  const historyText = (bn: string, en: string) => locale === 'bn' ? bn : en;
  const ownKey = historyTransferCode()?.split('.')[1];

  const loadRequests = async () => {
    const [requests, devices] = await Promise.all([
      api<{ pending: boolean; incoming: Array<{ deviceId: string; identityKey: string }> }>('/chat/history/requests'),
      api<{ devices: DeviceInfo[] }>('/auth/devices'),
    ]);
    setPending(requests.pending);
    setIncoming(requests.incoming.flatMap((request) => {
      const device = devices.devices.find((listed) => listed.id === request.deviceId);
      return device ? [{ ...request, name: device.name }] : [];
    }));
  };

  useEffect(() => { void loadRequests().catch(() => {}); }, []);

  const requestHistory = async () => {
    try {
      await api('/chat/history/requests', { method: 'POST', body: {} });
      setPending(true);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t.errors.generic, 'error');
    }
  };

  const copyTransferCode = async () => {
    try {
      const code = historyTransferCode();
      if (!code) throw new Error('Device keys are loading.');
      await navigator.clipboard.writeText(code);
      toast(historyText('এই ডিভাইসের কোড কপি হয়েছে', 'Device code copied'));
    } catch {
      toast(t.errors.generic, 'error');
    }
  };

  const sendHistory = async (code = transferCode) => {
    setTransferring(true);
    try {
      const { added, unreadable } = await transferHistory(code);
      setTransferCode('');
      const count = new Intl.NumberFormat(locale);
      toast(historyText(`${count.format(added)}টি বার্তার চাবি পাঠানো হয়েছে। ${count.format(unreadable)}টি খোলা যায়নি।`, `Transferred ${count.format(added)} message keys. ${count.format(unreadable)} could not be opened.`));
      void loadRequests().catch(() => {});
    } catch {
      toast(historyText('পাঠানো যায়নি। অন্য ডিভাইসের কোড যাচাই করে আবার চেষ্টা করুন।', 'Transfer failed. Check the code from your other device and try again.'), 'error');
    } finally {
      setTransferring(false);
    }
  };

  return (
    <Panel title={historyText('এনক্রিপ্ট করা চ্যাট ইতিহাস', 'Encrypted chat history')}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{historyText('নতুন ডিভাইসে অনুরোধ পাঠিয়ে আপনার চেনা পুরোনো ডিভাইস থেকে অনুমোদন দিন।', 'Request history here, then approve it from a trusted older device.')}</p>
        {pending && ownKey && <p className="text-sm text-muted">{historyText('এই ডিভাইসের যাচাই কোড', 'This device’s verification code')} <code className="font-bold text-text">{historyApprovalCode(ownKey)}</code></p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending || transferring} onClick={() => void requestHistory()}>{pending ? historyText('অনুমোদনের অপেক্ষায়', 'Awaiting approval') : historyText('চ্যাট ইতিহাস ফিরিয়ে আনুন', 'Restore chat history')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void loadRequests().catch(() => toast(t.errors.generic, 'error'))}>{historyText('অনুরোধ দেখুন', 'Refresh requests')}</Button>
        </div>
        {incoming.map((request) => (
          <div key={request.deviceId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
            <span className="font-semibold">{request.name}</span>
            <Button size="sm" variant="ghost" disabled={transferring} onClick={() => {
              const code = window.prompt(historyText(`${request.name} ডিভাইসে দেখানো যাচাই কোডটি দিন।`, `Enter the verification code shown on ${request.name}.`));
              if (code == null) return;
              if (code.replace(/\s/g, '') !== historyApprovalCode(request.identityKey)) {
                toast(historyText('যাচাই কোড মিলছে না।', 'The verification code does not match.'), 'error');
                return;
              }
              void sendHistory(`${request.deviceId}.${request.identityKey}`);
            }}>{historyText('অনুমোদন দিন', 'Approve')}</Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => void copyTransferCode()}>{historyText('এই ডিভাইসের কোড কপি করুন', 'Copy this device’s code')}</Button>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (!transferring && transferCode.trim()) void sendHistory(); }}>
          <TextField label={historyText('অন্য ডিভাইসের কোড', 'Other device’s code')} value={transferCode} onChange={(event) => setTransferCode(event.target.value)} autoCapitalize="none" spellCheck={false} disabled={transferring} />
          <Button type="submit" disabled={transferring || !transferCode.trim()}>{transferring ? historyText('পাঠানো হচ্ছে…', 'Transferring…') : historyText('চ্যাট ইতিহাস পাঠান', 'Send chat history')}</Button>
        </form>
      </div>
    </Panel>
  );
}

function AppearanceSection() {
  const { t, locale, setLocale } = useI18n();
  const { choice, setChoice } = useTheme();
  return (
    <div className="space-y-6">
      <Panel title={t.settings.theme}>
        <div className="grid grid-cols-3 gap-3">
          {([
            ['light', t.settings.light, Sun],
            ['dark', t.settings.dark, Moon],
            ['system', t.settings.system, Monitor],
          ] as const).map(([value, label, Icon]) => (
            <button
              key={value}
              onClick={() => setChoice(value)}
              aria-pressed={choice === value}
              className={clsx(
                'flex flex-col items-center gap-3 rounded-2xl border-2 p-4 font-semibold transition-all',
                choice === value ? 'border-brand bg-brand-soft text-brand' : 'border-border text-muted hover:border-border-strong hover:text-text',
              )}
            >
              <span className={clsx('flex h-16 w-full items-end justify-center rounded-xl p-2', value === 'dark' ? 'bg-[#10131f]' : value === 'light' ? 'bg-[#f1f3f9]' : 'bg-gradient-to-r from-[#f1f3f9] from-50% to-[#10131f] to-50%')}>
                <span className="h-2 w-2/3 rounded-full bg-brand-gradient" />
              </span>
              <span className="flex items-center gap-1.5 text-sm"><Icon className="size-4" aria-hidden />{label}</span>
            </button>
          ))}
        </div>
      </Panel>
      <Panel title={t.settings.language}>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 font-semibold"><Globe className="size-5 text-muted" aria-hidden />{t.settings.language}</span>
          <Segmented label={t.settings.language} value={locale} onChange={setLocale} options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} />
        </div>
      </Panel>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3 rounded-3xl border border-border bg-surface p-6">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between">
          <div className="h-4 w-1/3 animate-pulse rounded bg-surface-3" />
          <div className="h-9 w-48 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
