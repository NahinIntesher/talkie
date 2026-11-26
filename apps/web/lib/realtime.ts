'use client';

import { io, type Socket } from 'socket.io-client';
import { refreshSession, tokenStore } from './api';

/** The live connection. In development the realtime service runs on its own port; in production Nginx serves /ws. */
const url = process.env.NEXT_PUBLIC_REALTIME_URL ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:4104' : undefined);

let socket: Socket | null = null;
const listeners = new Set<(state: 'connected' | 'connecting' | 'offline') => void>();

export function connectRealtime(): Socket {
  if (socket) return socket;
  const options = {
    path: '/ws',
    // WebSocket first; if it cannot connect, fall back to long-polling (and upgrade later when possible).
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    auth: (cb: (data: object) => void) => cb({ token: tokenStore.get() }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 8_000,
  };
  socket = url ? io(url, options) : io(options);
  const notify = (state: 'connected' | 'connecting' | 'offline') => listeners.forEach((listener) => listener(state));
  socket.on('connect', () => notify('connected'));
  socket.on('disconnect', () => notify('connecting'));
  socket.io.on('reconnect_attempt', () => notify('connecting'));
  socket.on('connect_error', async (error) => {
    notify('offline');
    // Expired access token: refresh it, then the next automatic attempt uses the new one.
    if (error.message === 'unauthorized') await refreshSession();
  });
  return socket;
}

/** Tells the server about a refreshed access token so the open socket stays authorized. */
export function renewRealtimeToken() {
  if (socket?.connected && tokenStore.get()) socket.emit('auth', tokenStore.get());
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}

export function onConnectionState(listener: (state: 'connected' | 'connecting' | 'offline') => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const realtime = () => socket;
