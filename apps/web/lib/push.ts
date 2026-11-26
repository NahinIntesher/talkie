'use client';

import { api } from './api';

/**
 * Web push through Firebase Cloud Messaging. The Firebase web config is public by design (it identifies the project;
 * access is controlled by Firebase's rules and the server key). The VAPID key comes from Firebase console →
 * Project settings → Cloud Messaging → Web Push certificates.
 */
export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyDksuSZC6R4P_Ie2Wm7lM1iMKVMprHt578',
  authDomain: 'talkie-fd138.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'talkie-fd138',
  storageBucket: 'talkie-fd138.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID ?? '766371327681',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '1:766371327681:web:8ecc274b96ce747018ee40',
};
// Public web-push key (Firebase → Cloud Messaging → Web Push certificates). Public by design, like the config above.
const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || 'BH8sTqI3L1gJdt0PImkoOxLuh5r5BxrhWQ1pvtLGR6-BkYMLX3NUoLwRSeKIT9RkFX5RupHQIcY-Tk8oTYUlx9o';

const supported = () =>
  typeof window !== 'undefined' && !!vapidKey && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

let registered: Promise<void> | null = null;

/** Once notifications are allowed: give this browser's push token to the server. Safe to call many times. */
export function registerWebPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return Promise.resolve();
  registered ??= (async () => {
    try {
      const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([import('@firebase/app'), import('@firebase/messaging')]);
      if (!(await isSupported())) return;
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      // Our own small worker (public/firebase-messaging-sw.js) shows the notifications; Firebase only needs it for the subscription.
      const worker = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });
      const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: worker });
      if (token) await api('/notify/push-token', { method: 'PUT', body: { provider: 'fcm', token } });
    } catch (error) {
      registered = null;
      console.warn('Talkie: web push is not available', error);
    }
  })();
  return registered;
}

/** Before sign-out: stop pushes to this browser for this account. */
export async function unregisterWebPush(): Promise<void> {
  if (!supported() || !registered) return;
  registered = null;
  try {
    await api('/notify/push-token', { method: 'DELETE' });
  } catch {}
  try {
    const [{ getApps }, { getMessaging, deleteToken }] = await Promise.all([import('@firebase/app'), import('@firebase/messaging')]);
    const app = getApps()[0];
    if (app) await deleteToken(getMessaging(app));
  } catch {}
}
