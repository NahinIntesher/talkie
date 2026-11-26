'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { Users } from 'lucide-react';
import { Button, Logo } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Invite {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  memberCount: number;
  approvalRequired: boolean;
}

/** Group invite link: preview the group, then join (or ask to join when admins approve members). */
export default function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { locale } = useI18n();
  const { status } = useSession();
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const bn = locale === 'bn';

  useEffect(() => {
    if (status !== 'signed_in') return;
    api<{ group: Invite }>(`/chat/invites/${encodeURIComponent(code)}`)
      .then(({ group }) => setInvite(group))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Error'));
  }, [code, status]);

  return (
    <div className="ambient flex min-h-dvh flex-col items-center justify-center px-4">
      <Link href="/" className="mb-8">
        <Logo />
      </Link>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass w-full max-w-sm rounded-[2rem] border border-border p-8 text-center shadow-float">
        <span className="bg-brand-gradient mx-auto inline-flex size-24 items-center justify-center rounded-full text-on-brand shadow-float">
          <Users className="size-10" aria-hidden />
        </span>
        {status === 'signed_out' ? (
          <>
            <h1 className="mt-6 text-xl font-extrabold">{bn ? 'গ্রুপে যোগ দিতে সাইন ইন করুন' : 'Sign in to join this group'}</h1>
            <Link href="/signin" className="mt-6 block">
              <Button block>{bn ? 'সাইন ইন' : 'Sign in'}</Button>
            </Link>
          </>
        ) : error ? (
          <p className="mt-6 font-semibold text-danger">{error}</p>
        ) : !invite ? (
          <div className="mx-auto mt-8 size-8 animate-spin rounded-full border-[3px] border-brand/25 border-t-brand" />
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-extrabold">{invite.name}</h1>
            <p className="mt-1 text-sm text-muted">{bn ? `${invite.memberCount} জন সদস্য` : `${invite.memberCount} members`}</p>
            {invite.description && <p className="mt-4 text-sm leading-relaxed text-muted">{invite.description}</p>}
            {requested ? (
              <p className="mt-6 rounded-2xl bg-brand-soft px-4 py-3 text-sm font-semibold text-brand">{bn ? 'অনুরোধ পাঠানো হয়েছে। অ্যাডমিন অনুমোদন দিলে আপনি যোগ হবেন।' : 'Request sent. You will join when an admin approves.'}</p>
            ) : (
              <Button
                block
                className="mt-6"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api<{ status: 'joined' | 'requested'; conversationId: string }>(`/chat/invites/${encodeURIComponent(code)}/join`, { method: 'POST', body: {} });
                    if (result.status === 'joined') router.replace(`/app?c=${result.conversationId}`);
                    else setRequested(true);
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : 'Error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {invite.approvalRequired ? (bn ? 'যোগ দেওয়ার অনুরোধ' : 'Request to join') : bn ? 'গ্রুপে যোগ দিন' : 'Join group'}
              </Button>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
