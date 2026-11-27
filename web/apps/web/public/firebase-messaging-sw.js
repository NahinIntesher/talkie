/* Talkie web push (Firebase Cloud Messaging). Registered by lib/push.ts.
 *
 * Shows notifications only while Talkie is not open and focused; an open tab already updates live and shows its own
 * notifications with the same tags, so a message never appears twice. No third-party scripts are loaded here.
 * Message text never arrives here: it is end-to-end encrypted, so a push says who wrote and what kind of message.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  const notification = payload.notification || {};
  const data = payload.data || {};
  const link = data.type === 'message' && /^[1-9]\d{0,19}$/.test(data.conversationId) ? '/app?c=' + data.conversationId : '/app';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = windows.find(client => client.focused && client.visibilityState === 'visible');
      if (focused) {
        if (data.type === 'message') focused.postMessage({ ...data, title: data.title || notification.title, body: data.body || notification.body, action: 'banner' });
        return;
      }
      await self.registration.showNotification(notification.title || 'Talkie', {
        body: notification.body || '',
        icon: notification.icon || '/icon.svg',
        badge: '/icon.svg',
        tag: notification.tag || data.conversationId || data.callId,
        renotify: !!(notification.tag || data.conversationId),
        requireInteraction: data.type === 'call',
        actions: data.type === 'message' ? [{ action: 'reply', title: data.locale === 'en' ? 'Reply' : 'উত্তর দিন' }] : [],
        data: { ...data, link },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.link || '/app', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === target.origin);
      if (existing && event.notification.data?.type === 'message' && event.notification.data?.deviceId && new URL(existing.url).pathname.startsWith('/app')) {
        await existing.focus();
        existing.postMessage({ ...event.notification.data, action: event.action === 'reply' ? 'reply' : 'open' });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
