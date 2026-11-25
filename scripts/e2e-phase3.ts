// Phase 3 checks (files, polls, status, photos), run by e2e-chat.ts after the messaging checks.
import * as e2ee from '@talkie/e2ee';

export interface Person {
  name: string;
  token: string;
  userId: string;
  deviceId: string;
  keys: e2ee.DeviceKeyPair;
}

type Call = <T = any>(service: 'auth' | 'users' | 'chat' | 'realtime' | 'media' | 'notify', path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<{ status: number; body: T }>;
type Check = (label: string, ok: boolean, detail?: unknown) => void;

export async function phase3(
  { call, check, mediaPort }: { call: Call; check: Check; mediaPort: number },
  people: { ayesha: Person; rafi: Person; mim: Person },
  conversationId: string,
  groupId: string,
  deviceKeys: Map<string, string>,
) {
  const { ayesha, rafi, mim } = people;
  const media = `http://127.0.0.1:${mediaPort}`;

  const upload = async (person: Person, purpose: string, bytes: Uint8Array, contentType = 'application/octet-stream') => {
    const { body: created } = await call('media', '/media/uploads', { token: person.token, body: { purpose, byteSize: bytes.length, contentType } });
    for (let index = 0, offset = 0; offset < bytes.length; index++, offset += created.partSize) {
      const response = await fetch(`${media}/media/uploads/${created.mediaId}/parts/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${person.token}` },
        body: bytes.subarray(offset, offset + created.partSize),
      });
      if (!response.ok) throw new Error(`part ${index}: ${response.status} ${await response.text()}`);
    }
    return call('media', `/media/uploads/${created.mediaId}/complete`, { token: person.token, body: {} });
  };

  // Encrypted file, larger than one upload part.
  const file = new Uint8Array(9 * 1024 * 1024 + 12345).map((_, i) => (i * 7) % 256);
  const sealedFile = e2ee.encryptBytes(file);
  const uploaded = await upload(ayesha, 'message', sealedFile.data);
  check('a 9 MB encrypted file uploads in parts', uploaded.body.status === 'ready', uploaded.body);
  const mediaId = uploaded.body.mediaId as string;
  const { body: list } = await call('chat', `/chat/conversations/${conversationId}/devices`, { token: ayesha.token });
  const attachment = { mediaId, key: sealedFile.key, header: sealedFile.header, mime: 'application/pdf', name: 'report.pdf', size: file.length };
  const sent = await call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: ayesha.token,
    body: { clientMessageId: e2ee.clientMessageId(), kind: 'document', mediaIds: [mediaId], ...e2ee.seal({ v: 1, text: 'The report', attachments: [attachment] }, ayesha.keys, list.devices) },
  });
  check('document message sent', sent.status === 201, sent.body);
  const { body: received } = await call('chat', `/chat/messages/${sent.body.message.id}`, { token: rafi.token });
  const body = e2ee.open(received.message, deviceKeys.get(received.message.senderDeviceId)!, rafi.keys) as unknown as { attachments: typeof attachment[] };
  const download = new Uint8Array(await (await fetch(`${media}/media/files/${body.attachments[0]!.mediaId}`, { headers: { authorization: `Bearer ${rafi.token}` } })).arrayBuffer());
  const opened = e2ee.decryptBytes(download, body.attachments[0]!.key, body.attachments[0]!.header);
  check('Rafi downloads and decrypts the file byte-for-byte', Buffer.from(opened).equals(Buffer.from(file)));
  const ranged = await fetch(`${media}/media/files/${mediaId}`, { headers: { authorization: `Bearer ${rafi.token}`, range: 'bytes=0-99' } });
  check('downloads support byte ranges (resume)', ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100);
  const stolen = await call('chat', `/chat/conversations/${conversationId}/messages`, {
    token: rafi.token,
    body: {
      clientMessageId: e2ee.clientMessageId(),
      kind: 'image',
      mediaIds: [mediaId],
      ...e2ee.seal({ v: 1 }, rafi.keys, list.devices),
    },
  });
  check('nobody can attach someone else’s upload', stolen.status === 400, stolen.body);

  // Poll in the group
  const { body: groupDevices } = await call('chat', `/chat/conversations/${groupId}/devices`, { token: ayesha.token });
  const poll = await call('chat', `/chat/conversations/${groupId}/messages`, {
    token: ayesha.token,
    body: { clientMessageId: e2ee.clientMessageId(), kind: 'poll', ...e2ee.seal({ v: 1, poll: { question: 'Where?', options: ['Sajek', 'Bandarban'], multiple: false } }, ayesha.keys, groupDevices.devices) },
  });
  await call('chat', `/chat/messages/${poll.body.message.id}/vote`, { method: 'PUT', token: mim.token, body: { options: [1] } });
  await call('chat', `/chat/messages/${poll.body.message.id}/vote`, { method: 'PUT', token: rafi.token, body: { options: [1] } });
  const { body: tally } = await call('chat', `/chat/messages/${poll.body.message.id}`, { token: ayesha.token });
  check('poll votes are counted', tally.message.pollVotes?.[0]?.option === 1 && tally.message.pollVotes[0].userIds.length === 2, tally.message.pollVotes);

  // Status
  const { body: statusDevices } = await call('chat', '/chat/status/devices', { token: ayesha.token, body: { userIds: [rafi.userId] } });
  const statusSealed = e2ee.seal({ v: 1, text: 'Good morning ☀️', background: '#5b5bf7' }, ayesha.keys, statusDevices.devices);
  const posted = await call('chat', '/chat/status', { token: ayesha.token, body: { kind: 'text', ...statusSealed, audience: [rafi.userId] } });
  check('status posted to the chosen audience', posted.status === 201 && posted.body.sharedWith === 1, posted.body);
  const { body: rafiFeed } = await call('chat', '/chat/status/feed', { token: rafi.token });
  const seenStatus = rafiFeed.others.find((st: { id: string }) => st.id === posted.body.id);
  check('Rafi sees and decrypts the status', !!seenStatus && e2ee.open(seenStatus, ayesha.keys.publicKey, rafi.keys).text === 'Good morning ☀️');
  const { body: mimFeed } = await call('chat', '/chat/status/feed', { token: mim.token });
  check('people outside the audience do not see it', !mimFeed.others.some((st: { id: string }) => st.id === posted.body.id));
  await call('chat', `/chat/status/${posted.body.id}/view`, { token: rafi.token, body: { reaction: '😍' } });
  const { body: viewers } = await call('chat', `/chat/status/${posted.body.id}/viewers`, { token: ayesha.token });
  check('Ayesha sees who viewed it', viewers.viewers[0]?.userId === rafi.userId && viewers.viewers[0]?.reaction === '😍', viewers);
  const peek = await call('chat', `/chat/status/${posted.body.id}/viewers`, { token: rafi.token });
  check('only the owner sees the viewer list', peek.status === 404);

  // Profile and group photos
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#8b5cf6' } }).png().toBuffer();
  const avatar = await upload(ayesha, 'avatar', new Uint8Array(png), 'image/png');
  const setAvatar = await call('users', '/users/me/avatar', { method: 'PUT', token: ayesha.token, body: { mediaId: avatar.body.mediaId } });
  check('profile photo set', setAvatar.status === 200 && !!setAvatar.body.avatarUrl, setAvatar.body);
  const image = await fetch(`${media}/media/avatars/${avatar.body.mediaId}`);
  const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  check('photo is re-encoded to a 640×640 JPEG', image.ok && meta.format === 'jpeg' && meta.width === 640 && meta.height === 640, { format: meta.format, width: meta.width });
  const notMine = await call('users', '/users/me/avatar', { method: 'PUT', token: rafi.token, body: { mediaId: avatar.body.mediaId } });
  check('cannot use someone else’s photo', notMine.status === 400);
  const groupPhoto = await upload(ayesha, 'group_avatar', new Uint8Array(png), 'image/png');
  const setGroup = await call('chat', `/chat/groups/${groupId}`, { method: 'PATCH', token: ayesha.token, body: { avatarMediaId: groupPhoto.body.mediaId } });
  check('group photo set', setGroup.status === 200 && !!setGroup.body.conversation.group.avatarUrl, setGroup.body);

  // Deleting the message removes the file
  await call('chat', `/chat/messages/${sent.body.message.id}?scope=everyone`, { method: 'DELETE', token: ayesha.token });
  const gone = await fetch(`${media}/media/files/${mediaId}`, { headers: { authorization: `Bearer ${rafi.token}` } });
  check('deleting for everyone deletes the file too', gone.status === 404);
}
