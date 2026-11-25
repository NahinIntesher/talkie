import { AppError } from '@talkie/core';

export interface AdminEnv {
  INTERNAL_TOKEN: string;
  AUTH_URL: string;
  USERS_URL: string;
  CHAT_URL: string;
  MEET_URL: string;
  MEDIA_URL: string;
}

export type Role = 'user' | 'moderator' | 'admin' | 'owner';
export const rank: Record<Role, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };

export interface Account {
  id: string;
  email: string;
  status: 'pending_profile' | 'active' | 'suspended' | 'deleted';
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  suspendedReason: string | null;
  devices: number;
}

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  about: string;
  avatarUrl: string | null;
  locale: string;
  createdAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
}

export interface Series {
  day: string;
  total: number;
}

/** Typed calls to the other services' `/internal/admin/*` routes. */
export function clients(env: AdminEnv) {
  const call = async <T>(base: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-internal-token': env.INTERNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new AppError('unavailable', 'A Talkie service is not responding. Try again in a moment.');
    }
    if (response.status === 404) throw new AppError('not_found', 'Not found.');
    if (!response.ok) throw new AppError('unavailable', `A Talkie service failed (${response.status}).`);
    return (await response.json()) as T;
  };

  return {
    auth: {
      access: (userId: string) => call<{ role: Role; status: string }>(env.AUTH_URL, `/internal/admin/accounts/${userId}/access`),
      accounts: (filter: { ids?: string[]; email?: string; status?: string; staff?: boolean; before?: string; limit?: number }) =>
        call<{ accounts: Account[] }>(env.AUTH_URL, '/internal/admin/accounts', filter).then((r) => r.accounts),
      account: (userId: string) =>
        call<{
          account: Account;
          devices: Array<{ id: string; name: string; platform: string; createdAt: string; lastActiveAt: string; revokedAt: string | null }>;
        }>(env.AUTH_URL, `/internal/admin/accounts/${userId}`),
      setStatus: (userId: string, status: 'active' | 'suspended', reason: string) =>
        call<{ ok: true }>(env.AUTH_URL, `/internal/accounts/${userId}/status`, { status, reason }),
      setRole: (userId: string, role: Exclude<Role, 'owner'>) => call<{ ok: true }>(env.AUTH_URL, `/internal/admin/accounts/${userId}/role`, { role }),
      signOut: (userId: string) => call<{ revoked: number }>(env.AUTH_URL, `/internal/admin/accounts/${userId}/sign-out`, {}),
      stats: () =>
        call<{
          accounts: { active: number; suspended: number; pending: number; deleted: number };
          activeUsers: { day: number; week: number; month: number };
          devices: Record<string, number>;
          signups: Series[];
        }>(env.AUTH_URL, '/internal/admin/stats'),
    },
    users: {
      profiles: (ids: string[]) =>
        ids.length ? call<{ profiles: Profile[] }>(env.USERS_URL, '/internal/admin/profiles', { ids }).then((r) => r.profiles) : Promise.resolve([]),
      search: (q: string) => call<{ ids: string[] }>(env.USERS_URL, `/internal/admin/profiles/search?q=${encodeURIComponent(q)}`).then((r) => r.ids),
    },
    chat: {
      stats: () =>
        call<{ directChats: number; groups: number; messages: { total: number; today: number }; liveStatuses: number; messagesDaily: Series[] }>(
          env.CHAT_URL,
          '/internal/admin/stats',
        ),
      user: (userId: string) =>
        call<{ directChats: number; groups: number; groupsOwned: number; messagesSent: number; lastMessageAt: string | null }>(
          env.CHAT_URL,
          `/internal/admin/users/${userId}`,
        ),
      group: (id: string) =>
        call<{ group: { id: string; name: string; description: string; createdBy: string; createdAt: string; members: number } }>(
          env.CHAT_URL,
          `/internal/admin/groups/${id}`,
        ).then((r) => r.group),
    },
    meet: {
      stats: () =>
        call<{
          calls: { total: number; live: number; video: number };
          meetings: { total: number; live: number };
          minutes: { calls: number; meetings: number };
          callsDaily: Series[];
          meetingsDaily: Series[];
        }>(env.MEET_URL, '/internal/admin/stats'),
    },
    media: {
      stats: () => call<{ files: number; bytes: number; byPurpose: Record<string, { files: number; bytes: number }>; driver: string }>(env.MEDIA_URL, '/internal/admin/stats'),
      user: (userId: string) => call<{ files: number; bytes: number }>(env.MEDIA_URL, `/internal/admin/users/${userId}`),
    },
  };
}

export type Clients = ReturnType<typeof clients>;
