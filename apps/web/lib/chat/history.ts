import { openSecret, safetyNumber, sealSecret } from '@talkie/e2ee';
import { api } from '../api';
import { deviceKeys, senderKeys } from './keys';

interface TransferPage {
  keys: Array<{ messageId: string; nonce: string; keySenderDeviceId: string; sealedKey: string }>;
  nextBefore: string | null;
}

export function historyTransferCode() {
  const current = deviceKeys();
  return current ? `${current.deviceId}.${current.pair.publicKey}` : null;
}

export const historyApprovalCode = (identityKey: string) => safetyNumber(identityKey, identityKey).replaceAll(' ', '').slice(0, 12);

export async function transferHistory(code: string) {
  const match = /^([1-9]\d{0,19})\.([A-Za-z0-9_-]{43})$/.exec(code.trim());
  const current = deviceKeys();
  if (!match || !current || match[1] === current.deviceId) throw new Error('Use the transfer code from your other device.');
  const target = { deviceId: match[1]!, identityKey: match[2]! };
  let before: string | null = null;
  let added = 0;
  let unreadable = 0;
  do {
    if (deviceKeys()?.deviceId !== current.deviceId) throw new Error('The source device changed.');
    const query = new URLSearchParams({ ...target, ...(before ? { before } : {}) });
    const page: TransferPage = await api(`/chat/history/transfer?${query}`);
    const known = await senderKeys(page.keys.map((key) => key.keySenderDeviceId));
    const keys = page.keys.flatMap(({ messageId, nonce, keySenderDeviceId, sealedKey }) => {
      const sender = keySenderDeviceId === current.deviceId ? current.pair.publicKey : known.get(keySenderDeviceId);
      try {
        if (!sender) throw new Error('Missing sender key');
        const secret = openSecret(sealedKey, sender, current.pair);
        return [{ messageId, nonce, sealedKey: sealSecret(secret, current.pair, [target])[0]!.sealedKey }];
      } catch {
        unreadable++;
        return [];
      }
    });
    if (keys.length) {
      const result = await api<{ added: number }>('/chat/history/transfer', { method: 'POST', body: { target, keys } });
      added += result.added;
    }
    before = page.nextBefore;
  } while (before);
  await api('/chat/history/requests/complete', { method: 'POST', body: { ...target, transferred: added > 0 } });
  return { added, unreadable };
}
