// Phase 4 checks (calls and meetings), run by e2e-chat.ts. The test signs media tokens with a development key;
// no media server is needed because Talkie only decides who may join — LiveKit carries the audio and video.
import { decodeJwt } from 'jose';
import * as e2ee from '@talkie/e2ee';
import type { Person } from './e2e-phase3.ts';

type Call = <T = any>(service: 'auth' | 'users' | 'chat' | 'realtime' | 'media' | 'notify' | 'meet', path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<{ status: number; body: T }>;
type Check = (label: string, ok: boolean, detail?: unknown) => void;
type Live = Person & { events: Array<{ event: string; payload: any }> };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined, ms = 6000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value !== undefined) return value;
    await wait(100);
  }
  return undefined;
}

export async function phase4({ call, check }: { call: Call; check: Check }, people: { ayesha: Live; rafi: Live; mim: Live }, conversationId: string, groupId: string) {
  const { ayesha, rafi, mim } = people;

  // ───── One-to-one call ─────
  const callKey = e2ee.newCallKey();
  const { body: devices } = await call('chat', `/chat/conversations/${conversationId}/devices`, { token: ayesha.token });
  const started = await call('meet', '/meet/calls', { token: ayesha.token, body: { conversationId, media: 'video', keys: e2ee.sealSecret(callKey, ayesha.keys, devices.devices) } });
  check('Ayesha starts a video call', started.status === 201 && started.body.call.state === 'ringing', started.body);
  const callId = started.body.call.id as string;
  const claims = decodeJwt(started.body.grant.token) as { video?: { room: string; roomJoin: boolean }; sub?: string };
  check('caller gets a signed media token for the call room', claims.video?.room === `call-${callId}` && claims.video.roomJoin && claims.sub === ayesha.userId, claims);
  const ring = await until(() => rafi.events.find((e) => e.event === 'call:incoming' && e.payload.callId === callId));
  check('Rafi’s devices ring', !!ring);
  const { body: incoming } = await call('meet', '/meet/calls/incoming', { token: rafi.token });
  const mine = incoming.calls.find((c: { id: string }) => c.id === callId);
  check('the incoming call is listed for an app that just opened', !!mine);
  check('Rafi opens the end-to-end call key', e2ee.openSecret(mine.sealedKey, ayesha.keys.publicKey, rafi.keys) === callKey);
  const outsider = await call('meet', `/meet/calls/${callId}`, { token: mim.token });
  check('outsiders cannot see the call', outsider.status === 404);
  const accepted = await call('meet', `/meet/calls/${callId}/accept`, { token: rafi.token, body: {} });
  check('Rafi answers', accepted.status === 200 && accepted.body.call.state === 'active' && !!accepted.body.grant.token, accepted.body);
  check('Ayesha sees that Rafi joined', !!(await until(() => ayesha.events.find((e) => e.event === 'call:update' && e.payload.change === 'joined'))));
  await wait(1100);
  await call('meet', `/meet/calls/${callId}/leave`, { token: ayesha.token, body: {} });
  check('hanging up ends the call for both', !!(await until(() => rafi.events.find((e) => e.event === 'call:ended' && e.payload.callId === callId && e.payload.outcome === 'ended'))));
  const line = await until(() => rafi.events.find((e) => e.event === 'chat:message' && e.payload.kind === 'call'));
  check('the call appears in the chat', !!line);
  const { body: history } = await call('chat', `/chat/conversations/${conversationId}/messages`, { token: rafi.token });
  const callLine = history.messages.findLast((m: { kind: string }) => m.kind === 'call');
  check('the chat line says how long it lasted', callLine?.systemEvent?.call?.outcome === 'ended' && callLine.systemEvent.call.durationSeconds >= 1, callLine?.systemEvent);

  // Declined and cancelled
  const second = await call('meet', '/meet/calls', { token: ayesha.token, body: { conversationId, media: 'audio', keys: e2ee.sealSecret(e2ee.newCallKey(), ayesha.keys, devices.devices) } });
  await call('meet', `/meet/calls/${second.body.call.id}/decline`, { token: rafi.token, body: {} });
  const declined = await call('meet', `/meet/calls/${second.body.call.id}`, { token: ayesha.token });
  check('declining ends a ringing one-to-one call', declined.body.call.state === 'declined');
  const third = await call('meet', '/meet/calls', { token: ayesha.token, body: { conversationId, media: 'audio', keys: e2ee.sealSecret(e2ee.newCallKey(), ayesha.keys, devices.devices) } });
  await call('meet', `/meet/calls/${third.body.call.id}/leave`, { token: ayesha.token, body: {} });
  const cancelled = await call('meet', `/meet/calls/${third.body.call.id}`, { token: rafi.token });
  check('hanging up before an answer cancels (Rafi sees a missed call)', cancelled.body.call.state === 'cancelled' && cancelled.body.call.participants.some((p: { userId: string; state: string }) => p.userId === rafi.userId && p.state === 'missed'));
  const { body: log } = await call('meet', '/meet/calls', { token: rafi.token });
  check('call history lists all three calls', log.calls.length >= 3);

  // Busy
  const groupKeys = (await call('chat', `/chat/conversations/${groupId}/devices`, { token: mim.token })).body.devices;
  const groupCall = await call('meet', '/meet/calls', { token: mim.token, body: { conversationId: groupId, media: 'audio', keys: e2ee.sealSecret(e2ee.newCallKey(), mim.keys, groupKeys) } });
  check('group call rings every member', groupCall.status === 201 && groupCall.body.call.participants.length === 3);
  await call('meet', `/meet/calls/${groupCall.body.call.id}/accept`, { token: rafi.token, body: {} });
  const busy = await call('meet', '/meet/calls', { token: ayesha.token, body: { conversationId, media: 'audio', keys: e2ee.sealSecret(e2ee.newCallKey(), ayesha.keys, devices.devices) } });
  check('calling someone who is on another call reports busy', busy.body.call?.state === 'busy', busy.body);
  const joinedLater = await call('meet', `/meet/calls/${groupCall.body.call.id}/join`, { token: ayesha.token, body: {} });
  check('a group member can join an ongoing group call later', joinedLater.status === 200 && joinedLater.body.call.participants.filter((p: { state: string }) => p.state === 'joined').length === 3);
  await call('meet', `/meet/calls/${groupCall.body.call.id}/leave`, { token: rafi.token, body: {} });
  const stillOn = await call('meet', `/meet/calls/${groupCall.body.call.id}`, { token: mim.token });
  check('a group call continues while two people remain', stillOn.body.call.state === 'active');
  await call('meet', `/meet/calls/${groupCall.body.call.id}/leave`, { token: mim.token, body: {} });
  const over = await call('meet', `/meet/calls/${groupCall.body.call.id}`, { token: ayesha.token });
  check('…and ends when only one is left', over.body.call.state === 'ended');

  // ───── Meeting ─────
  const created = await call('meet', '/meet/meetings', { token: ayesha.token, body: { title: 'Sprint review', access: 'trusted', inviteeIds: [rafi.userId] } });
  check('meeting created with a Meet-style code', created.status === 201 && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(created.body.meeting.code), created.body);
  const code = created.body.meeting.code as string;
  const hostJoin = await call('meet', `/meet/meetings/${code}/join`, { token: ayesha.token, body: {} });
  check('host joins and the meeting goes live', hostJoin.body.state === 'admitted' && hostJoin.body.role === 'host');
  const hostClaims = decodeJwt(hostJoin.body.grant.token) as { video?: { roomAdmin?: boolean } };
  check('host token can manage the room', hostClaims.video?.roomAdmin === true);
  const rafiJoin = await call('meet', `/meet/meetings/${code}/join`, { token: rafi.token, body: {} });
  check('an invited person joins directly', rafiJoin.body.state === 'admitted');
  const mimJoin = await call('meet', `/meet/meetings/${code}/join`, { token: mim.token, body: {} });
  check('an uninvited person waits to be let in', mimJoin.body.state === 'waiting');
  check('the host is told someone is asking to join', !!(await until(() => ayesha.events.find((e) => e.event === 'meeting:update' && e.payload.change === 'knock'))));
  const notHost = await call('meet', `/meet/meetings/${code}/participants/${mimJoin.body.participantId}/admit`, { token: rafi.token, body: {} });
  check('only hosts can admit', notHost.status === 403);
  await call('meet', `/meet/meetings/${code}/participants/${mimJoin.body.participantId}/admit`, { token: ayesha.token, body: {} });
  check('Mim is told she was admitted', !!(await until(() => mim.events.find((e) => e.event === 'meeting:admission' && e.payload.state === 'admitted'))));
  const mimToken = await call('meet', `/meet/meetings/${code}/token`, { token: mim.token, body: {} });
  check('admitted person gets a media token', mimToken.status === 200 && !!mimToken.body.grant.token);

  await call('meet', `/meet/meetings/${code}`, { method: 'PATCH', token: ayesha.token, body: { controls: { hostManagement: true, allowChat: false, allowScreenShare: false } } });
  const silenced = await call('meet', `/meet/meetings/${code}/chat`, { token: mim.token, body: { body: 'hi' } });
  check('host management can turn off chat for participants', silenced.status === 403);
  const restricted = decodeJwt((await call('meet', `/meet/meetings/${code}/token`, { token: mim.token, body: {} })).body.grant.token) as { video?: { canPublishSources?: string[] } };
  check('…and screen sharing (enforced in the media token)', !!restricted.video?.canPublishSources && !restricted.video.canPublishSources.some((s) => String(s).includes('screen')), restricted.video);
  await call('meet', `/meet/meetings/${code}`, { method: 'PATCH', token: ayesha.token, body: { controls: { allowChat: true } } });
  await call('meet', `/meet/meetings/${code}/chat`, { token: mim.token, body: { body: 'Hello everyone 👋' } });
  const { body: chat } = await call('meet', `/meet/meetings/${code}/chat`, { token: rafi.token });
  check('in-meeting chat', chat.messages.at(-1)?.body === 'Hello everyone 👋');

  await call('meet', `/meet/meetings/${code}/hand`, { token: rafi.token, body: { raised: true } });
  const { body: list } = await call('meet', `/meet/meetings/${code}/participants`, { token: ayesha.token });
  check('raised hands are listed first', list.participants[0]?.userId === rafi.userId && !!list.participants[0].handRaisedAt);

  const poll = await call('meet', `/meet/meetings/${code}/polls`, { token: ayesha.token, body: { question: 'Ship on Friday?', options: ['Yes', 'No'] } });
  const { body: polls } = await call('meet', `/meet/meetings/${code}/polls`, { token: mim.token });
  await call('meet', `/meet/meetings/${code}/polls/${poll.body.id}/vote`, { token: mim.token, body: { optionIds: [polls.polls[0].options[0].id] } });
  const { body: results } = await call('meet', `/meet/meetings/${code}/polls`, { token: ayesha.token });
  check('meeting poll counts votes', results.polls[0].options[0].votes === 1);

  const question = await call('meet', `/meet/meetings/${code}/questions`, { token: rafi.token, body: { body: 'Will there be a demo?' } });
  await call('meet', `/meet/meetings/${code}/questions/${question.body.id}/vote`, { token: mim.token, body: { voted: true } });
  const { body: qa } = await call('meet', `/meet/meetings/${code}/questions`, { token: ayesha.token });
  check('Q&A with upvotes', qa.questions[0]?.votes === 1);

  const participantsNow = (await call('meet', `/meet/meetings/${code}/participants`, { token: ayesha.token })).body.participants as Array<{ id: string; userId: string }>;
  const pid = (userId: string) => participantsNow.find((p) => p.userId === userId)!.id;
  await call('meet', `/meet/meetings/${code}/breakouts`, { token: ayesha.token, body: { rooms: [{ name: 'Room A', participantIds: [pid(rafi.userId)] }, { name: 'Room B', participantIds: [pid(mim.userId)] }], minutes: 10 } });
  const breakoutToken = await call('meet', `/meet/meetings/${code}/token`, { token: mim.token, body: {} });
  const breakoutClaims = decodeJwt(breakoutToken.body.grant.token) as { video?: { room: string } };
  check('breakout rooms send people to their own room', breakoutToken.body.breakout === true && !!breakoutClaims.video?.room.includes('-b'), breakoutClaims.video);
  await call('meet', `/meet/meetings/${code}/breakouts`, { method: 'DELETE', token: ayesha.token });
  const back = await call('meet', `/meet/meetings/${code}/token`, { token: mim.token, body: {} });
  check('closing breakouts brings everyone back', back.body.breakout === false);

  await call('meet', `/meet/meetings/${code}/participants/${pid(mim.userId)}/remove`, { token: ayesha.token, body: {} });
  const again = await call('meet', `/meet/meetings/${code}/join`, { token: mim.token, body: {} });
  check('a removed person cannot rejoin', again.body.state === 'denied');

  const { body: attendance } = await call('meet', `/meet/meetings/${code}/attendance`, { token: ayesha.token });
  check('attendance report lists who came', attendance.sessions[0]?.people.length === 3);
  await call('meet', `/meet/meetings/${code}/end`, { token: ayesha.token, body: {} });
  check('ending the meeting tells everyone', !!(await until(() => rafi.events.find((e) => e.event === 'meeting:update' && e.payload.change === 'ended'))));
  const ended = await call('meet', `/meet/meetings/${code}`, { token: rafi.token });
  check('the meeting is ended', ended.body.meeting.status === 'ended' && ended.body.meeting.sessionId === null);
}
