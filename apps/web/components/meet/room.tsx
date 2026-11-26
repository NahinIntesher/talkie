'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import {
  BarChart3,
  Captions,
  Check,
  CircleDot,
  Copy,
  Hand,
  Info,
  LayoutGrid,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MoreVertical,
  PhoneOff,
  Radio,
  Send,
  Shapes,
  ShieldCheck,
  SmilePlus,
  Sparkles,
  ThumbsUp,
  UserCheck,
  UserX,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import { Avatar, Button, Switch } from '@/components/ui/primitives';
import { Dialog, Menu } from '@/components/ui/overlay';
import { VideoTile } from '@/components/call/video-tile';
import { RoomAudio } from '@/components/call/room-audio';
import { useI18n } from '@/lib/i18n';
import { nameOf, useChat } from '@/lib/chat/store';
import { timeOf } from '@/lib/chat/strings';
import * as meet from '@/lib/meet/engine';
import { useMeet, type Layout } from '@/lib/meet/engine';

const REACTIONS = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎'];

const copy = {
  en: {
    people: 'People',
    chat: 'In-call messages',
    activities: 'Activities',
    controls: 'Host controls',
    info: 'Meeting details',
    mic: 'Microphone',
    cam: 'Camera',
    present: 'Present now',
    stopPresent: 'Stop presenting',
    react: 'Send a reaction',
    hand: 'Raise hand',
    lower: 'Lower hand',
    more: 'More options',
    leave: 'Leave call',
    endAll: 'End the call for everyone',
    layout: 'Change layout',
    blur: 'Blur background',
    auto: 'Auto',
    tiled: 'Tiled',
    spotlight: 'Spotlight',
    sidebar: 'Sidebar',
    waiting: 'Waiting to join',
    admit: 'Admit',
    deny: 'Deny',
    admitAll: 'Admit all',
    inMeeting: 'In the meeting',
    host: 'Host',
    cohost: 'Co-host',
    muteAll: 'Mute everyone',
    mute: 'Mute',
    stopVideo: 'Turn off camera',
    remove: 'Remove from the call',
    makeCohost: 'Make co-host',
    removeCohost: 'Remove co-host',
    lowerHand: 'Lower hand',
    you: 'You',
    send: 'Send',
    message: 'Send a message',
    chatOff: 'The host turned off chat',
    polls: 'Polls',
    qa: 'Q&A',
    breakouts: 'Breakout rooms',
    recording: 'Recording',
    streaming: 'Live streaming',
    newPoll: 'Start a poll',
    question: 'Question',
    options: 'Options (one per line)',
    multiple: 'Allow multiple answers',
    launch: 'Launch',
    close: 'End poll',
    voters: '{n} voted',
    ask: 'Ask a question',
    anonymous: 'Ask anonymously',
    answered: 'Answered',
    hide: 'Hide',
    rooms: 'Number of rooms',
    minutes: 'Minutes (optional)',
    openRooms: 'Open rooms',
    closeRooms: 'Close rooms',
    broadcast: 'Message all rooms',
    returnMain: 'Return to main call',
    inRoom: 'You are in {room}',
    startRecording: 'Start recording',
    stopRecording: 'Stop recording',
    startStream: 'Start streaming',
    stopStream: 'Stop streaming',
    rtmp: 'Stream address (RTMP URL with key)',
    recordingNow: 'Recording',
    streamingNow: 'Live',
    hostManagement: 'Host management',
    allowShare: 'Share their screen',
    allowChat: 'Send chat messages',
    allowReactions: 'Send reactions',
    allowUnmute: 'Turn on their microphone',
    allowVideo: 'Turn on their video',
    lock: 'Lock the meeting',
    access: 'Meeting access',
    open: 'Open: anyone with the link',
    trusted: 'Trusted: invited people join, others ask',
    restricted: 'Restricted: invited people only',
    joinInfo: 'Joining info',
    copy: 'Copy joining info',
    copied: 'Copied',
    alone: 'You’re the only one here',
  },
  bn: {
    people: 'অংশগ্রহণকারী',
    chat: 'কলের মেসেজ',
    activities: 'কার্যক্রম',
    controls: 'হোস্ট কন্ট্রোল',
    info: 'মিটিংয়ের তথ্য',
    mic: 'মাইক্রোফোন',
    cam: 'ক্যামেরা',
    present: 'স্ক্রিন শেয়ার',
    stopPresent: 'শেয়ার বন্ধ',
    react: 'রিঅ্যাকশন পাঠান',
    hand: 'হাত তুলুন',
    lower: 'হাত নামান',
    more: 'আরও',
    leave: 'কল ছাড়ুন',
    endAll: 'সবার জন্য কল শেষ করুন',
    layout: 'লেআউট বদলান',
    blur: 'ব্যাকগ্রাউন্ড ঝাপসা',
    auto: 'অটো',
    tiled: 'টাইল',
    spotlight: 'স্পটলাইট',
    sidebar: 'সাইডবার',
    waiting: 'যোগ দেওয়ার অপেক্ষায়',
    admit: 'ঢুকতে দিন',
    deny: 'নাকচ',
    admitAll: 'সবাইকে ঢুকতে দিন',
    inMeeting: 'মিটিংয়ে আছেন',
    host: 'হোস্ট',
    cohost: 'কো-হোস্ট',
    muteAll: 'সবাইকে মিউট',
    mute: 'মিউট',
    stopVideo: 'ক্যামেরা বন্ধ',
    remove: 'কল থেকে সরান',
    makeCohost: 'কো-হোস্ট বানান',
    removeCohost: 'কো-হোস্ট থেকে সরান',
    lowerHand: 'হাত নামান',
    you: 'আপনি',
    send: 'পাঠান',
    message: 'মেসেজ লিখুন',
    chatOff: 'হোস্ট চ্যাট বন্ধ রেখেছেন',
    polls: 'পোল',
    qa: 'প্রশ্নোত্তর',
    breakouts: 'ব্রেকআউট রুম',
    recording: 'রেকর্ডিং',
    streaming: 'লাইভ স্ট্রিমিং',
    newPoll: 'পোল শুরু করুন',
    question: 'প্রশ্ন',
    options: 'বিকল্প (প্রতি লাইনে একটি)',
    multiple: 'একাধিক উত্তর',
    launch: 'চালু করুন',
    close: 'পোল শেষ',
    voters: '{n} জন ভোট দিয়েছেন',
    ask: 'প্রশ্ন করুন',
    anonymous: 'নাম ছাড়া জিজ্ঞেস করুন',
    answered: 'উত্তর দেওয়া হয়েছে',
    hide: 'লুকান',
    rooms: 'রুমের সংখ্যা',
    minutes: 'মিনিট (ঐচ্ছিক)',
    openRooms: 'রুম খুলুন',
    closeRooms: 'রুম বন্ধ করুন',
    broadcast: 'সব রুমে মেসেজ',
    returnMain: 'মূল কলে ফিরুন',
    inRoom: 'আপনি {room}-এ আছেন',
    startRecording: 'রেকর্ডিং শুরু',
    stopRecording: 'রেকর্ডিং বন্ধ',
    startStream: 'স্ট্রিমিং শুরু',
    stopStream: 'স্ট্রিমিং বন্ধ',
    rtmp: 'স্ট্রিম ঠিকানা (RTMP URL ও কী)',
    recordingNow: 'রেকর্ড হচ্ছে',
    streamingNow: 'লাইভ',
    hostManagement: 'হোস্ট ম্যানেজমেন্ট',
    allowShare: 'স্ক্রিন শেয়ার করা',
    allowChat: 'চ্যাট মেসেজ পাঠানো',
    allowReactions: 'রিঅ্যাকশন পাঠানো',
    allowUnmute: 'মাইক্রোফোন চালু করা',
    allowVideo: 'ভিডিও চালু করা',
    lock: 'মিটিং লক করুন',
    access: 'মিটিংয়ে প্রবেশ',
    open: 'খোলা: লিংক আছে এমন যে কেউ',
    trusted: 'বিশ্বস্ত: আমন্ত্রিতরা সরাসরি, অন্যরা অনুরোধ করবে',
    restricted: 'সীমিত: শুধু আমন্ত্রিতরা',
    joinInfo: 'যোগদানের তথ্য',
    copy: 'যোগদানের তথ্য কপি',
    copied: 'কপি হয়েছে',
    alone: 'এখানে শুধু আপনি আছেন',
  },
};

type T = (typeof copy)['en'];

export function MeetingRoom() {
  const { locale } = useI18n();
  const t = copy[locale];
  const state = useMeet();
  const chat = useChat();
  const { room, meeting, panel } = state;
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'd') {
        event.preventDefault();
        void meet.toggleMic();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'e') {
        event.preventDefault();
        void meet.toggleCam();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!room || !meeting) return null;
  const host = meeting.myRole !== 'participant';
  const waiting = state.participants.filter((p) => p.admission === 'waiting').length;
  const hands = new Set(state.participants.filter((p) => p.handRaisedAt).map((p) => p.userId));

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0c14] text-white">
      <RoomAudio room={room} />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {(meeting.recording || state.inBreakout) && (
            <div className="absolute top-3 left-3 z-20 flex gap-2">
              {meeting.recording && (
                <span className="flex items-center gap-1.5 rounded-full bg-red-500/90 px-3 py-1 text-xs font-bold">
                  <CircleDot className="size-3.5 animate-pulse" aria-hidden />
                  {meeting.recording.kind === 'recording' ? t.recordingNow : t.streamingNow}
                </span>
              )}
              {state.inBreakout && (
                <button onClick={() => void meet.returnToMain()} className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold hover:bg-white/25">
                  {t.returnMain}
                </button>
              )}
            </div>
          )}
          <Stage t={t} hands={hands} />
          <Reactions />
        </div>
        <AnimatePresence>{panel && <SidePanel t={t} />}</AnimatePresence>
      </div>

      {/* Bottom bar */}
      <div className="flex shrink-0 items-center gap-3 px-3 py-3 sm:px-5">
        <div className="hidden min-w-0 flex-1 items-center gap-3 text-sm font-medium md:flex">
          <span className="tabular-nums">{new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { hour: 'numeric', minute: '2-digit' }).format(clock)}</span>
          <span className="h-4 w-px bg-white/30" />
          <span className="truncate">{meeting.title || meeting.code}</span>
        </div>
        <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2 md:flex-none">
          <Round label={t.mic} off={!state.micOn} onClick={() => void meet.toggleMic()}>
            {state.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
          </Round>
          <Round label={t.cam} off={!state.camOn} onClick={() => void meet.toggleCam()}>
            {state.camOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
          </Round>
          <Round label={state.screenOn ? t.stopPresent : t.present} on={state.screenOn} onClick={() => void meet.toggleScreen()} className="hidden sm:inline-flex">
            <MonitorUp className="size-5" />
          </Round>
          <ReactionButton t={t} />
          <Round label={state.handRaised ? t.lower : t.hand} on={state.handRaised} onClick={() => void meet.raiseHand()}>
            <Hand className="size-5" />
          </Round>
          <Menu
            label={t.more}
            trigger={(props) => (
              <Round label={t.more} {...props}>
                <MoreVertical className="size-5" />
              </Round>
            )}
            items={[
              { label: t.layout, icon: <LayoutGrid />, onSelect: () => meet.setLayout(nextLayout(state.layout)) },
              { label: `${t.blur}${state.blur ? ' ✓' : ''}`, icon: <Sparkles />, onSelect: () => void meet.toggleBlur() },
              { label: t.present, icon: <MonitorUp />, onSelect: () => void meet.toggleScreen() },
              { label: t.activities, icon: <Shapes />, onSelect: () => meet.setPanel('activities') },
              { label: t.controls, icon: <ShieldCheck />, hidden: !host, onSelect: () => meet.setPanel('controls') },
              { label: t.info, icon: <Info />, onSelect: () => meet.setPanel('info') },
              { label: t.endAll, icon: <PhoneOff />, danger: true, hidden: !host, onSelect: () => void meet.endForAll() },
            ]}
          />
          <button onClick={() => void meet.leave()} aria-label={t.leave} title={t.leave} className="inline-flex h-12 w-16 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600">
            <PhoneOff className="size-5" />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-end gap-1">
          <PanelButton label={t.info} panel="info" className="hidden sm:inline-flex">
            <Info className="size-5" />
          </PanelButton>
          <PanelButton label={t.people} panel="people" badge={host ? waiting : 0} count={room.remoteParticipants.size + 1}>
            <Users className="size-5" />
          </PanelButton>
          <PanelButton label={t.chat} panel="chat" badge={state.unreadChat}>
            <MessageSquare className="size-5" />
          </PanelButton>
          <PanelButton label={t.activities} panel="activities" className="hidden sm:inline-flex">
            <Shapes className="size-5" />
          </PanelButton>
          {host && (
            <PanelButton label={t.controls} panel="controls" className="hidden sm:inline-flex">
              <ShieldCheck className="size-5" />
            </PanelButton>
          )}
        </div>
      </div>

      <AnimatePresence>
        {state.notice && (
          <motion.div role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b0c14] shadow-2xl">
            {state.notice}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Chat avatars need names for everyone in the room */}
      <span className="hidden">{Object.keys(chat.profiles).length}</span>
    </div>
  );
}

const nextLayout = (layout: Layout): Layout => (({ auto: 'tiled', tiled: 'spotlight', spotlight: 'sidebar', sidebar: 'auto' }) as const)[layout];

function Round({ label, onClick, off, on, className, children, ...rest }: { label: string; onClick: () => void; off?: boolean; on?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={off || on}
      className={clsx('inline-flex size-12 items-center justify-center rounded-full transition', off ? 'bg-red-500 hover:bg-red-600' : on ? 'bg-sky-500 text-white' : 'bg-white/12 hover:bg-white/20', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

function PanelButton({ label, panel, badge = 0, count, className, children }: { label: string; panel: meet.Panel; badge?: number; count?: number; className?: string; children: React.ReactNode }) {
  const active = useMeet((s) => s.panel === panel);
  return (
    <button onClick={() => meet.setPanel(panel)} aria-label={label} title={label} aria-pressed={active} className={clsx('relative inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 transition', active ? 'bg-sky-500/25 text-sky-300' : 'hover:bg-white/10', className)}>
      {children}
      {count !== undefined && <span className="hidden text-sm font-semibold sm:inline">{count}</span>}
      {badge > 0 && <span className="absolute -top-0.5 -right-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-400 px-1 text-[0.7rem] font-bold text-[#0b0c14]">{badge}</span>}
    </button>
  );
}

function ReactionButton({ t }: { t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Round label={t.react} on={open} onClick={() => setOpen(!open)}>
        <SmilePlus className="size-5" />
      </Round>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="absolute bottom-full left-1/2 z-30 mb-3 flex -translate-x-1/2 gap-1 rounded-full bg-[#1f2133] p-1.5 shadow-2xl">
            {REACTIONS.map((emoji) => (
              <button key={emoji} onClick={() => meet.sendReaction(emoji)} className="inline-flex size-10 items-center justify-center rounded-full text-2xl transition-transform hover:scale-125 hover:bg-white/10" aria-label={emoji}>
                {emoji}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Reactions() {
  const reactions = useMeet((s) => s.reactions);
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-30 h-2/3 w-40" aria-hidden>
      <AnimatePresence>
        {reactions.map((reaction, index) => (
          <motion.div
            key={reaction.id}
            initial={{ opacity: 0, y: 0, x: (index % 4) * 18 }}
            animate={{ opacity: [0, 1, 1, 0], y: -320 }}
            transition={{ duration: 4, ease: 'easeOut' }}
            className="absolute bottom-0 flex flex-col items-center"
          >
            <span className="text-4xl">{reaction.emoji}</span>
            <span className="mt-1 max-w-28 truncate rounded-full bg-black/50 px-2 py-0.5 text-[0.65rem] font-semibold">{reaction.name}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ───────── Stage ─────────

function Stage({ t, hands }: { t: T; hands: Set<string> }) {
  const { room, layout, pinned, meeting } = useMeet();
  const chat = useChat();
  useMeet((s) => s.version);
  if (!room) return null;
  const everyone: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  const name = (p: Participant) => (p.isLocal ? t.you : p.name || nameOf(chat, p.identity));
  const avatar = (p: Participant) => chat.profiles[p.identity]?.avatarUrl;
  const presenter = everyone.find((p) => p.isScreenShareEnabled);
  const speaker = [...room.activeSpeakers].find((p) => !p.isLocal) ?? everyone[1] ?? everyone[0]!;
  const focus = (pinned && everyone.find((p) => p.identity === pinned)) || (layout === 'spotlight' || layout === 'sidebar' || (layout === 'auto' && everyone.length === 2) ? speaker : null);
  const tile = (p: Participant, extra?: string, compact?: boolean) => (
    <VideoTile key={p.identity} participant={p} name={name(p)} avatarName={p.name || nameOf(chat, p.identity)} avatarUrl={avatar(p)} mirror={p.isLocal} hand={hands.has(p.identity)} pinned={pinned === p.identity} onPin={() => meet.setPinned(p.identity)} className={extra} compact={compact} />
  );

  if (everyone.length === 1 && !presenter)
    return (
      <div className="relative flex flex-1 items-center justify-center p-4">
        {tile(everyone[0]!, 'aspect-video w-full max-w-5xl')}
        <div className="absolute top-6 left-1/2 w-[min(28rem,90%)] -translate-x-1/2 rounded-2xl bg-white p-4 text-[#0b0c14] shadow-2xl">
          <p className="font-bold">{t.alone}</p>
          <button onClick={() => void navigator.clipboard.writeText(`${location.origin}/meet/${meeting?.code}`)} className="mt-3 flex w-full items-center gap-2 rounded-xl bg-[#eef0ff] px-3 py-2 text-left text-sm font-semibold text-[#3730a3]">
            <Copy className="size-4" aria-hidden />
            <span className="truncate">{`${typeof location === 'undefined' ? '' : location.host}/meet/${meeting?.code}`}</span>
          </button>
        </div>
      </div>
    );

  if (presenter || (focus && layout !== 'tiled')) {
    const main = presenter ? (
      <VideoTile participant={presenter} name={`${name(presenter)} · ${t.present}`} source={Track.Source.ScreenShare} fit="contain" className="min-h-0 flex-1" />
    ) : (
      tile(focus!, 'min-h-0 flex-1')
    );
    const rest = everyone.filter((p) => presenter || p !== focus);
    return (
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {main}
        {layout !== 'spotlight' && (
          <div className="scrollbar-thin hidden w-64 flex-col gap-3 overflow-y-auto md:flex">
            {rest.slice(0, 12).map((p) => tile(p, 'aspect-video shrink-0', true))}
          </div>
        )}
      </div>
    );
  }

  const count = everyone.length;
  const columns = count <= 2 ? 'sm:grid-cols-2' : count <= 4 ? 'grid-cols-2' : count <= 9 ? 'grid-cols-2 md:grid-cols-3' : count <= 16 ? 'grid-cols-3 md:grid-cols-4' : 'grid-cols-4 md:grid-cols-5 xl:grid-cols-7';
  return (
    <div className={clsx('grid min-h-0 flex-1 content-center gap-3 overflow-y-auto p-3', columns)}>
      {everyone.slice(0, 49).map((p) => tile(p, 'aspect-video', count > 9))}
    </div>
  );
}

// ───────── Side panels ─────────

function SidePanel({ t }: { t: T }) {
  const panel = useMeet((s) => s.panel)!;
  const titles = { people: t.people, chat: t.chat, activities: t.activities, controls: t.controls, info: t.info };
  return (
    <motion.aside
      initial={{ x: 30, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 30, opacity: 0 }}
      className="absolute inset-y-0 right-0 z-40 m-0 flex w-full flex-col bg-surface text-text sm:relative sm:m-3 sm:mb-0 sm:w-[360px] sm:rounded-3xl"
      aria-label={titles[panel]}
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 className="text-lg font-bold">{titles[panel]}</h2>
        <button onClick={() => meet.setPanel(null)} aria-label="Close" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-surface-2">
          <X className="size-5" />
        </button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {panel === 'people' && <PeoplePanel t={t} />}
        {panel === 'chat' && <ChatPanel t={t} />}
        {panel === 'activities' && <ActivitiesPanel t={t} />}
        {panel === 'controls' && <ControlsPanel t={t} />}
        {panel === 'info' && <InfoPanel t={t} />}
      </div>
    </motion.aside>
  );
}

function PeoplePanel({ t }: { t: T }) {
  const { participants, meeting } = useMeet();
  const chat = useChat();
  const host = meeting?.myRole !== 'participant';
  const waiting = participants.filter((p) => p.admission === 'waiting');
  const present = participants.filter((p) => p.admission === 'admitted');
  const me = chat.me?.userId;
  return (
    <div className="space-y-5">
      {host && waiting.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-muted">
              {t.waiting} · {waiting.length}
            </h3>
            <button onClick={() => void meet.admitAll()} className="text-sm font-semibold text-brand">
              {t.admitAll}
            </button>
          </div>
          {waiting.map((p) => (
            <div key={p.id} className="flex items-center gap-3 py-2">
              <Avatar name={nameOf(chat, p.userId)} src={chat.profiles[p.userId]?.avatarUrl} size={36} />
              <span className="min-w-0 flex-1 truncate font-medium">{nameOf(chat, p.userId)}</span>
              <button onClick={() => void meet.hostAction(p.id, 'deny')} aria-label={t.deny} className="inline-flex size-9 items-center justify-center rounded-full text-danger hover:bg-danger-soft">
                <UserX className="size-4" />
              </button>
              <button onClick={() => void meet.hostAction(p.id, 'admit')} aria-label={t.admit} className="inline-flex size-9 items-center justify-center rounded-full bg-brand-soft text-brand">
                <UserCheck className="size-4" />
              </button>
            </div>
          ))}
        </section>
      )}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-muted">
            {t.inMeeting} · {present.length}
          </h3>
          {host && (
            <button onClick={() => void meet.muteAll()} className="text-sm font-semibold text-brand">
              {t.muteAll}
            </button>
          )}
        </div>
        {present.map((p) => (
          <div key={p.id} className="flex items-center gap-3 py-2">
            <Avatar name={nameOf(chat, p.userId)} src={chat.profiles[p.userId]?.avatarUrl} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{p.userId === me ? t.you : nameOf(chat, p.userId)}</span>
              {p.role !== 'participant' && <span className="text-xs text-subtle">{p.role === 'host' ? t.host : t.cohost}</span>}
            </span>
            {p.handRaisedAt && <Hand className="size-4 text-amber-500" aria-label={t.hand} />}
            {host && p.userId !== me && p.role !== 'host' && (
              <Menu
                label={t.more}
                trigger={(props) => (
                  <button {...props} aria-label={t.more} className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface-2">
                    <MoreVertical className="size-4" />
                  </button>
                )}
                items={[
                  { label: t.mute, icon: <MicOff />, onSelect: () => void meet.hostAction(p.id, 'mute') },
                  { label: t.stopVideo, icon: <VideoOff />, onSelect: () => void meet.hostAction(p.id, 'stop-video') },
                  { label: t.lowerHand, icon: <Hand />, hidden: !p.handRaisedAt, onSelect: () => void meet.hostAction(p.id, 'lower-hand') },
                  { label: p.role === 'cohost' ? t.removeCohost : t.makeCohost, icon: <ShieldCheck />, hidden: meeting?.myRole !== 'host', onSelect: () => void meet.setCohost(p.userId, p.role !== 'cohost') },
                  { label: t.remove, icon: <LogOut />, danger: true, onSelect: () => void meet.hostAction(p.id, 'remove') },
                ]}
              />
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function ChatPanel({ t }: { t: T }) {
  const { locale } = useI18n();
  const { chat: lines, meeting } = useMeet();
  const chat = useChat();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [lines.length]);
  const off = meeting?.controls.hostManagement && !meeting.controls.allowChat && meeting.myRole === 'participant';
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3">
        {lines.map((line) => (
          <div key={line.id}>
            <p className="text-xs">
              <span className="font-bold">{line.userId === chat.me?.userId ? t.you : nameOf(chat, line.userId)}</span>
              <span className="ml-2 text-subtle">{timeOf(line.createdAt, locale)}</span>
            </p>
            <p className="text-sm break-words whitespace-pre-wrap">{line.body}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="sticky bottom-0 mt-3 flex items-center gap-2 bg-surface pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          void meet.sendChat(text.trim());
          setText('');
        }}
      >
        <input value={text} disabled={!!off} onChange={(e) => setText(e.target.value)} placeholder={off ? t.chatOff : t.message} maxLength={2000} className="h-11 flex-1 rounded-full bg-surface-2 px-4 text-sm outline-none focus:ring-1 focus:ring-[var(--ring-field)] disabled:opacity-60" />
        <button type="submit" aria-label={t.send} disabled={!text.trim()} className="inline-flex size-11 items-center justify-center rounded-full text-brand disabled:opacity-40">
          <Send className="size-5" />
        </button>
      </form>
    </div>
  );
}

function ActivitiesPanel({ t }: { t: T }) {
  const [tab, setTab] = useState<'polls' | 'qa' | 'breakouts' | 'recording'>('polls');
  const host = useMeet((s) => s.meeting?.myRole !== 'participant');
  const tabs = [
    { id: 'polls' as const, label: t.polls, icon: BarChart3 },
    { id: 'qa' as const, label: t.qa, icon: Captions },
    ...(host ? [{ id: 'breakouts' as const, label: t.breakouts, icon: LayoutGrid }, { id: 'recording' as const, label: t.recording, icon: Radio }] : []),
  ];
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((item) => (
          <button key={item.id} onClick={() => setTab(item.id)} className={clsx('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold', tab === item.id ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted')}>
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'polls' && <Polls t={t} />}
      {tab === 'qa' && <QA t={t} />}
      {tab === 'breakouts' && <Breakouts t={t} />}
      {tab === 'recording' && <Recording t={t} />}
    </div>
  );
}

function Polls({ t }: { t: T }) {
  const { polls, meeting } = useMeet();
  const host = meeting?.myRole !== 'participant';
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [multiple, setMultiple] = useState(false);
  return (
    <div className="space-y-4">
      {host && (
        <form
          className="space-y-2 rounded-2xl border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const list = options.split('\n').map((o) => o.trim()).filter(Boolean);
            if (!question.trim() || list.length < 2) return;
            void meet.createPoll(question.trim(), list, multiple);
            setQuestion('');
            setOptions('');
          }}
        >
          <p className="text-sm font-bold">{t.newPoll}</p>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t.question} className="h-10 w-full rounded-xl bg-surface-2 px-3 text-sm outline-none focus:ring-1 focus:ring-[var(--ring-field)]" />
          <textarea value={options} onChange={(e) => setOptions(e.target.value)} placeholder={t.options} rows={3} className="w-full resize-none rounded-xl bg-surface-2 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[var(--ring-field)]" />
          <label className="flex items-center justify-between text-sm">
            {t.multiple}
            <Switch checked={multiple} onChange={setMultiple} label={t.multiple} />
          </label>
          <Button size="sm" type="submit" block>
            {t.launch}
          </Button>
        </form>
      )}
      {polls.map((poll) => {
        const total = Math.max(1, poll.options.reduce((sum, o) => sum + (o.votes ?? 0), 0));
        return (
          <div key={poll.id} className="rounded-2xl border border-border p-3">
            <p className="font-bold">{poll.question}</p>
            <div className="mt-2 space-y-2">
              {poll.options.map((option) => {
                const chosen = poll.myVotes.includes(option.id);
                return (
                  <button
                    key={option.id}
                    disabled={poll.status !== 'open'}
                    onClick={() => void meet.votePoll(poll.id, poll.multipleChoice ? (chosen ? poll.myVotes.filter((v) => v !== option.id) : [...poll.myVotes, option.id]) : [option.id])}
                    className={clsx('relative block w-full overflow-hidden rounded-xl border px-3 py-2 text-left text-sm', chosen ? 'border-brand' : 'border-border')}
                  >
                    {option.votes !== null && <span className="absolute inset-y-0 left-0 bg-brand-soft" style={{ width: `${((option.votes ?? 0) / total) * 100}%` }} />}
                    <span className="relative flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        {chosen && <Check className="size-4 text-brand" aria-hidden />}
                        {option.label}
                      </span>
                      {option.votes !== null && <span className="font-semibold">{option.votes}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-subtle">
              <span>{t.voters.replace('{n}', String(poll.totalVoters))}</span>
              {host && poll.status === 'open' && (
                <button onClick={() => void meet.closePoll(poll.id)} className="font-semibold text-brand">
                  {t.close}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QA({ t }: { t: T }) {
  const { questions, meeting } = useMeet();
  const chat = useChat();
  const host = meeting?.myRole !== 'participant';
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  return (
    <div className="space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!body.trim()) return;
          void meet.ask(body.trim(), anonymous);
          setBody('');
        }}
      >
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t.ask} maxLength={500} rows={2} className="w-full resize-none rounded-xl bg-surface-2 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[var(--ring-field)]" />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={anonymous} onChange={setAnonymous} label={t.anonymous} />
            {t.anonymous}
          </label>
          <Button size="sm" type="submit" disabled={!body.trim()}>
            {t.send}
          </Button>
        </div>
      </form>
      {questions.map((q) => (
        <div key={q.id} className={clsx('rounded-2xl border border-border p-3', q.status === 'answered' && 'opacity-60')}>
          <p className="text-xs font-semibold text-subtle">{q.userId ? nameOf(chat, q.userId, t.you) : t.anonymous.replace(/^Ask /, '')}</p>
          <p className="mt-1 text-sm">{q.body}</p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => void meet.upvote(q.id, !q.votedByMe)} aria-pressed={q.votedByMe} className={clsx('flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold', q.votedByMe ? 'bg-brand text-[var(--surface)]' : 'bg-surface-2')}>
              <ThumbsUp className="size-3.5" aria-hidden />
              {q.votes}
            </button>
            {q.status === 'answered' && <span className="text-xs font-semibold text-success">{t.answered}</span>}
            {host && q.status !== 'answered' && (
              <button onClick={() => void meet.markQuestion(q.id, 'answered')} className="ml-auto text-xs font-semibold text-brand">
                {t.answered}
              </button>
            )}
            {host && (
              <button onClick={() => void meet.markQuestion(q.id, 'hidden')} className={clsx('text-xs font-semibold text-muted', q.status === 'answered' && 'ml-auto')}>
                {t.hide}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Breakouts({ t }: { t: T }) {
  const { participants, breakouts } = useMeet();
  const chat = useChat();
  const [rooms, setRooms] = useState(2);
  const [minutes, setMinutes] = useState('');
  const [message, setMessage] = useState('');
  const people = participants.filter((p) => p.admission === 'admitted' && p.role === 'participant');
  const plan = useMemo(() => {
    const groups = Array.from({ length: rooms }, (_, index) => ({ name: `Room ${index + 1}`, participantIds: [] as string[] }));
    people.forEach((person, index) => groups[index % rooms]!.participantIds.push(person.id));
    return groups;
  }, [people, rooms]);
  if (breakouts.length)
    return (
      <div className="space-y-3">
        {breakouts.map((room) => (
          <div key={room.id} className="rounded-2xl border border-border p-3">
            <p className="font-bold">{room.name}</p>
            <p className="mt-1 text-sm text-muted">{room.userIds.map((id) => nameOf(chat, id)).join(', ') || '-'}</p>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (message.trim()) void meet.broadcastToBreakouts(message.trim());
            setMessage('');
          }}
        >
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t.broadcast} className="h-10 flex-1 rounded-xl bg-surface-2 px-3 text-sm outline-none" />
          <Button size="sm" type="submit">
            {t.send}
          </Button>
        </form>
        <Button variant="danger" block onClick={() => void meet.closeBreakouts()}>
          {t.closeRooms}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between text-sm font-semibold">
        {t.rooms}
        <input type="number" min={1} max={20} value={rooms} onChange={(e) => setRooms(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className="h-10 w-20 rounded-xl bg-surface-2 px-3 text-center" />
      </label>
      <label className="flex items-center justify-between text-sm font-semibold">
        {t.minutes}
        <input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="h-10 w-20 rounded-xl bg-surface-2 px-3 text-center" />
      </label>
      {plan.map((room) => (
        <div key={room.name} className="rounded-2xl border border-border p-3 text-sm">
          <p className="font-bold">{room.name}</p>
          <p className="text-muted">{room.participantIds.map((id) => nameOf(chat, participants.find((p) => p.id === id)!.userId)).join(', ') || '-'}</p>
        </div>
      ))}
      <Button block disabled={!people.length} onClick={() => void meet.openBreakouts(plan, minutes ? Number(minutes) : null)}>
        {t.openRooms}
      </Button>
    </div>
  );
}

function Recording({ t }: { t: T }) {
  const meeting = useMeet((s) => s.meeting)!;
  const [rtmp, setRtmp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (job: Promise<unknown>) => job.then(() => setError(null)).catch((err: Error) => setError(err.message));
  const recording = meeting.recording?.kind === 'recording';
  const streaming = meeting.recording?.kind === 'stream';
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border p-3">
        <p className="font-bold">{t.recording}</p>
        <Button className="mt-2" size="sm" variant={recording ? 'danger' : 'primary'} onClick={() => void run(recording ? meet.stopRecording('recording') : meet.startRecording('recording'))}>
          {recording ? t.stopRecording : t.startRecording}
        </Button>
      </div>
      <div className="space-y-2 rounded-2xl border border-border p-3">
        <p className="font-bold">{t.streaming}</p>
        {!streaming && <input value={rtmp} onChange={(e) => setRtmp(e.target.value)} placeholder={t.rtmp} className="h-10 w-full rounded-xl bg-surface-2 px-3 text-sm outline-none" />}
        <Button size="sm" variant={streaming ? 'danger' : 'primary'} disabled={!streaming && !rtmp.trim()} onClick={() => void run(streaming ? meet.stopRecording('stream') : meet.startRecording('stream', rtmp.trim()))}>
          {streaming ? t.stopStream : t.startStream}
        </Button>
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

function ControlsPanel({ t }: { t: T }) {
  const meeting = useMeet((s) => s.meeting)!;
  const c = meeting.controls;
  const row = (label: string, value: boolean, onChange: (value: boolean) => void, disabled = false) => (
    <div className={clsx('flex items-start justify-between gap-4 py-2.5', disabled && 'opacity-50')}>
      <span className="text-sm font-semibold">{label}</span>
      <Switch checked={value} onChange={(v) => !disabled && onChange(v)} label={label} />
    </div>
  );
  return (
    <div className="divide-y divide-border">
      {row(t.hostManagement, c.hostManagement, (v) => void meet.updateControls({ hostManagement: v }))}
      <div className="py-2">
        {row(t.allowShare, c.allowScreenShare, (v) => void meet.updateControls({ allowScreenShare: v }), !c.hostManagement)}
        {row(t.allowChat, c.allowChat, (v) => void meet.updateControls({ allowChat: v }), !c.hostManagement)}
        {row(t.allowReactions, c.allowReactions, (v) => void meet.updateControls({ allowReactions: v }), !c.hostManagement)}
        {row(t.allowUnmute, c.allowUnmute, (v) => void meet.updateControls({ allowUnmute: v }), !c.hostManagement)}
        {row(t.allowVideo, c.allowVideo, (v) => void meet.updateControls({ allowVideo: v }), !c.hostManagement)}
      </div>
      {row(t.lock, c.locked, (v) => void meet.updateControls({ locked: v }))}
      <fieldset className="space-y-2 py-3">
        <legend className="mb-2 text-sm font-semibold">{t.access}</legend>
        {(['open', 'trusted', 'restricted'] as const).map((value) => (
          <label key={value} className={clsx('flex cursor-pointer items-center gap-3 rounded-xl border p-2.5 text-sm', meeting.access === value ? 'border-brand bg-brand-soft' : 'border-border')}>
            <input type="radio" checked={meeting.access === value} onChange={() => void meet.updateAccess(value)} className="accent-[var(--brand)]" />
            {t[value]}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function InfoPanel({ t }: { t: T }) {
  const meeting = useMeet((s) => s.meeting)!;
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/meet/${meeting.code}`;
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-bold">{t.joinInfo}</p>
        <p className="mt-1 text-sm break-all text-muted">{link}</p>
      </div>
      <Button
        variant="secondary"
        leading={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        onClick={() => void navigator.clipboard.writeText(`${meeting.title ? `${meeting.title}\n` : ''}${link}`).then(() => setCopied(true))}
      >
        {copied ? t.copied : t.copy}
      </Button>
    </div>
  );
}

export { Dialog };
