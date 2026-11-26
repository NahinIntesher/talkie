import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { createService, loadConfig, Snowflake } from '@talkie/core';
import { createBus } from '@talkie/bus';
import { createVerifier, type AuthContext } from '@talkie/auth-kit';

/**
 * Live updates. Clients keep one WebSocket; the server pushes small "something changed" signals and the client
 * fetches the details over HTTP (which enforces permissions). Message bodies never travel through here.
 * Stateless: with REDIS_URL, every replica shares rooms through the Redis adapter.
 */
const env = loadConfig({
  PORT: z.coerce.number().int().positive().default(4104),
  USERS_URL: z.url().default('http://127.0.0.1:4102'),
  CHAT_URL: z.url().default('http://127.0.0.1:4103'),
});

const service = await createService({ name: 'realtime', env });
const verifier = await createVerifier(env);
const ids = new Snowflake(env.WORKER_ID);
const bus = createBus(env, service.log, 'realtime');

const origins = new Set([env.PUBLIC_ORIGIN, ...env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)]);
const io = new Server(service.app.server, {
  path: '/ws',
  serveClient: false,
  // WebSocket first. HTTP long-polling only as a fallback for networks or hosts that block WebSockets
  // (it needs every request of a client on one process: fine on cPanel's single process; with several realtime
  // replicas behind nginx, WebSocket is what clients get).
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 20_000,
  pingTimeout: 20_000,
  cors: { origin: (origin, callback) => callback(null, !origin || origins.has(origin)), credentials: true },
});

if (env.REDIS_URL) {
  const pub = new Redis(env.REDIS_URL);
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  service.onShutdown(async () => {
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });
}

const internal = async <T>(url: string, body?: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`internal ${response.status}`);
  return (await response.json()) as T;
};

/** Conversation members, cached for a minute and refreshed by membership events. */
const memberCache = new Map<string, { at: number; members: Set<string> }>();
const membersOf = async (conversationId: string): Promise<Set<string>> => {
  const hit = memberCache.get(conversationId);
  if (hit && Date.now() - hit.at < 60_000) return hit.members;
  const { memberIds } = await internal<{ memberIds: string[] }>(`${env.CHAT_URL}/internal/conversations/${conversationId}/members`);
  const members = new Set(memberIds);
  memberCache.set(conversationId, { at: Date.now(), members });
  return members;
};

interface SocketData {
  auth: AuthContext;
  expiresAt: number;
}
type Client = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

const userRoom = (id: string) => `user:${id}`;
const deviceRoom = (id: string) => `device:${id}`;
const presenceRoom = (id: string) => `presence:${id}`;
const onlineCount = async (userId: string) => (await io.in(userRoom(userId)).fetchSockets()).length;

const tokenExpiry = (token: string): number => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
};

io.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth as { token?: unknown }).token ?? '');
    const auth = await verifier.verify(token);
    (socket as Client).data = { auth, expiresAt: tokenExpiry(token) };
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (raw) => {
  const socket = raw as Client;
  const { auth } = socket.data;
  const firstDevice = (await onlineCount(auth.userId)) === 0;
  await socket.join([userRoom(auth.userId), deviceRoom(auth.deviceId)]);
  if (firstDevice) io.to(presenceRoom(auth.userId)).emit('presence' as never, { userId: auth.userId, online: true } as never);

  /** The client sends a fresh access token after refreshing, so the socket stays authorized. */
  socket.on('auth' as never, async (token: unknown, ack?: (ok: boolean) => void) => {
    try {
      const next = await verifier.verify(String(token));
      if (next.userId !== auth.userId || next.deviceId !== auth.deviceId) throw new Error('identity changed');
      socket.data.expiresAt = tokenExpiry(String(token));
      ack?.(true);
    } catch {
      ack?.(false);
      socket.disconnect(true);
    }
  });

  /** Start receiving online/offline changes for these people (only those whose privacy allows it). */
  socket.on('presence:watch' as never, async (userIds: unknown, ack?: (states: Array<{ userId: string; online: boolean }>) => void) => {
    const parsed = z.array(z.string().regex(/^\d{1,20}$/)).max(300).safeParse(userIds);
    if (!parsed.success || !parsed.data.length) return ack?.([]);
    try {
      const { visible } = await internal<{ visible: string[] }>(`${env.USERS_URL}/internal/presence-visibility`, { viewerId: auth.userId, userIds: parsed.data });
      for (const room of socket.rooms) if (room.startsWith('presence:')) await socket.leave(room);
      await socket.join(visible.map(presenceRoom));
      ack?.(await Promise.all(visible.map(async (userId) => ({ userId, online: (await onlineCount(userId)) > 0 }))));
    } catch (error) {
      service.log.warn({ err: error }, 'presence watch failed');
      ack?.([]);
    }
  });

  let lastTyping = 0;
  socket.on('typing' as never, async (input: unknown) => {
    const parsed = z.object({ conversationId: z.string().regex(/^\d{1,20}$/), active: z.boolean(), recording: z.boolean().optional() }).safeParse(input);
    if (!parsed.success) return;
    const now = Date.now();
    if (parsed.data.active && now - lastTyping < 1_500) return;
    lastTyping = parsed.data.active ? now : 0;
    try {
      const members = await membersOf(parsed.data.conversationId);
      if (!members.has(auth.userId)) return;
      for (const member of members)
        if (member !== auth.userId)
          io.to(userRoom(member)).emit('typing' as never, { ...parsed.data, userId: auth.userId } as never);
    } catch (error) {
      service.log.warn({ err: error }, 'typing relay failed');
    }
  });

  socket.on('disconnect', async () => {
    if ((await onlineCount(auth.userId)) > 0) return;
    const at = new Date().toISOString();
    io.to(presenceRoom(auth.userId)).emit('presence' as never, { userId: auth.userId, online: false, lastSeenAt: at } as never);
    await bus.publish({ id: ids.next(), type: 'presence.offline', key: auth.userId, payload: { userId: auth.userId, at }, occurredAt: at }).catch(() => {});
  });
});

// Sockets whose access token expired more than a minute ago (and was not renewed) are closed.
const expiryCheck = setInterval(async () => {
  for (const socket of await io.fetchSockets()) {
    const data = socket.data as SocketData;
    if (data.expiresAt && data.expiresAt + 60_000 < Date.now()) socket.disconnect(true);
  }
}, 30_000);
expiryCheck.unref();

// ───────── Events from other services → live signals ─────────

const toUsers = (userIds: unknown, event: string, payload: unknown) => {
  if (!Array.isArray(userIds)) return;
  for (const id of userIds) io.to(userRoom(String(id))).emit(event as never, payload as never);
};

bus.subscribe('realtime', ['message.sent', 'message.updated', 'conversation.updated', 'receipt.updated', 'status.updated', 'device.revoked', 'call.ringing', 'call.updated', 'call.ended', 'meeting.updated', 'meeting.admission'], async (event) => {
  const payload = event.payload as Record<string, unknown> & { recipients?: string[]; conversationId?: string };
  const { recipients, ...rest } = payload;
  switch (event.type) {
    case 'message.sent':
      return toUsers(recipients, 'chat:message', rest);
    case 'message.updated':
      return toUsers(recipients, 'chat:message-updated', rest);
    case 'receipt.updated':
      return toUsers(recipients, 'chat:receipt', rest);
    case 'status.updated':
      return toUsers(recipients, 'status:update', rest);
    case 'call.ringing':
      return toUsers(recipients, 'call:incoming', rest);
    case 'call.updated':
      return toUsers(recipients, 'call:update', rest);
    case 'call.ended':
      return toUsers(recipients, 'call:ended', rest);
    case 'meeting.updated':
      return toUsers(recipients, 'meeting:update', rest);
    case 'meeting.admission':
      return toUsers(recipients, 'meeting:admission', rest);
    case 'conversation.updated':
      if (payload.conversationId) memberCache.delete(payload.conversationId);
      return toUsers(recipients, 'chat:conversation', rest);
    case 'device.revoked': {
      const { userId, deviceId } = payload as { userId: string; deviceId: string };
      io.to(userRoom(userId)).emit('session:device-revoked' as never, { deviceId } as never);
      io.in(deviceRoom(deviceId)).disconnectSockets(true);
      return;
    }
  }
});

service.onShutdown(async () => {
  clearInterval(expiryCheck);
  io.close();
  await bus.close();
});

await service.listen(env.PORT);
