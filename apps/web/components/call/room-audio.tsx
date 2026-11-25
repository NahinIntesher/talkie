'use client';

import { useEffect, useRef } from 'react';
import { RoomEvent, Track, type RemoteTrack, type Room } from 'livekit-client';

/**
 * Plays every other participant's audio (microphone and screen-share sound). Video tiles only render
 * pictures; without this nobody would be heard.
 */
export function RoomAudio({ room }: { room: Room | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!room || !box.current) return;
    const container = box.current;
    const elements = new Map<string, HTMLMediaElement>();
    const attach = (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio || elements.has(track.sid!)) return;
      const element = track.attach();
      element.setAttribute('data-talkie-audio', track.source);
      container.appendChild(element);
      elements.set(track.sid!, element);
    };
    const detach = (track: RemoteTrack) => {
      const element = elements.get(track.sid!);
      if (!element) return;
      track.detach(element);
      element.remove();
      elements.delete(track.sid!);
    };
    for (const participant of room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track as RemoteTrack);
    room.on(RoomEvent.TrackSubscribed, attach).on(RoomEvent.TrackUnsubscribed, detach);
    // Browsers may block sound until the page is touched; resume on the first interaction.
    const resume = () => void room.startAudio();
    document.addEventListener('pointerdown', resume, { once: true });
    return () => {
      room.off(RoomEvent.TrackSubscribed, attach).off(RoomEvent.TrackUnsubscribed, detach);
      document.removeEventListener('pointerdown', resume);
      for (const element of elements.values()) element.remove();
      elements.clear();
    };
  }, [room]);
  return <div ref={box} hidden aria-hidden />;
}
