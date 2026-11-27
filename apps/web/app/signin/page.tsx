'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, AtSign, CheckCircle2, Loader2, Mail, User, XCircle } from 'lucide-react';
import { displayName as displayNameRule, email as emailRule, username as usernameRule, type OtpRequested, type OtpVerified } from '@talkie/contracts';
import { Button, Logo, TextField } from '@/components/ui/primitives';
import { PreferenceControls } from '@/components/ui/preferences';
import { OtpInput } from '@/components/auth/otp-input';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

type Step = 'email' | 'code' | 'profile' | 'done';

function browserDevice() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { name: os ? `${browser} on ${os}` : browser, platform: 'web' as const };
}

const slide = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -28 },
  transition: { type: 'spring' as const, stiffness: 360, damping: 34 },
};

export default function SignInPage() {
  const { t, locale, format } = useI18n();
  const { status, signedIn } = useSession();
  const router = useRouter();
  // Only same-site paths: never redirect to another origin after sign-in.
  const next = (() => {
    if (typeof window === 'undefined') return '/app';
    const value = new URLSearchParams(window.location.search).get('next') ?? '';
    return /^\/(?!\/)[\w\-/?=&.]*$/.test(value) ? value : '/app';
  })();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<OtpRequested | null>(null);
  const requestKey = useRef('');
  const [code, setCode] = useState('');
  const [signupToken, setSignupToken] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sentAt, setSentAt] = useState(0);

  useEffect(() => {
    if (status === 'signed_in' && step !== 'done') router.replace(next);
  }, [status, step, router]);

  useEffect(() => {
    if (step !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  const message = (err: unknown) => (err instanceof ApiError ? (err.code === 'network' ? t.errors.network : err.message) : t.errors.generic);

  const finish = (result: Extract<OtpVerified, { status: 'signed_in' }>) => {
    setStep('done');
    signedIn(result);
    setTimeout(() => router.replace(next), 900);
  };

  const requestCode = async (event?: FormEvent) => {
    event?.preventDefault();
    const parsed = emailRule.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? t.errors.generic);
    setBusy(true);
    setError(null);
    const attempt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const showCode = (result: OtpRequested) => {
      requestKey.current = attempt;
      setChallenge(result);
      setSentAt(Date.now());
      setNow(Date.now());
      setCode('');
      setCodeInvalid(false);
      setStep('code');
    };
    try {
      showCode(await api<OtpRequested>('/auth/otp/request', { method: 'POST', body: { email: parsed.data, locale, requestKey: attempt } }));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
        showCode({ challengeId: '', expiresAt: '', resendAfterSeconds: 60, delivery: 'uncertain' });
      } else setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!challenge || busy) return;
    setBusy(true);
    setError(null);
    setCodeInvalid(false);
    try {
      const proof = challenge.challengeId ? { challengeId: challenge.challengeId } : { requestKey: requestKey.current };
      const result = await api<OtpVerified>('/auth/otp/verify', { method: 'POST', body: { ...proof, code: value, device: browserDevice() } });
      if (result.status === 'signed_in') return finish(result);
      setSignupToken(result.signupToken);
      setStep('profile');
    } catch (err) {
      setCodeInvalid(true);
      setCode('');
      const left = err instanceof ApiError ? (err.details?.attemptsLeft as number | undefined) : undefined;
      setError(left !== undefined ? `${message(err)} ${format(t.auth.attemptsLeft, { n: left })}` : message(err));
    } finally {
      setBusy(false);
    }
  };

  const resendLeft = challenge ? Math.max(0, challenge.resendAfterSeconds - Math.floor((now - sentAt) / 1000)) : 0;

  return (
    <div className="ambient relative flex min-h-dvh flex-col">
      <div className="grid-fade pointer-events-none absolute inset-0 opacity-50" aria-hidden />
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" aria-label="Talkie home">
          <Logo />
        </Link>
        <PreferenceControls />
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:items-center sm:pt-0">
        <div className="w-full max-w-[28rem]">
          <div className="glass overflow-hidden rounded-[2rem] border border-border p-6 shadow-float sm:p-9">
            <Progress step={step} />
            <AnimatePresence mode="wait" initial={false}>
              {step === 'email' && (
                <motion.form key="email" {...slide} onSubmit={requestCode} noValidate className="mt-7">
                  <StepIcon icon={<Mail className="size-6" />} />
                  <h1 className="mt-5 text-2xl font-extrabold tracking-tight">{t.auth.emailTitle}</h1>
                  <TextField
                    className="mt-7"
                    label={t.auth.emailLabel}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoFocus
                    placeholder={t.auth.emailPlaceholder}
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setError(null);
                    }}
                    error={error}
                    leading={<AtSign className="size-[1.1rem]" />}
                  />
                  <Button type="submit" size="lg" block loading={busy} className="mt-6" trailing={<ArrowRight className="size-5" aria-hidden />}>
                    {t.auth.continue}
                  </Button>
                </motion.form>
              )}

              {step === 'code' && (
                <motion.div key="code" {...slide} className="mt-7">
                  <BackButton label={t.auth.changeEmail} onClick={() => { setStep('email'); setError(null); }} />
                  <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t.auth.codeTitle}</h1>
                  <p className="mt-2 leading-relaxed text-muted">
                    <span className="font-semibold [overflow-wrap:anywhere] text-text">{email.trim().toLowerCase()}</span>
                  </p>
                  {challenge?.delivery === 'uncertain' && (
                    <p className="mt-2 text-sm text-muted">{locale === 'bn' ? 'মেইল পৌঁছেছে কি না নিশ্চিত হওয়া যায়নি। কোড পেলে এখানে দিন, না পেলে আবার পাঠান।' : 'Delivery could not be confirmed. Enter the code if it arrives, or resend it.'}</p>
                  )}
                  <div className="mt-7">
                    <OtpInput value={code} onChange={(v) => { setCode(v); setCodeInvalid(false); }} onComplete={verify} disabled={busy} invalid={codeInvalid} label={t.auth.codeLabel} />
                  </div>
                  <div className="mt-4 min-h-6" aria-live="polite">
                    {busy ? (
                      <p className="flex items-center gap-2 text-sm font-medium text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />{t.auth.verifying}</p>
                    ) : error ? (
                      <p role="alert" className="text-sm font-medium text-danger">{error}</p>
                    ) : null}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <button
                      type="button"
                      disabled={resendLeft > 0 || busy}
                      onClick={() => void requestCode()}
                      className="text-sm font-semibold text-brand transition-opacity disabled:cursor-default disabled:text-subtle"
                    >
                      {resendLeft > 0 ? format(t.auth.resendIn, { s: resendLeft }) : t.auth.resend}
                    </button>
                  </div>
                </motion.div>
              )}

              {step === 'profile' && (
                <ProfileStep
                  key="profile"
                  name={name}
                  setName={setName}
                  username={username}
                  setUsername={setUsername}
                  onSubmit={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const result = await api<OtpVerified>('/auth/signup', {
                        method: 'POST',
                        body: { signupToken, username: username.trim().toLowerCase(), displayName: name.trim(), locale, device: browserDevice() },
                      });
                      if (result.status === 'signed_in') finish(result);
                    } catch (err) {
                      if (err instanceof ApiError && err.code === 'otp_expired') setStep('email');
                      setError(message(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  busy={busy}
                  error={error}
                />
              )}

              {step === 'done' && (
                <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center py-10 text-center">
                  <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }} className="bg-brand-gradient inline-flex size-20 items-center justify-center rounded-full text-on-brand shadow-float">
                    <CheckCircle2 className="size-10" aria-hidden />
                  </motion.span>
                  <h1 className="mt-6 text-2xl font-extrabold">{t.auth.successTitle}</h1>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  const index = { email: 0, code: 1, profile: 2, done: 3 }[step];
  return (
    <div className="flex gap-1.5" aria-hidden>
      {[0, 1, 2].map((part) => (
        <div key={part} className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
          <motion.div className="bg-brand-gradient h-full rounded-full" initial={false} animate={{ width: index >= part ? '100%' : '0%' }} transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }} />
        </div>
      ))}
    </div>
  );
}

function StepIcon({ icon }: { icon: React.ReactNode }) {
  return <span className="inline-flex size-13 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon}</span>;
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-ml-2 inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-text">
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </button>
  );
}

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid';

function ProfileStep({
  name,
  setName,
  username,
  setUsername,
  onSubmit,
  busy,
  error,
}: {
  name: string;
  setName: (value: string) => void;
  username: string;
  setUsername: (value: string) => void;
  onSubmit: () => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const [availability, setAvailability] = useState<Availability>('idle');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Suggest a username from the name until the person types their own.
  const [edited, setEdited] = useState(false);
  const suggested = useMemo(() => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 24), [name]);
  useEffect(() => {
    if (!edited && suggested.length >= 3) setUsername(suggested);
  }, [suggested, edited, setUsername]);

  useEffect(() => {
    const value = username.trim().toLowerCase();
    if (!value) {
      setAvailability('idle');
      setUsernameError(null);
      return;
    }
    const parsed = usernameRule.safeParse(value);
    if (!parsed.success) {
      setAvailability('invalid');
      setUsernameError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setUsernameError(null);
    setAvailability('checking');
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const result = await api<{ available: boolean; reason: 'taken' | 'reserved' | null }>(`/users/username-available?username=${encodeURIComponent(value)}`);
        if (id === requestId.current) setAvailability(result.available ? 'available' : (result.reason ?? 'taken'));
      } catch {
        if (id === requestId.current) setAvailability('idle');
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [username]);

  const status =
    availability === 'checking' ? (
      <Loader2 className="size-4 animate-spin text-subtle" aria-label={t.auth.usernameChecking} />
    ) : availability === 'available' ? (
      <CheckCircle2 className="size-5 text-success" aria-label={t.auth.usernameAvailable} />
    ) : availability === 'taken' || availability === 'reserved' ? (
      <XCircle className="size-5 text-danger" aria-label={t.auth.usernameTaken} />
    ) : null;

  const usernameMessage = usernameError ?? (availability === 'taken' ? t.auth.usernameTaken : availability === 'reserved' ? t.auth.usernameReserved : null);

  return (
    <motion.form
      {...slide}
      className="mt-7"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const parsedName = displayNameRule.safeParse(name);
        if (!parsedName.success) return setNameError(parsedName.error.issues[0]?.message ?? null);
        if (availability !== 'available') return;
        void onSubmit();
      }}
    >
      <StepIcon icon={<User className="size-6" />} />
      <h1 className="mt-5 text-2xl font-extrabold tracking-tight">{t.auth.profileTitle}</h1>
      <div className="mt-7 space-y-5">
        <TextField
          label={t.auth.nameLabel}
          autoComplete="name"
          autoFocus
          maxLength={64}
          placeholder={t.auth.namePlaceholder}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          error={nameError}
          leading={<User className="size-[1.1rem]" />}
        />
        <TextField
          label={t.auth.usernameLabel}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          value={username}
          onChange={(event) => {
            setEdited(true);
            setUsername(event.target.value.toLowerCase().replace(/\s/g, ''));
          }}
          error={usernameMessage}
          hint={availability === 'available' ? <span className="font-semibold text-success">{t.auth.usernameAvailable}</span> : undefined}
          leading={<AtSign className="size-[1.1rem]" />}
          trailing={status}
        />
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" block loading={busy} disabled={availability !== 'available' || !name.trim()} className="mt-7" trailing={<ArrowRight className="size-5" aria-hidden />}>
        {t.auth.create}
      </Button>
    </motion.form>
  );
}
