'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, AtSign, Check, Loader2, Search, UserPlus, Users } from 'lucide-react';
import { GROUP_NAME_MAX } from '@talkie/contracts';
import { Avatar, Button, TextField } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useChat, type Profile } from '@/lib/chat/store';
import { chatStrings } from '@/lib/chat/strings';
import * as engine from '@/lib/chat/engine';

type Mode = 'pick' | 'group-members' | 'group-name';

/** New chat: find someone by username or pick a contact; or build a new group in two steps. */
export function NewChatDialog({
  open,
  initialQuery,
  addTo,
  onClose,
  onOpened,
}: {
  open: boolean;
  initialQuery?: string;
  /** When set, the dialog adds people to this existing group instead. */
  addTo?: { conversationId: string; existing: string[] };
  onClose: () => void;
  onOpened: (conversationId: string) => void;
}) {
  const { locale } = useI18n();
  const s = chatStrings(locale);
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(addTo ? 'group-members' : 'pick');
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<Profile[] | null>(null);
  const [found, setFound] = useState<Profile | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Profile[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(addTo ? 'group-members' : 'pick');
    setQuery(initialQuery ?? '');
    setSelected([]);
    setName('');
    setFound(null);
    api<{ contacts: Profile[] }>('/users/me/contacts')
      .then(({ contacts: list }) => {
        setContacts(list);
        useChat.setState((state) => ({ profiles: { ...state.profiles, ...Object.fromEntries(list.map((p) => [p.id, p])) } }));
      })
      .catch(() => setContacts([]));
  }, [open, initialQuery, addTo]);

  // Exact username lookup as you type (debounced).
  useEffect(() => {
    const username = query.trim().replace(/^@/, '').toLowerCase();
    setFound(null);
    if (!/^[a-z0-9._]{3,32}$/.test(username)) return;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const { user } = await api<{ user: Profile }>(`/users/by-username/${encodeURIComponent(username)}`);
        if (user.id !== useChat.getState().me?.userId) setFound(user);
      } catch {
        setFound(null);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    const list = (contacts ?? []).filter((c) => !addTo?.existing.includes(c.id));
    return q ? list.filter((c) => `${c.displayName} ${c.nickname ?? ''} ${c.username}`.toLowerCase().includes(q)) : list;
  }, [contacts, query, addTo]);

  const people = found && !filtered.some((c) => c.id === found.id) && !addTo?.existing.includes(found.id) ? [found, ...filtered] : filtered;

  const openDirect = async (person: Profile) => {
    setBusy(true);
    try {
      useChat.setState((state) => ({ profiles: { ...state.profiles, [person.id]: person } }));
      const id = await engine.startDirect(person.id);
      onOpened(id);
      onClose();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : s.failed, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (person: Profile) => setSelected((list) => (list.some((p) => p.id === person.id) ? list.filter((p) => p.id !== person.id) : [...list, person]));

  const finishGroup = async () => {
    setBusy(true);
    try {
      if (addTo) {
        const result = await api<{ added: string[]; notAdded: string[] }>(`/chat/groups/${addTo.conversationId}/members`, { method: 'POST', body: { userIds: selected.map((p) => p.id) } });
        if (result.notAdded.length) toast(s.notAdded, 'info');
        await engine.reload(addTo.conversationId);
        onClose();
        return;
      }
      const result = await engine.createGroup(name.trim(), selected.map((p) => p.id));
      if (result.notAdded.length) toast(s.notAdded, 'info');
      onOpened(result.conversation.id);
      onClose();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : s.failed, 'error');
    } finally {
      setBusy(false);
    }
  };

  const title = addTo ? s.addParticipants : mode === 'pick' ? s.newChat : mode === 'group-members' ? s.addMembers : s.newGroup;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <AnimatePresence mode="wait" initial={false}>
        {mode !== 'group-name' ? (
          <motion.div key="people" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex min-h-0 flex-1 flex-col">
            <div className="px-5 pb-3">
              <label className="flex h-11 items-center gap-2.5 rounded-2xl bg-surface-2 px-4 focus-within:ring-4 focus-within:ring-[var(--ring)]">
                <Search className="size-[1.1rem] text-subtle" aria-hidden />
                <span className="sr-only">{s.searchPeople}</span>
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={s.searchPeople} autoCapitalize="none" spellCheck={false} className="h-full flex-1 bg-transparent outline-none placeholder:text-subtle" />
                {searching && <Loader2 className="size-4 animate-spin text-subtle" aria-hidden />}
              </label>
              {selected.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {selected.map((person) => (
                    <button key={person.id} onClick={() => toggle(person)} className="flex items-center gap-1.5 rounded-full bg-brand-soft py-1 pr-3 pl-1 text-sm font-semibold text-brand">
                      <Avatar name={person.displayName} src={person.avatarUrl} size={24} />
                      {person.displayName.split(' ')[0]} ✕
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="scrollbar-thin min-h-48 flex-1 overflow-y-auto px-3 pb-3">
              {mode === 'pick' && !query && (
                <button onClick={() => setMode('group-members')} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2">
                  <span className="bg-brand-gradient inline-flex size-11 items-center justify-center rounded-full text-on-brand">
                    <Users className="size-5" aria-hidden />
                  </span>
                  <span className="font-semibold">{s.newGroup}</span>
                </button>
              )}
              {!!people.length && <p className="px-3 pt-3 pb-1 text-xs font-bold tracking-wide text-subtle uppercase">{found && people[0] === found ? 'Talkie' : s.contacts}</p>}
              {people.map((person) => {
                const chosen = selected.some((p) => p.id === person.id);
                return (
                  <button
                    key={person.id}
                    disabled={busy}
                    onClick={() => (mode === 'pick' ? void openDirect(person) : toggle(person))}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="relative">
                      <Avatar name={person.displayName} src={person.avatarUrl} size={44} />
                      {chosen && (
                        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-brand-gradient absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full border-2 border-surface text-on-brand">
                          <Check className="size-3" strokeWidth={3} />
                        </motion.span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{person.nickname || person.displayName}</span>
                      <span className="block truncate text-sm text-subtle">{person.about || `@${person.username}`}</span>
                    </span>
                    {mode === 'pick' && !person.isContact && <UserPlus className="size-4 text-subtle" aria-hidden />}
                  </button>
                );
              })}
              {contacts !== null && !people.length && (
                <div className="flex flex-col items-center px-6 py-10 text-center text-sm text-muted">
                  <AtSign className="mb-3 size-8 text-subtle" aria-hidden />
                  {query ? (locale === 'bn' ? 'পুরো ইউজারনেম লিখে খুঁজুন।' : 'Type someone’s full username to find them.') : s.noContacts}
                </div>
              )}
            </div>

            {mode === 'group-members' && (
              <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
                {addTo ? (
                  <span />
                ) : (
                  <Button variant="ghost" size="sm" leading={<ArrowLeft className="size-4" aria-hidden />} onClick={() => setMode('pick')}>
                    {s.cancel}
                  </Button>
                )}
                <span className="text-sm text-muted">{s.selected.replace('{n}', String(selected.length))}</span>
                <Button size="sm" disabled={!selected.length && !!addTo} loading={busy} trailing={<ArrowRight className="size-4" aria-hidden />} onClick={() => (addTo ? void finishGroup() : setMode('group-name'))}>
                  {addTo ? s.addParticipants : s.next}
                </Button>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.form
            key="name"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-5 px-5 pb-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void finishGroup();
            }}
          >
            <div className="flex justify-center pt-2">
              <span className="bg-brand-gradient inline-flex size-24 items-center justify-center rounded-full text-on-brand shadow-float">
                <Users className="size-10" aria-hidden />
              </span>
            </div>
            <TextField label={s.groupName} placeholder={s.groupNamePlaceholder} value={name} maxLength={GROUP_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} hint={`${name.length}/${GROUP_NAME_MAX}`} />
            <div className="flex -space-x-2">
              {selected.slice(0, 10).map((person) => (
                <Avatar key={person.id} name={person.displayName} src={person.avatarUrl} size={36} className="ring-2 ring-surface" />
              ))}
              {selected.length > 10 && <span className="inline-flex size-9 items-center justify-center rounded-full bg-surface-3 text-xs font-bold ring-2 ring-surface">+{selected.length - 10}</span>}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setMode('group-members')} leading={<ArrowLeft className="size-4" aria-hidden />}>
                {s.addMembers}
              </Button>
              <Button type="submit" className={clsx('flex-1')} loading={busy} disabled={!name.trim()}>
                {s.create}
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </Dialog>
  );
}
