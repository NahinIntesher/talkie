export type Role = 'user' | 'moderator' | 'admin' | 'owner';
export const rank: Record<Role, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };

export interface Series {
  day: string;
  total: number;
}

export interface Overview {
  accounts: {
    accounts: { active: number; suspended: number; pending: number; deleted: number };
    activeUsers: { day: number; week: number; month: number };
    devices: Record<string, number>;
    signups: Series[];
  } | null;
  chat: { directChats: number; groups: number; messages: { total: number; today: number }; liveStatuses: number; messagesDaily: Series[] } | null;
  meet: {
    calls: { total: number; live: number; video: number };
    meetings: { total: number; live: number };
    minutes: { calls: number; meetings: number };
    callsDaily: Series[];
    meetingsDaily: Series[];
  } | null;
  media: { files: number; bytes: number; byPurpose: Record<string, { files: number; bytes: number }>; driver: string } | null;
  reports: { open: number; total: number };
}

export interface Person {
  id: string;
  email: string | null;
  status: 'active' | 'suspended' | 'pending_profile' | 'deleted';
  role: Role;
  createdAt: string | null;
  lastActiveAt: string | null;
  devices: number;
  suspendedReason: string | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Card {
  id: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string | null;
}

export interface Report {
  id: string;
  reporterId: string;
  targetType: 'user' | 'group' | 'meeting';
  targetId: string;
  reason: string;
  note: string;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  resolution: string | null;
  action: string | null;
  createdAt: string;
  resolvedAt: string | null;
  reporter: Card | null;
  assignee?: Card | null;
  target?: (Card & { status?: string; openReports?: number; name?: string | null; members?: number }) | null;
}

export interface PersonDetail {
  user: Person & { about: string; lastSeenAt: string | null };
  devices: Array<{ id: string; name: string; platform: string; createdAt: string; lastActiveAt: string; revokedAt: string | null }>;
  activity: { directChats: number; groups: number; groupsOwned: number; messagesSent: number; lastMessageAt: string | null } | null;
  storage: { files: number; bytes: number } | null;
  reportsFiled: number;
  reports: Report[];
}

export interface AuditEntry {
  id: string;
  actor: Card;
  action: string;
  targetType: string;
  targetId: string | null;
  target: Card | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export const nameOf = (card: { displayName?: string | null; username?: string | null; id: string } | null | undefined) =>
  card?.displayName || (card?.username ? `@${card.username}` : card?.id ?? '-');
