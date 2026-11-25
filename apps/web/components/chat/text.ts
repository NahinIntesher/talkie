import type { SystemEvent, WireMessage } from '@talkie/contracts';
import type { MessageBody } from '@talkie/e2ee';
import { nameOf, type ChatState } from '@/lib/chat/store';
import { fill, type ChatStrings } from '@/lib/chat/strings';

/** "Missed video call", "Voice call · 4:12". */
export function callText(event: SystemEvent, mine: boolean, locale: 'bn' | 'en'): string {
  const call = event.call!;
  const video = call.media === 'video';
  const missed = ['missed', 'cancelled', 'busy', 'declined'].includes(call.outcome) && !call.durationSeconds;
  const bn = locale === 'bn';
  const kind = bn ? (video ? 'ভিডিও কল' : 'ভয়েস কল') : video ? 'video call' : 'voice call';
  if (missed && !mine) return bn ? `মিসড ${kind}` : `Missed ${kind}`;
  if (missed) return bn ? `${kind} · কেউ ধরেনি` : `${video ? 'Video' : 'Voice'} call · No answer`;
  const s = call.durationSeconds;
  const length = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return bn ? `${kind} · ${length}` : `${video ? 'Video' : 'Voice'} call · ${length}`;
}

/** Human sentence for a system line, e.g. "You added Rafi and Mim". */
export function systemText(state: ChatState, event: SystemEvent, s: ChatStrings): string {
  if (event.type === 'call' && event.call) return callText(event, event.actorId === state.me?.userId, s.you === 'আপনি' ? 'bn' : 'en');
  const actor = nameOf(state, event.actorId, s.you);
  const targets = (event.targetIds ?? []).map((id) => nameOf(state, id, s.you)).join(', ');
  const key = event.type === 'disappearing_changed' ? (event.value ? 'disappearing_on' : 'disappearing_off') : event.type;
  return fill(s.system[key as keyof ChatStrings['system']] ?? '', { actor, targets, value: String(event.value ?? '') });
}

/** One-line preview of a message for the chat list and reply quotes. */
export function previewText(state: ChatState, message: WireMessage, body: MessageBody | null, s: ChatStrings): string {
  if (message.systemEvent) return systemText(state, message.systemEvent, s);
  if (message.deletedAt) return message.senderId === state.me?.userId ? s.deletedByMe : s.deleted;
  const poll = body?.poll as { question: string } | undefined;
  if (poll) return `📊 ${s.poll}: ${poll.question}`;
  const attachment = (body?.attachments as Array<{ name: string; durationMs?: number }> | undefined)?.[0];
  if (attachment) {
    const icon = { image: '📷', video: '🎥', voice: '🎤', audio: '🎵', document: '📄' }[message.kind as string] ?? '📎';
    const label = { image: s.photo, video: s.video, voice: s.voice, audio: s.audio, document: attachment.name }[message.kind as string] ?? attachment.name;
    if (body?.text) return `${icon} ${body.text.replace(/\s+/g, ' ')}`;
    const seconds = Math.round((attachment.durationMs ?? 0) / 1000);
    return `${icon} ${label}${message.kind === 'voice' && seconds ? ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})` : ''}`;
  }
  if (body?.text) return body.text.replace(/\s+/g, ' ');
  if (!message.sealedKey) return s.notForDevice;
  return '…';
}
