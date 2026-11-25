'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import clsx from 'clsx';
import { Ban, Camera, Flag, Clock, Link2, LogOut, MoreVertical, Pencil, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import { uploadPhoto } from '@/lib/chat/media';
import * as e2ee from '@talkie/e2ee';
import { Avatar, Button, IconButton, Segmented, Switch, TextField } from '@/components/ui/primitives';
import { Dialog, Menu } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { conversationTitle, nameOf, useChat } from '@/lib/chat/store';
import { chatStrings } from '@/lib/chat/strings';
import { deviceKeys } from '@/lib/chat/keys';
import * as engine from '@/lib/chat/engine';
import { NewChatDialog } from './new-chat-dialog';
import { ReportDialog } from './report-dialog';

export function InfoPanel({ conversationId, onClose, onLeft }: { conversationId: string; onClose: () => void; onLeft: () => void }) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const toast = useToast();
  const state = useChat();
  const conversation = state.conversations[conversationId];
  const members = state.members[conversationId] ?? [];
  const me = state.me?.userId;
  const [adding, setAdding] = useState(false);
  const [editingInfo, setEditingInfo] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [safety, setSafety] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (conversation?.peerId) void engine.refreshProfile(conversation.peerId).catch(() => {});
  }, [conversation?.peerId]);

  if (!conversation) return null;
  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : s.failed, 'error');
  const group = conversation.group;
  const peer = conversation.peerId ? state.profiles[conversation.peerId] : undefined;
  const myRole = members.find((m) => m.userId === me)?.role ?? conversation.role;
  const isAdmin = myRole === 'admin' || myRole === 'owner';
  const canEditInfo = !!group && (group.editInfoPolicy === 'all' || isAdmin);
  const title = conversationTitle(state, conversation);

  const patchGroup = async (body: object) => {
    try {
      await api(`/chat/groups/${conversationId}`, { method: 'PATCH', body });
      await engine.reload(conversationId);
    } catch (error) {
      fail(error);
    }
  };

  const showSafety = async () => {
    try {
      const { devices } = await api<{ devices: Array<{ identityKey: string }> }>(`/auth/users/${conversation.peerId}/device-keys`);
      const mine = deviceKeys()?.pair.publicKey;
      if (!mine || !devices[0]) return toast(s.decryptFailed, 'error');
      setSafety(e2ee.safetyNumber(mine, devices[0].identityKey));
    } catch (error) {
      fail(error);
    }
  };

  const disappearing = conversation.disappearingSeconds ?? 0;

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      className="absolute inset-0 z-30 flex flex-col border-l border-border bg-surface lg:static lg:w-[380px]"
      aria-label={group ? s.groupInfo : s.contactInfo}
    >
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-3">
        <IconButton label={s.cancel} onClick={onClose}>
          <X className="size-5" />
        </IconButton>
        <h2 className="font-bold">{group ? s.groupInfo : s.contactInfo}</h2>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
          <label className={clsx('group relative rounded-full', canEditInfo && 'cursor-pointer')}>
            {group && !group.avatarUrl ? (
              <span className="bg-brand-gradient inline-flex size-28 items-center justify-center rounded-full text-white shadow-float">
                <Users className="size-12" aria-hidden />
              </span>
            ) : (
              <Avatar name={title} src={group?.avatarUrl ?? peer?.avatarUrl} size={112} className="shadow-float" />
            )}
            {canEditInfo && (
              <>
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="size-7" />
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  aria-label={locale === 'bn' ? 'গ্রুপের ছবি বদলান' : 'Change group photo'}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    try {
                      const mediaId = await uploadPhoto(file, 'group_avatar');
                      await patchGroup({ avatarMediaId: mediaId });
                    } catch (error) {
                      fail(error);
                    }
                  }}
                />
              </>
            )}
          </label>
          <h3 className="mt-4 text-xl font-extrabold">{title}</h3>
          <p className="mt-1 text-sm text-muted">{group ? s.members.replace('{n}', String(group.memberCount)) : peer ? `@${peer.username}` : ''}</p>
          {canEditInfo && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-4"
              leading={<Pencil className="size-4" aria-hidden />}
              onClick={() => {
                setName(group!.name);
                setDescription(group!.description);
                setEditingInfo(true);
              }}
            >
              {s.edit}
            </Button>
          )}
        </div>

        {(group?.description || peer?.about) && (
          <Section title={group ? (locale === 'bn' ? 'বিবরণ' : 'Description') : s.about}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{group?.description || peer?.about}</p>
          </Section>
        )}

        <Section title={s.disappearing} icon={<Clock className="size-4" />}>
          <Segmented
            label={s.disappearing}
            value={String(disappearing)}
            onChange={async (value) => {
              try {
                await api(`/chat/conversations/${conversationId}/disappearing`, { method: 'PUT', body: { seconds: Number(value) || null } });
                await engine.reload(conversationId);
              } catch (error) {
                fail(error);
              }
            }}
            options={[
              { value: '0', label: s.off },
              { value: '86400', label: s.hours24 },
              { value: '604800', label: s.days7 },
              { value: '7776000', label: s.days90 },
            ]}
          />
        </Section>

        {!group && (
          <Section title={s.safety} icon={<ShieldCheck className="size-4" />}>
            <button onClick={() => void showSafety()} className="text-left text-sm leading-relaxed text-muted hover:text-text">
              {s.verifyCode}
            </button>
          </Section>
        )}

        {group && isAdmin && (
          <Section title={s.groupSettings}>
            <div className="space-y-4">
              {[
                { label: s.onlyAdminsSend, value: group.sendPolicy === 'admins', body: (v: boolean) => ({ sendPolicy: v ? 'admins' : 'all' }) },
                { label: s.onlyAdminsEdit, value: group.editInfoPolicy === 'admins', body: (v: boolean) => ({ editInfoPolicy: v ? 'admins' : 'all' }) },
                { label: s.approveMembers, value: group.approvalRequired, body: (v: boolean) => ({ approvalRequired: v }) },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium">{row.label}</span>
                  <Switch checked={row.value} label={row.label} onChange={(v) => void patchGroup(row.body(v))} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {group && (
          <Section title={s.members.replace('{n}', String(members.length))}>
            <div className="-mx-3 space-y-0.5">
              {(isAdmin || group.addMemberPolicy === 'all') && conversation.active && (
                <button onClick={() => setAdding(true)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-surface-2">
                  <span className="bg-brand-gradient inline-flex size-10 items-center justify-center rounded-full text-white">
                    <UserPlus className="size-5" aria-hidden />
                  </span>
                  <span className="font-semibold">{s.addParticipants}</span>
                </button>
              )}
              {isAdmin && conversation.active && (
                <button
                  onClick={async () => {
                    try {
                      const { code } = await api<{ code: string }>(`/chat/groups/${conversationId}/invite-link`, { method: 'POST', body: {} });
                      await navigator.clipboard.writeText(`${window.location.origin}/join/${code}`);
                      toast(s.linkCopied, 'success');
                    } catch (error) {
                      fail(error);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span className="inline-flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Link2 className="size-5" aria-hidden />
                  </span>
                  <span className="font-semibold">{s.inviteLink}</span>
                </button>
              )}
              {members.map((member) => {
                const profile = state.profiles[member.userId];
                const self = member.userId === me;
                return (
                  <div key={member.userId} className="flex items-center gap-3 rounded-2xl px-3 py-2 hover:bg-surface-2">
                    <Avatar name={nameOf(state, member.userId)} src={profile?.avatarUrl} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{self ? s.you : nameOf(state, member.userId)}</p>
                      <p className="truncate text-xs text-subtle">{profile?.about || (profile ? `@${profile.username}` : '')}</p>
                    </div>
                    {member.role !== 'member' && (
                      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[0.7rem] font-bold text-brand">{member.role === 'owner' ? s.owner : s.admin}</span>
                    )}
                    {isAdmin && !self && member.role !== 'owner' && (
                      <Menu
                        label={s.info}
                        trigger={(props) => (
                          <IconButton label={s.info} className="size-8" {...props}>
                            <MoreVertical className="size-4" />
                          </IconButton>
                        )}
                        items={[
                          {
                            label: member.role === 'admin' ? s.dismissAdmin : s.makeAdmin,
                            icon: <ShieldCheck />,
                            onSelect: async () => {
                              try {
                                await api(`/chat/groups/${conversationId}/members/${member.userId}/role`, { method: 'PUT', body: { role: member.role === 'admin' ? 'member' : 'admin' } });
                                await engine.reload(conversationId);
                              } catch (error) {
                                fail(error);
                              }
                            },
                          },
                          {
                            label: s.remove,
                            icon: <Trash2 />,
                            danger: true,
                            onSelect: async () => {
                              try {
                                await api(`/chat/groups/${conversationId}/members/${member.userId}`, { method: 'DELETE' });
                                await engine.reload(conversationId);
                              } catch (error) {
                                fail(error);
                              }
                            },
                          },
                        ]}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        <div className="space-y-1 px-3 py-4">
          {!group && peer && (
            <button
              onClick={async () => {
                try {
                  await api(`/users/me/blocks/${peer.id}`, { method: peer.blockedByMe ? 'DELETE' : 'PUT' });
                  await engine.refreshProfile(peer.id);
                } catch (error) {
                  fail(error);
                }
              }}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left font-semibold text-danger hover:bg-danger-soft"
            >
              <Ban className="size-5" aria-hidden />
              {peer.blockedByMe ? s.unblock : `${s.block} ${peer.displayName}`}
            </button>
          )}
          {!group && peer && (
            <button onClick={() => setReporting(true)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left font-semibold text-danger hover:bg-danger-soft">
              <Flag className="size-5" aria-hidden />
              {locale === 'bn' ? `${peer.displayName}-কে রিপোর্ট` : `Report ${peer.displayName}`}
            </button>
          )}
          {!group && peer && (
            <ReportDialog open={reporting} onClose={() => setReporting(false)} userId={peer.id} name={peer.displayName} onBlocked={() => void engine.refreshProfile(peer.id).catch(() => {})} />
          )}
          {group && conversation.active && (
            <button onClick={() => setLeaving(true)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left font-semibold text-danger hover:bg-danger-soft">
              <LogOut className="size-5" aria-hidden />
              {s.leaveGroup}
            </button>
          )}
        </div>
      </div>

      {group && (
        <NewChatDialog open={adding} onClose={() => setAdding(false)} onOpened={() => {}} addTo={{ conversationId, existing: members.map((m) => m.userId) }} />
      )}

      <Dialog open={editingInfo} onClose={() => setEditingInfo(false)} title={s.groupInfo}>
        <form
          className="space-y-4 px-5 pb-5"
          onSubmit={async (event) => {
            event.preventDefault();
            await patchGroup({ name: name.trim(), description: description.trim() });
            setEditingInfo(false);
          }}
        >
          <TextField label={s.groupName} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">{locale === 'bn' ? 'বিবরণ' : 'Description'}</span>
            <textarea value={description} maxLength={2048} rows={4} onChange={(e) => setDescription(e.target.value)} className="w-full resize-none rounded-2xl border border-border-strong bg-surface px-4 py-3 outline-none focus:border-brand focus:ring-4 focus:ring-[var(--ring)]" />
          </label>
          <Button type="submit" block disabled={!name.trim()}>
            {locale === 'bn' ? 'সংরক্ষণ করুন' : 'Save'}
          </Button>
        </form>
      </Dialog>

      <Dialog open={leaving} onClose={() => setLeaving(false)} title={s.leaveConfirm}>
        <div className="flex gap-2 px-5 pb-5">
          <Button variant="outline" className="flex-1" onClick={() => setLeaving(false)}>
            {s.cancel}
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            onClick={async () => {
              try {
                await api(`/chat/groups/${conversationId}/members/${me}`, { method: 'DELETE' });
                await engine.reload(conversationId);
                setLeaving(false);
                onLeft();
              } catch (error) {
                fail(error);
              }
            }}
          >
            {s.leaveGroup}
          </Button>
        </div>
      </Dialog>

      <Dialog open={!!safety} onClose={() => setSafety(null)} title={s.safety}>
        <div className="px-5 pb-6 text-center">
          <ShieldCheck className="mx-auto size-12 text-success" aria-hidden />
          <p className="mt-4 font-mono text-lg leading-loose tracking-wider">{safety}</p>
          <p className="mt-4 text-sm text-muted">
            {locale === 'bn'
              ? `এই নম্বরটি ${title}-এর ফোনে দেখানো নম্বরের সাথে মিলিয়ে দেখুন। মিললে আপনাদের মেসেজ নিরাপদ।`
              : `Compare this number with the one on ${title}'s screen. If they match, your messages are secure.`}
          </p>
        </div>
      </Dialog>
    </motion.aside>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={clsx('border-t-8 border-surface-2 px-6 py-5')}>
      <h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}
