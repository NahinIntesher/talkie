'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { Lock, Maximize2, Mic, MicOff, Minimize2, MonitorUp, Phone, PhoneOff, PictureInPicture2, RefreshCcw, Video, VideoOff } from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import type { CallInfo } from '@talkie/contracts';
import { Avatar } from '@/components/ui/primitives';
import { useI18n } from '@/lib/i18n';
import { nameOf, useChat } from '@/lib/chat/store';
import { accept, decline, hangUp, setMinimized, switchCamera, toggleCamera, toggleMic, toggleScreen, useCall } from '@/lib/call/engine';
import { VideoTile } from './video-tile';
import { RoomAudio } from './room-audio';
import { leaveRecoverable, resumeCall } from '@/lib/call/engine';
import { useToast } from '@/components/ui/toast';

const copy = {
  en: {
    incomingVideo: 'Incoming video call',
    incomingVoice: 'Incoming voice call',
    groupCall: 'Group call',
    calling: 'Calling…',
    ringing: 'Ringing…',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    encrypted: 'End-to-end encrypted',
    accept: 'Accept',
    acceptVoice: 'Accept as voice',
    decline: 'Decline',
    end: 'End call',
    mute: 'Mute',
    unmute: 'Unmute',
    cameraOn: 'Turn on camera',
    cameraOff: 'Turn off camera',
    share: 'Share screen',
    stopShare: 'Stop sharing',
    flip: 'Switch camera',
    minimize: 'Minimize',
    expand: 'Expand',
    ended: { ended: 'Call ended', declined: 'Call declined', busy: 'On another call', missed: 'No answer', cancelled: 'Call ended', disconnected: 'Call ended', failed: 'Call failed' } as Record<string, string>,
  },
  bn: {
    incomingVideo: 'ভিডিও কল আসছে',
    incomingVoice: 'ভয়েস কল আসছে',
    groupCall: 'গ্রুপ কল',
    calling: 'কল করা হচ্ছে…',
    ringing: 'রিং হচ্ছে…',
    connecting: 'সংযোগ হচ্ছে…',
    reconnecting: 'আবার সংযোগ হচ্ছে…',
    encrypted: 'এন্ড-টু-এন্ড এনক্রিপ্টেড',
    accept: 'ধরুন',
    acceptVoice: 'ভয়েসে ধরুন',
    decline: 'কাটুন',
    end: 'কল শেষ করুন',
    mute: 'মিউট',
    unmute: 'আনমিউট',
    cameraOn: 'ক্যামেরা চালু',
    cameraOff: 'ক্যামেরা বন্ধ',
    share: 'স্ক্রিন শেয়ার',
    stopShare: 'শেয়ার বন্ধ',
    flip: 'ক্যামেরা বদলান',
    minimize: 'ছোট করুন',
    expand: 'বড় করুন',
    ended: { ended: 'কল শেষ', declined: 'কল কেটে দিয়েছেন', busy: 'অন্য কলে আছেন', missed: 'কেউ ধরেনি', cancelled: 'কল শেষ', disconnected: 'কল শেষ', failed: 'কল ব্যর্থ' } as Record<string, string>,
  },
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function CallOverlay() {
  const { session, incoming, recoverable } = useCall();
  const { locale } = useI18n();
  const toast = useToast();
  const expandedId = session && !session.minimized && session.phase !== 'ended' ? session.info.id : null;
  useEffect(() => {
    if (!expandedId) return;
    if (history.state?.talkieCall !== expandedId) history.pushState({ ...history.state, talkieCall: expandedId }, '');
    const back = () => setMinimized(true);
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back);
      if (history.state?.talkieCall === expandedId) history.back();
    };
  }, [expandedId]);
  return (
    <>
      <RoomAudio room={session?.room ?? null} />
      {recoverable && !session && !incoming && <aside className="fixed inset-x-3 top-3 z-[110] mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-emerald-950 p-4 text-white shadow-lg">
        <Phone className="size-5" />
        <button className="flex-1 text-left font-semibold" onClick={() => void resumeCall().then(error => error && toast(error, 'error'))}>{locale === 'bn' ? 'চলমান কলে ফিরুন' : 'Rejoin ongoing call'}</button>
        <button aria-label={copy[locale].end} onClick={() => void leaveRecoverable().catch(() => toast(copy[locale].ended.failed!, 'error'))}><PhoneOff className="size-5" /></button>
      </aside>}
      <AnimatePresence>{incoming && !session && <IncomingCall key={incoming.id} incoming={incoming} />}</AnimatePresence>
      <AnimatePresence>{session && <ActiveCall key={session.info.id} />}</AnimatePresence>
    </>
  );
}

function IncomingCall({ incoming }: { incoming: CallInfo }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const chat = useChat();
  const conversation = incoming.conversationId ? chat.conversations[incoming.conversationId] : undefined;
  const caller = nameOf(chat, incoming.initiatorId);
  const group = conversation?.group;
  return (
    <motion.div
      role="alertdialog"
      aria-label={incoming.media === 'video' ? t.incomingVideo : t.incomingVoice}
      initial={{ opacity: 0, y: -30, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.96 }}
      className="fixed inset-x-3 top-3 z-[120] mx-auto max-w-md overflow-hidden rounded-[1.75rem] bg-[#0e1022]/95 p-5 text-white shadow-[0_30px_80px_-20px_rgba(0,0,0,.7)] backdrop-blur-xl sm:top-6"
    >
      <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-amber-500/30 blur-3xl" />
      <div className="relative flex items-center gap-4">
        <span className="relative">
          <motion.span className="absolute inset-0 rounded-full bg-emerald-400/40" animate={{ scale: [1, 1.5], opacity: [0.6, 0] }} transition={{ repeat: Infinity, duration: 1.4 }} />
          <Avatar name={group?.name ?? caller} src={group?.avatarUrl ?? chat.profiles[incoming.initiatorId]?.avatarUrl} size={60} className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{group ? group.name : caller}</p>
          <p className="text-sm text-white/70">
            {group ? `${caller} · ${t.groupCall}` : incoming.media === 'video' ? t.incomingVideo : t.incomingVoice}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-white/50">
            <Lock className="size-3" aria-hidden />
            {t.encrypted}
          </p>
        </div>
      </div>
      <div className="relative mt-5 flex items-center justify-between gap-3">
        <button onClick={() => void decline()} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-red-500 py-3 font-semibold transition hover:bg-red-600">
          <PhoneOff className="size-5" />
          {t.decline}
        </button>
        {incoming.media === 'video' && (
          <button onClick={() => void accept('audio')} aria-label={t.acceptVoice} title={t.acceptVoice} className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 transition hover:bg-white/20">
            <Phone className="size-5" />
          </button>
        )}
        <motion.button
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 1.2 }}
          onClick={() => void accept(incoming.media)}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-3 font-semibold transition hover:bg-emerald-600"
        >
          {incoming.media === 'video' ? <Video className="size-5" /> : <Phone className="size-5" />}
          {t.accept}
        </motion.button>
      </div>
    </motion.div>
  );
}

/** The current call, or the last one while its screen animates away after the call ended. */
function useLastSession() {
  const live = useCall((s) => s.session);
  const last = useRef(live);
  if (live) last.current = live;
  return last.current!;
}

function useElapsed(since: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? now - new Date(since).getTime() : 0;
}

function ActiveCall() {
  const { locale } = useI18n();
  const t = copy[locale];
  const chat = useChat();
  const session = useLastSession();
  const { info, room, phase } = session;
  const stage = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(phase === 'active' ? info.answeredAt ?? info.createdAt : null);
  const me = chat.me?.userId;
  const conversation = info.conversationId ? chat.conversations[info.conversationId] : undefined;
  const others = info.participants.filter((p) => p.userId !== me);
  const title = conversation?.group?.name ?? nameOf(chat, others[0]?.userId ?? info.initiatorId);
  const remotes: Participant[] = room ? [...room.remoteParticipants.values()] : [];
  const local = room?.localParticipant;
  const isGroup = !!conversation?.group;
  const screen = [...remotes, ...(local ? [local] : [])].find((p) => p.isScreenShareEnabled);
  const status =
    phase === 'ended'
      ? t.ended[session.endReason ?? 'ended'] ?? t.ended.ended
      : phase === 'reconnecting'
        ? t.reconnecting
        : phase === 'outgoing'
          ? remotes.length || others.some((p) => p.state === 'joined')
            ? t.connecting
            : others.some((p) => p.state === 'ringing')
              ? t.ringing
              : t.calling
          : phase === 'connecting'
            ? t.connecting
            : clock(elapsed);

  if (session.minimized) return <MiniCall title={title} status={status} />;

  const nameFor = (participant: Participant) => (participant.isLocal ? (locale === 'bn' ? 'আপনি' : 'You') : nameOf(chat, participant.identity));
  const avatarFor = (participant: Participant) => chat.profiles[participant.identity]?.avatarUrl;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className="fixed inset-0 z-[110] flex flex-col bg-[#0a0b14] text-white"
      role="dialog"
      aria-label={title}
    >
      {/* Header */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between bg-gradient-to-b from-black/70 to-transparent p-4 pb-10">
        <div>
          <p className="text-xl font-bold">{title}</p>
          <p className="text-sm text-white/75 tabular-nums">{status}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-white/50">
            <Lock className="size-3" aria-hidden />
            {t.encrypted}
          </p>
        </div>
        <div className="flex gap-2">
          {remotes.some(participant => participant.isCameraEnabled) && typeof document !== 'undefined' && document.pictureInPictureEnabled && (
            <button aria-label={locale === 'bn' ? 'ভাসমান ভিডিও' : 'Picture-in-picture'} title={locale === 'bn' ? 'ভাসমান ভিডিও' : 'Picture-in-picture'}
              onClick={() => {
                const video = Array.from(stage.current?.querySelectorAll('video') ?? []).find(element => element.srcObject && !element.muted && element.readyState > 0);
                if (video) void video.requestPictureInPicture().catch(() => {});
              }} className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"><PictureInPicture2 className="size-5" /></button>
          )}
          <button onClick={() => setMinimized(true)} aria-label={t.minimize} className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
            <Minimize2 className="size-5" />
          </button>
        </div>
      </div>

      {/* Stage */}
      <div ref={stage} className="relative flex-1 overflow-hidden">
        {screen ? (
          <div className="flex h-full gap-3 p-3 pt-24 pb-28">
            <VideoTile participant={screen} name={`${nameFor(screen)} · ${t.share}`} source={Track.Source.ScreenShare} fit="contain" className="flex-1" />
            <div className="hidden w-56 flex-col gap-3 overflow-y-auto md:flex">
              {[...remotes, ...(local ? [local] : [])].map((p) => (
                <VideoTile key={p.identity} participant={p} name={nameFor(p)} avatarUrl={avatarFor(p)} compact mirror={p.isLocal} className="aspect-video shrink-0" />
              ))}
            </div>
          </div>
        ) : !isGroup && remotes.length <= 1 ? (
          <>
            {remotes[0] ? (
              <VideoTile participant={remotes[0]} name={nameFor(remotes[0])} avatarUrl={avatarFor(remotes[0])} className="absolute inset-0 !rounded-none" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <div className="pointer-events-none absolute size-[32rem] rounded-full bg-amber-500/15 blur-3xl" />
                <motion.div animate={phase === 'outgoing' ? { scale: [1, 1.04, 1] } : {}} transition={{ repeat: Infinity, duration: 1.6 }}>
                  <Avatar name={title} src={conversation?.group?.avatarUrl ?? chat.profiles[others[0]?.userId ?? '']?.avatarUrl} size={144} className="shadow-2xl ring-8 ring-white/5" />
                </motion.div>
              </div>
            )}
            {local && session.camOn && <SelfView participant={local} />}
          </>
        ) : (
          <div className={clsx('grid h-full content-center gap-3 p-3 pt-24 pb-28', gridFor(remotes.length + 1))}>
            {[...remotes, ...(local ? [local] : [])].map((p) => (
              <VideoTile key={p.identity} participant={p} name={nameFor(p)} avatarUrl={avatarFor(p)} mirror={p.isLocal} className="aspect-video min-h-0" compact={remotes.length > 3} />
            ))}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/70 to-transparent p-6 pt-12">
        <div className="flex items-center gap-3 rounded-full bg-white/10 p-2 backdrop-blur-xl">
          <Control label={session.micOn ? t.mute : t.unmute} active={!session.micOn} onClick={() => void toggleMic()}>
            {session.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
          </Control>
          <Control label={session.camOn ? t.cameraOff : t.cameraOn} active={!session.camOn} onClick={() => void toggleCamera()}>
            {session.camOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
          </Control>
          {session.camOn && (
            <Control label={t.flip} onClick={() => void switchCamera()} className="sm:hidden">
              <RefreshCcw className="size-5" />
            </Control>
          )}
          <Control label={session.screenOn ? t.stopShare : t.share} highlight={session.screenOn} onClick={() => void toggleScreen()} className="hidden sm:inline-flex">
            <MonitorUp className="size-5" />
          </Control>
          <button onClick={() => void hangUp()} aria-label={t.end} title={t.end} className="inline-flex h-12 w-16 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600">
            <PhoneOff className="size-5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

const gridFor = (count: number) =>
  count <= 1 ? 'grid-cols-1' : count === 2 ? 'grid-cols-1 sm:grid-cols-2' : count <= 4 ? 'grid-cols-2' : count <= 9 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-3 md:grid-cols-4';

function Control({ label, onClick, active, highlight, className, children }: { label: string; onClick: () => void; active?: boolean; highlight?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active || highlight}
      className={clsx('inline-flex size-12 items-center justify-center rounded-full transition', active ? 'bg-white text-[#0a0b14]' : highlight ? 'bg-sky-500 text-white' : 'bg-white/10 hover:bg-white/20', className)}
    >
      {children}
    </button>
  );
}

/** Draggable picture-in-picture of my own camera. */
function SelfView({ participant }: { participant: Participant }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <motion.div ref={box} drag dragMomentum={false} className="absolute right-4 bottom-32 z-10 w-32 cursor-grab overflow-hidden rounded-2xl shadow-2xl ring-2 ring-white/20 active:cursor-grabbing sm:w-48">
      <VideoTile participant={participant} name="" mirror className="aspect-[3/4] sm:aspect-video" compact />
    </motion.div>
  );
}

function MiniCall({ title, status }: { title: string; status: string }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const session = useLastSession();
  const remote = session.room ? [...session.room.remoteParticipants.values()][0] : undefined;
  return (
    <motion.div drag dragMomentum={false} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="fixed right-4 bottom-24 z-[110] w-64 cursor-grab overflow-hidden rounded-3xl bg-[#0e1022] text-white shadow-2xl active:cursor-grabbing md:bottom-6">
      {remote && remote.isCameraEnabled ? <VideoTile participant={remote} name={title} className="aspect-video !rounded-none" compact /> : null}
      <div className="flex items-center gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{title}</p>
          <p className="text-xs text-white/70 tabular-nums">{status}</p>
        </div>
        <button onClick={() => void toggleMic()} aria-label={session.micOn ? t.mute : t.unmute} className={clsx('inline-flex size-9 items-center justify-center rounded-full', session.micOn ? 'bg-white/10' : 'bg-white text-black')}>
          {session.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
        </button>
        <button onClick={() => setMinimized(false)} aria-label={t.expand} className="inline-flex size-9 items-center justify-center rounded-full bg-white/10">
          <Maximize2 className="size-4" />
        </button>
        <button onClick={() => void hangUp()} aria-label={t.end} className="inline-flex size-9 items-center justify-center rounded-full bg-red-500">
          <PhoneOff className="size-4" />
        </button>
      </div>
    </motion.div>
  );
}
