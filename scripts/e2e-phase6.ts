// Phase 6 checks (admin panel API and moderation), run last by e2e-chat.ts.
import type { Person } from './e2e-phase3.ts';

type Service = 'auth' | 'users' | 'chat' | 'realtime' | 'media' | 'notify' | 'meet' | 'admin';
type Call = <T = any>(service: Service, path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<{ status: number; body: T }>;
type Check = (label: string, ok: boolean, detail?: unknown) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await wait(200);
  }
  return undefined;
}

export async function phase6({ call, check }: { call: Call; check: Check }, people: { boss: Person; ayesha: Person; rafi: Person; mim: Person }) {
  const { boss, ayesha, rafi, mim } = people;

  const me = await call('admin', '/admin/me', { token: boss.token });
  check('an OWNER_EMAILS account is the owner', me.status === 200 && me.body.role === 'owner', me.body);
  const denied = await call('admin', '/admin/overview', { token: rafi.token });
  check('members cannot open the admin panel', denied.status === 403, denied.body);
  const anonymous = await call('admin', '/admin/overview');
  check('the admin panel needs a sign-in', anonymous.status === 401);

  // A report flows from the users service to the moderation queue through the event bus.
  const filed = await call('users', `/users/${rafi.userId}/report`, { token: ayesha.token, body: { reason: 'spam', note: 'Sends the same link to everyone' } });
  check('Ayesha reports Rafi', filed.status === 200, filed.body);
  const report = await until(async () => {
    const { body } = await call('admin', '/admin/reports?status=open', { token: boss.token });
    return (body.reports as any[])?.find((r) => r.targetId === rafi.userId && r.reporterId === ayesha.userId);
  });
  check('the report reaches the moderation queue', !!report && report.reason === 'spam' && report.target?.status === 'active', report);

  const overview = await call('admin', '/admin/overview', { token: boss.token });
  const o = overview.body;
  check(
    'overview has numbers from every service',
    overview.status === 200 && o.accounts?.accounts.active >= 4 && o.chat?.messages.total > 0 && o.meet?.calls.total > 0 && o.media !== null && o.reports.open >= 1,
    { accounts: o.accounts?.accounts, chat: o.chat?.messages, meet: o.meet?.calls, reports: o.reports },
  );
  check('overview has 30-day series', o.accounts?.signups.length === 30 && o.chat?.messagesDaily.at(-1).total > 0, o.chat?.messagesDaily.at(-1));

  const { body: rafiProfile } = await call('users', '/users/me', { token: rafi.token });
  const search = await call('admin', `/admin/users?q=${encodeURIComponent(rafiProfile.profile.username)}`, { token: boss.token });
  check('people search finds Rafi by username', search.body.users?.some((u: any) => u.id === rafi.userId && u.email?.includes('rafi')), search.body);
  const detail = await call('admin', `/admin/users/${rafi.userId}`, { token: boss.token });
  check('person view shows activity and reports', detail.status === 200 && detail.body.activity.messagesSent > 0 && detail.body.reports.length >= 1, detail.body.activity);

  // Roles: the owner makes Mim a moderator; the new role works at once (no waiting for a new token).
  const promoted = await call('admin', `/admin/users/${mim.userId}/role`, { method: 'PUT', token: boss.token, body: { role: 'moderator' } });
  check('owner makes Mim a moderator', promoted.status === 200, promoted.body);
  const mimIn = await call('admin', '/admin/overview', { token: mim.token });
  check('the moderator can open the panel right away', mimIn.status === 200);
  const mimRole = await call('admin', `/admin/users/${rafi.userId}/role`, { method: 'PUT', token: mim.token, body: { role: 'admin' } });
  check('a moderator cannot change roles', mimRole.status === 403);
  const mimSignOut = await call('admin', `/admin/users/${rafi.userId}/sign-out`, { method: 'POST', token: mim.token, body: {} });
  check('a moderator cannot sign people out', mimSignOut.status === 403);
  const mimOnBoss = await call('admin', `/admin/users/${boss.userId}/suspend`, { method: 'POST', token: mim.token, body: { reason: 'test' } });
  check('a moderator cannot suspend the owner', mimOnBoss.status === 403);
  const mimAudit = await call('admin', '/admin/audit', { token: mim.token });
  check('a moderator cannot read the audit log', mimAudit.status === 403);
  const selfSuspend = await call('admin', `/admin/users/${boss.userId}/suspend`, { method: 'POST', token: boss.token, body: { reason: 'test' } });
  check('nobody can suspend themselves', selfSuspend.status === 403);

  // Acting on the report suspends Rafi and signs out his devices.
  const acted = await call('admin', `/admin/reports/${report?.id}`, { method: 'POST', token: mim.token, body: { status: 'actioned', resolution: 'Spam links', suspend: true } });
  check('the moderator closes the report and suspends Rafi', acted.status === 200 && acted.body.action === 'suspended', acted.body);
  const suspended = await call('admin', `/admin/users/${rafi.userId}`, { token: boss.token });
  check('Rafi is suspended and signed out', suspended.body.user.status === 'suspended' && suspended.body.user.devices === 0, suspended.body.user);
  const otp = await call('auth', '/auth/otp/request', { body: { email: suspended.body.user.email, locale: 'en' } });
  check('a suspended account can still ask for a code (but not sign in)', otp.status === 200 || otp.status === 429, otp.body);
  const closed = await call('admin', '/admin/reports?status=closed', { token: boss.token });
  check('the report is in the closed list', closed.body.reports?.some((r: any) => r.id === report?.id && r.status === 'actioned' && r.action === 'suspended'));

  const restored = await call('admin', `/admin/users/${rafi.userId}/restore`, { method: 'POST', token: boss.token, body: {} });
  check('owner restores Rafi', restored.status === 200, restored.body);
  const again = await call('admin', `/admin/users/${rafi.userId}/restore`, { method: 'POST', token: boss.token, body: {} });
  check('restoring an active account is refused', again.status === 409);

  const audit = await call('admin', '/admin/audit', { token: boss.token });
  const actions = (audit.body.entries as any[]).map((e) => e.action);
  check('the audit log records every action', ['user.role', 'report.actioned', 'user.suspend', 'user.restore'].every((a) => actions.includes(a)), actions.slice(0, 8));
  check('audit entries name the actor', audit.body.entries[0]?.actor?.displayName === 'boss', audit.body.entries[0]?.actor);

  const demoted = await call('admin', `/admin/users/${mim.userId}/role`, { method: 'PUT', token: boss.token, body: { role: 'user' } });
  const mimOut = await call('admin', '/admin/me', { token: mim.token });
  check('a removed role stops working at once', demoted.status === 200 && mimOut.status === 403, mimOut.body);
}
