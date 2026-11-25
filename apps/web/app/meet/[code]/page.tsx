'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { Ban, CheckCircle2, Hourglass, Mic, MicOff, Sparkles, Video, VideoOff } from 'lucide-react';
import { Avatar, Button, Logo } from '@/components/ui/primitives';
import { PreferenceControls } from '@/components/ui/preferences';
import { MeetingRoom } from '@/components/meet/room';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { nameOf, useChat } from '@/lib/chat/store';
import { join, loadMeeting, resetMeet, setPreview, useMeet } from '@/lib/meet/engine';

const copy = {
  en: {
    ready: 'Ready to join?',
    host: 'Hosted by {name}',
    inCall: '{n} in the meeting',
    nobody: 'No one else is here yet',
    joinNow: 'Join now',
    ask: 'Ask to join',
    asking: 'Asking to be let in…',
    waitingHint: 'Someone in the meeting will let you in soon.',
    denied: 'You can’t join this meeting',
    deniedHint: 'Someone in the meeting declined your request.',
    removed: 'You were removed from the meeting',
    ended: 'You left the meeting',
    meetingEnded: 'The meeting has ended',
    rejoin: 'Rejoin',
    home: 'Return to home',
    missing: 'Check your meeting code',
    missingHint: 'Make sure you entered the right code in the link.',
    camera: 'Camera',
    microphone: 'Microphone',
    blur: 'Blur background',
    noCamera: 'Camera is off',
    permission: 'Allow Talkie to use your camera and microphone so others can see and hear you.',
  },
  bn: {
    ready: 'যোগ দিতে প্রস্তুত?',
    host: 'হোস্ট: {name}',
    inCall: 'মিটিংয়ে {n} জন আছেন',
    nobody: 'এখনো আর কেউ নেই',
    joinNow: 'এখনই যোগ দিন',
    ask: 'যোগ দেওয়ার অনুরোধ',
    asking: 'ঢোকার অনুমতি চাওয়া হচ্ছে…',
    waitingHint: 'মিটিংয়ের কেউ শীঘ্রই আপনাকে ঢুকতে দেবেন।',
    denied: 'আপনি এই মিটিংয়ে যোগ দিতে পারবেন না',
    deniedHint: 'মিটিংয়ের কেউ আপনার অনুরোধ নাকচ করেছেন।',
    removed: 'আপনাকে মিটিং থেকে সরানো হয়েছে',
    ended: 'আপনি মিটিং থেকে বেরিয়েছেন',
    meetingEnded: 'মিটিং শেষ হয়েছে',
    rejoin: 'আবার যোগ দিন',
    home: 'হোমে ফিরুন',
    missing: 'মিটিং কোডটি দেখুন',
    missingHint: 'লিংকে সঠিক কোড লেখা হয়েছে কিনা নিশ্চিত করুন।',
    camera: 'ক্যামেরা',
    microphone: 'মাইক্রোফোন',
    blur: 'ব্যাকগ্রাউন্ড ঝাপসা',
    noCamera: 'ক্যামেরা বন্ধ',
    permission: 'অন্যরা যেন আপনাকে দেখতে ও শুনতে পায়, তাই ক্যামেরা ও মাইক্রোফোনের অনুমতি দিন।',
  },
};

export default function MeetingPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { status } = useSession();
  const router = useRouter();
  const phase = useMeet((s) => s.phase);

  useEffect(() => {
    if (status === 'signed_out') router.replace(`/signin?next=${encodeURIComponent(`/meet/${code}`)}`);
    if (status === 'signed_in') void loadMeeting(code);
    return () => resetMeet();
  }, [status, code, router]);

  if (phase === 'in') return <MeetingRoom />;
  return (
    <div className="ambient flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/app/meet" aria-label="Talkie">
          <Logo />
        </Link>
        <PreferenceControls />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-10">{phase === 'lobby' || phase === 'joining' ? <Lobby /> : <Status />}</main>
    </div>
  );
}

function Lobby() {
  const { locale } = useI18n();
  const t = copy[locale];
  const { user } = useSession();
  const chat = useChat();
  const { meeting, phase, error } = useMeet();
  const video = useRef<HTMLVideoElement>(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [blur, setBlur] = useState(false);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevice, setVideoDevice] = useState<string>('');
  const [audioDevice, setAudioDevice] = useState<string>('');
  const [denied, setDenied] = useState(false);

  // Live preview of camera and microphone level before joining.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let context: AudioContext | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cam ? { deviceId: videoDevice || undefined, width: 1280, height: 720 } : false,
          audio: { deviceId: audioDevice || undefined, echoCancellation: true, noiseSuppression: true },
        });
        setDenied(false);
        setDevices(await navigator.mediaDevices.enumerateDevices());
        if (video.current) video.current.srcObject = cam ? stream : null;
        setPreview({ video: stream.getVideoTracks()[0], audio: stream.getAudioTracks()[0] });
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
          setLevel(peak);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setDenied(true);
      }
    })();
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [cam, videoDevice, audioDevice]);

  if (!meeting) return null;
  const direct = meeting.myRole !== 'participant' || (meeting.access === 'open' && !meeting.controls.locked);
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const microphones = devices.filter((d) => d.kind === 'audioinput');
  return (
    <div className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[1.4fr_1fr]">
      <div>
        <div className="relative aspect-video overflow-hidden rounded-[1.75rem] bg-[#11131f] shadow-float">
          <video ref={video} autoPlay playsInline muted className={clsx('absolute inset-0 size-full scale-x-[-1] object-cover', (!cam || denied) && 'invisible', blur && 'blur-[1px]')} />
          {(!cam || denied) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80">
              <Avatar name={user?.displayName ?? ''} src={user?.avatarUrl} size={96} />
              <p className="text-sm">{denied ? t.permission : t.noCamera}</p>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/60 to-transparent p-4 pt-10">
            <button onClick={() => setMic(!mic)} aria-label={t.microphone} aria-pressed={!mic} className={clsx('inline-flex size-13 items-center justify-center rounded-full border transition', mic ? 'border-white/40 text-white hover:bg-white/10' : 'border-red-500 bg-red-500 text-white')}>
              {mic ? <Mic className="size-5" /> : <MicOff className="size-5" />}
            </button>
            <button onClick={() => setCam(!cam)} aria-label={t.camera} aria-pressed={!cam} className={clsx('inline-flex size-13 items-center justify-center rounded-full border transition', cam ? 'border-white/40 text-white hover:bg-white/10' : 'border-red-500 bg-red-500 text-white')}>
              {cam ? <Video className="size-5" /> : <VideoOff className="size-5" />}
            </button>
            <button onClick={() => setBlur(!blur)} aria-label={t.blur} aria-pressed={blur} className={clsx('inline-flex size-13 items-center justify-center rounded-full border transition', blur ? 'border-sky-400 bg-sky-500 text-white' : 'border-white/40 text-white hover:bg-white/10')}>
              <Sparkles className="size-5" />
            </button>
          </div>
          {mic && !denied && (
            <div className="absolute bottom-5 left-5 flex h-6 items-end gap-0.5" aria-hidden>
              {[0.2, 0.5, 0.8].map((threshold, index) => (
                <span key={index} className={clsx('w-1.5 rounded-full transition-all duration-75', level > threshold * 0.4 ? 'bg-emerald-400' : 'bg-white/30')} style={{ height: `${8 + index * 6}px` }} />
              ))}
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <select aria-label={t.microphone} value={audioDevice} onChange={(e) => setAudioDevice(e.target.value)} className="h-11 rounded-xl border border-border bg-surface px-3 text-sm">
            {!microphones.length && <option value="">🎙 {t.microphone}</option>}
            {microphones.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                🎙 {d.label || t.microphone}
              </option>
            ))}
          </select>
          <select aria-label={t.camera} value={videoDevice} onChange={(e) => setVideoDevice(e.target.value)} className="h-11 rounded-xl border border-border bg-surface px-3 text-sm">
            {!cameras.length && <option value="">📷 {t.camera}</option>}
            {cameras.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                📷 {d.label || t.camera}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="text-center lg:text-left">
        <h1 className="text-3xl font-extrabold tracking-tight">{meeting.title || t.ready}</h1>
        <p className="mt-2 text-muted">{t.host.replace('{name}', nameOf(chat, meeting.hostId, locale === 'bn' ? 'আপনি' : 'You'))}</p>
        <p className="mt-1 text-sm text-subtle">{meeting.participantCount ? t.inCall.replace('{n}', String(meeting.participantCount)) : t.nobody}</p>
        {error && <p role="alert" className="mt-4 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">{error}</p>}
        <Button size="lg" className="mt-6 min-w-48" loading={phase === 'joining'} onClick={() => void join({ mic, cam, blur, videoDevice: videoDevice || undefined, audioDevice: audioDevice || undefined })}>
          {direct ? t.joinNow : t.ask}
        </Button>
        <p className="mt-4 font-mono text-sm text-subtle">{meeting.code}</p>
      </div>
    </div>
  );
}

function Status() {
  const { locale } = useI18n();
  const t = copy[locale];
  const { phase, code } = useMeet();
  const content = {
    loading: { icon: null, title: '', hint: '' },
    waiting: { icon: <Hourglass className="size-10" />, title: t.asking, hint: t.waitingHint },
    denied: { icon: <Ban className="size-10" />, title: t.denied, hint: t.deniedHint },
    removed: { icon: <Ban className="size-10" />, title: t.removed, hint: '' },
    ended: { icon: <CheckCircle2 className="size-10" />, title: t.ended, hint: '' },
    missing: { icon: <Ban className="size-10" />, title: t.missing, hint: t.missingHint },
  }[phase as 'loading' | 'waiting' | 'denied' | 'removed' | 'ended' | 'missing'] ?? { icon: null, title: '', hint: '' };
  if (phase === 'loading') return <div className="size-10 animate-spin rounded-full border-4 border-brand/25 border-t-brand" aria-label="Loading" />;
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-md text-center">
      <span className={clsx('mx-auto inline-flex size-24 items-center justify-center rounded-[2rem]', phase === 'waiting' ? 'bg-brand-soft text-brand' : phase === 'ended' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger')}>
        {phase === 'waiting' ? (
          <motion.span animate={{ rotate: [0, 180, 180, 360] }} transition={{ repeat: Infinity, duration: 2.4 }}>
            {content.icon}
          </motion.span>
        ) : (
          content.icon
        )}
      </span>
      <h1 className="mt-6 text-2xl font-extrabold">{content.title}</h1>
      {content.hint && <p className="mt-2 text-muted">{content.hint}</p>}
      <div className="mt-8 flex justify-center gap-3">
        {(phase === 'ended' || phase === 'removed') && phase === 'ended' && (
          <Button onClick={() => void loadMeeting(code)} variant="outline">
            {t.rejoin}
          </Button>
        )}
        <Link href="/app/meet">
          <Button>{t.home}</Button>
        </Link>
      </div>
    </motion.div>
  );
}
