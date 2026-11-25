'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { MicOff, Hand, Pin } from 'lucide-react';
import { Track, type Participant } from 'livekit-client';
import { Avatar } from '@/components/ui/primitives';

/** One participant: their camera (or screen share), name, mute and speaking state. Falls back to the avatar. */
export function VideoTile({
  participant,
  name,
  avatarName,
  avatarUrl,
  source = Track.Source.Camera,
  mirror,
  className,
  compact,
  hand,
  pinned,
  onPin,
  fit = 'cover',
}: {
  participant: Participant;
  name: string;
  /** Name used for the avatar initials when it differs from the label (e.g. "You"). */
  avatarName?: string;
  avatarUrl?: string | null;
  source?: Track.Source;
  mirror?: boolean;
  className?: string;
  compact?: boolean;
  hand?: boolean;
  pinned?: boolean;
  onPin?: () => void;
  fit?: 'cover' | 'contain';
}) {
  const video = useRef<HTMLVideoElement>(null);
  const publication = participant.getTrackPublication(source);
  const track = publication?.track;
  const visible = !!track && !publication?.isMuted;

  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  const micMuted = !participant.isMicrophoneEnabled;
  return (
    <div
      className={clsx(
        'group relative overflow-hidden rounded-2xl bg-[#1a1d2e] transition-shadow duration-200',
        participant.isSpeaking && source === Track.Source.Camera && 'ring-[3px] ring-emerald-400',
        className,
      )}
    >
      <video ref={video} autoPlay playsInline muted={participant.isLocal} className={clsx('absolute inset-0 size-full', fit === 'cover' ? 'object-cover' : 'object-contain', mirror && 'scale-x-[-1]', !visible && 'invisible')} />
      {!visible && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#202442] to-[#141625]">
          <Avatar name={avatarName ?? name} src={avatarUrl} size={compact ? 48 : 88} className={clsx(participant.isSpeaking && 'ring-4 ring-emerald-400/70')} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-3 pt-6 pb-2 text-white">
        {micMuted && source === Track.Source.Camera && <MicOff className="size-3.5 shrink-0 text-red-300" aria-label="Muted" />}
        <span className={clsx('truncate font-semibold drop-shadow', compact ? 'text-xs' : 'text-sm')}>{name}</span>
      </div>
      {hand && (
        <span className="absolute top-2 left-2 inline-flex size-8 animate-bounce items-center justify-center rounded-full bg-amber-400 text-black shadow" aria-label="Hand raised">
          <Hand className="size-4" />
        </span>
      )}
      {onPin && (
        <button onClick={onPin} aria-label={pinned ? 'Unpin' : 'Pin'} className={clsx('absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-full bg-black/50 text-white transition-opacity', pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')}>
          <Pin className={clsx('size-4', pinned && 'fill-white')} />
        </button>
      )}
    </div>
  );
}
