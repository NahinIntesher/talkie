'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, OtpVerified } from '@talkie/contracts';
import { api, refreshSession, tokenStore } from './api';

type Status = 'loading' | 'signed_out' | 'signed_in';

interface Session {
  status: Status;
  user: Me | null;
  /** Called after a successful code check or sign-up. */
  signedIn: (result: Extract<OtpVerified, { status: 'signed_in' }>) => void;
  signOut: () => Promise<void>;
  updateUser: (patch: Partial<Me>) => void;
}

const Context = createContext<Session | null>(null);

async function loadMe(): Promise<Me> {
  const [{ profile }, account] = await Promise.all([
    api<{ profile: Omit<Me, 'email' | 'role'> }>('/users/me'),
    api<{ email: string; role: Me['role'] }>('/auth/account'),
  ]);
  return { ...profile, email: account.email, role: account.role };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<Me | null>(null);

  useEffect(() => {
    tokenStore.onSignedOut(() => {
      tokenStore.set(null);
      setUser(null);
      setStatus('signed_out');
    });
    let cancelled = false;
    (async () => {
      if (!(await refreshSession())) {
        if (!cancelled) setStatus('signed_out');
        return;
      }
      try {
        const me = await loadMe();
        if (cancelled) return;
        setUser(me);
        setStatus('signed_in');
      } catch {
        if (!cancelled) setStatus('signed_out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the access token fresh while the tab is open (tokens live 15 minutes).
  useEffect(() => {
    if (status !== 'signed_in') return;
    const timer = setInterval(() => void refreshSession(), 12 * 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void refreshSession();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status]);

  const signedIn = useCallback((result: Extract<OtpVerified, { status: 'signed_in' }>) => {
    tokenStore.set(result.tokens);
    setUser(result.user);
    setStatus('signed_in');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}
    tokenStore.set(null);
    setUser(null);
    setStatus('signed_out');
  }, []);

  const updateUser = useCallback((patch: Partial<Me>) => setUser((current) => (current ? { ...current, ...patch } : current)), []);

  const value = useMemo(() => ({ status, user, signedIn, signOut, updateUser }), [status, user, signedIn, signOut, updateUser]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): Session {
  const value = useContext(Context);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
