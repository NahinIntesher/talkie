'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  Laptop,
  Lock,
  MessageCircle,
  Mic,
  MonitorUp,
  Phone,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Hand,
  CircleDashed,
} from 'lucide-react';
import { Avatar, Button, Logo } from '@/components/ui/primitives';
import { PreferenceControls } from '@/components/ui/preferences';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const enter = { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 } };
const rise = { initial: { opacity: 0, y: 24 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-60px' } };

export default function Landing() {
  const { t, locale } = useI18n();
  const { status } = useSession();
  const signedIn = status === 'signed_in';
  const features = [
    { icon: MessageCircle, ...t.features.chat, tone: 'from-amber-400 to-orange-500' },
    { icon: Users, ...t.features.groups, tone: 'from-orange-400 to-rose-500' },
    { icon: Phone, ...t.features.calls, tone: 'from-sky-500 to-indigo-500' },
    { icon: Video, ...t.features.meet, tone: 'from-fuchsia-500 to-pink-500' },
    { icon: CircleDashed, ...t.features.status, tone: 'from-emerald-500 to-teal-500' },
    { icon: Laptop, ...t.features.devices, tone: 'from-amber-500 to-orange-500' },
  ];

  return (
    <div className="ambient min-h-dvh overflow-x-clip">
      {/* Header */}
      <header className="sticky top-0 z-40">
        <div className="glass border-b border-border/60">
          <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6" aria-label="Main">
            <Link href="/" aria-label="Talkie home">
              <Logo />
            </Link>
            <div className="hidden items-center gap-1 md:flex">
              {[
                ['#features', t.nav.features],
                ['#meetings', t.nav.meetings],
                ['#security', t.nav.security],
              ].map(([href, label]) => (
                <a key={href} href={href} className="rounded-xl px-3.5 py-2 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-text">
                  {label}
                </a>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <PreferenceControls />
              <Link href={signedIn ? '/app' : '/signin'} className="hidden sm:block">
                <Button size="sm">{signedIn ? t.nav.openApp : t.nav.getStarted}</Button>
              </Link>
            </div>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="grid-fade pointer-events-none absolute inset-0 -z-0 opacity-60" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24 lg:pb-28">
          <div>
            <motion.div {...enter} transition={{ delay: 0.05 }} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3.5 py-1.5 text-sm font-semibold text-muted shadow-soft">
              <Sparkles className="size-4 text-brand" aria-hidden />
              {t.hero.badge}
            </motion.div>
            <motion.h1
              {...enter}
              transition={{ delay: 0.12 }}
              className={`mt-6 text-[2.6rem] leading-[1.08] font-extrabold tracking-tight sm:text-6xl ${locale === 'bn' ? 'leading-[1.25]' : ''}`}
            >
              {t.hero.title1}
              <br />
              <span className="text-gradient">{t.hero.title2}</span>
            </motion.h1>
            <motion.p {...enter} transition={{ delay: 0.2 }} className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              {t.hero.subtitle}
            </motion.p>
            <motion.div {...enter} transition={{ delay: 0.28 }} className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href={signedIn ? '/app' : '/signin'}>
                <Button size="lg" block trailing={<ArrowRight className="size-5" aria-hidden />}>
                  {signedIn ? t.nav.openApp : t.hero.primary}
                </Button>
              </Link>
              <Link href={signedIn ? '/app' : '/signin'}>
                <Button size="lg" variant="outline" block leading={<Video className="size-5" aria-hidden />}>
                  {t.hero.secondary}
                </Button>
              </Link>
            </motion.div>
            <motion.p {...enter} transition={{ delay: 0.34 }} className="mt-6 flex items-center gap-2 text-sm text-subtle">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              {t.hero.trust}
            </motion.p>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-20 sm:px-6">
        <motion.h2 {...rise} className="mx-auto max-w-3xl text-center text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t.features.heading}
        </motion.h2>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <motion.article
              key={feature.title}
              {...rise}
              transition={{ delay: index * 0.06 }}
              className="group rounded-3xl border border-border bg-surface p-7 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-float"
            >
              <span className={`inline-flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br ${feature.tone} text-white shadow-card transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}>
                <feature.icon className="size-6" aria-hidden />
              </span>
              <h3 className="mt-5 text-lg font-bold">{feature.title}</h3>
              <p className="mt-2 leading-relaxed text-muted">{feature.body}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* Meetings */}
      <section id="meetings" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-10 sm:px-6">
        <motion.div {...rise} className="relative overflow-hidden rounded-[2rem] bg-[#0b0d1a] p-6 text-white shadow-float sm:p-10">
          <div className="pointer-events-none absolute -top-40 -right-20 size-[28rem] rounded-full bg-amber-500/25 blur-3xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-40 -left-20 size-[26rem] rounded-full bg-orange-600/20 blur-3xl" aria-hidden />
          <div className="relative grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm font-semibold">
                <Video className="size-4" aria-hidden /> {t.features.meet.title}
              </span>
              <h2 className="mt-5 text-3xl font-extrabold tracking-tight sm:text-4xl">{t.brand.tagline}</h2>
              <p className="mt-4 text-lg leading-relaxed text-white/70">{t.features.meet.body}</p>
            </div>
            <MeetingPreview />
          </div>
        </motion.div>
      </section>

      {/* Security */}
      <section id="security" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-20 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <motion.div {...rise}>
            <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-success-soft text-success">
              <Lock className="size-7" aria-hidden />
            </span>
            <h2 className="mt-6 text-3xl font-extrabold tracking-tight sm:text-4xl">{t.security.heading}</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">{t.security.body}</p>
          </motion.div>
          <ul className="grid gap-3">
            {t.security.points.map((point, index) => (
              <motion.li key={point} {...rise} transition={{ delay: index * 0.07 }} className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-5 shadow-soft">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  <Check className="size-5" aria-hidden />
                </span>
                <span className="font-semibold">{point}</span>
              </motion.li>
            ))}
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <motion.div {...rise} className="bg-brand-gradient relative overflow-hidden rounded-[2rem] px-6 py-14 text-center text-on-brand shadow-float sm:px-12">
          <div className="grid-fade pointer-events-none absolute inset-0 opacity-20" aria-hidden />
          <h2 className="relative text-3xl font-extrabold tracking-tight sm:text-4xl">{t.cta.title}</h2>
          <p className="relative mt-3 text-lg text-white/85">{t.cta.body}</p>
          <Link href={signedIn ? '/app' : '/signin'} className="relative mt-8 inline-block">
            <Button size="lg" variant="secondary" className="!bg-white !text-[#3730a3] hover:!bg-white/90" trailing={<ArrowRight className="size-5" aria-hidden />}>
              {signedIn ? t.nav.openApp : t.cta.button}
            </Button>
          </Link>
        </motion.div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-subtle sm:flex-row sm:px-6">
          <Logo className="text-text" />
          <p>© {new Date().getFullYear()} Talkie. {t.footer.rights}</p>
          <div className="flex gap-5">
            <a href="#" className="hover:text-text">{t.footer.privacy}</a>
            <a href="#" className="hover:text-text">{t.footer.terms}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Product mock-up made from real UI parts: a chat window with a floating call card. */
function HeroPreview() {
  const { locale } = useI18n();
  const bn = locale === 'bn';
  const messages = [
    { me: false, text: bn ? 'আজকের মিটিং কি ৪টায়? 🙂' : 'Is today’s meeting at 4? 🙂', time: '3:41' },
    { me: true, text: bn ? 'হ্যাঁ! লিংক পাঠাচ্ছি' : 'Yes! Sending the link', time: '3:42' },
    { me: true, text: 'talkie.kodofact.com/meet/abc-defg-hij', time: '3:42', link: true },
    { me: false, text: bn ? 'দারুণ, দেখা হচ্ছে 👋' : 'Perfect, see you there 👋', time: '3:43' },
  ];
  return (
    <motion.div initial={{ opacity: 0, y: 30, rotate: -1 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: 0.25, type: 'spring', stiffness: 120, damping: 18 }} className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-brand-gradient opacity-25 blur-3xl" />
      <div className="overflow-hidden rounded-[2rem] border border-border bg-surface shadow-float">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Avatar name="Ayesha Rahman" size={42} />
          <div className="min-w-0 flex-1">
            <p className="font-bold">Ayesha Rahman</p>
            <p className="text-sm font-medium text-success">{bn ? 'টাইপ করছে…' : 'typing…'}</p>
          </div>
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted"><Phone className="size-5" /></span>
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted"><Video className="size-5" /></span>
        </div>
        <div className="space-y-2.5 bg-surface-2/60 px-4 py-5">
          <div className="mx-auto mb-3 flex w-fit items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-semibold text-subtle shadow-soft">
            <Lock className="size-3" /> {bn ? 'এন্ড-টু-এন্ড এনক্রিপ্টেড' : 'End-to-end encrypted'}
          </div>
          {messages.map((message, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.55 + index * 0.35 }}
              className={`flex ${message.me ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[0.93rem] shadow-soft ${message.me ? 'rounded-br-md bg-[var(--bubble-out)] text-[var(--bubble-out-text)]' : 'rounded-bl-md bg-surface'}`}>
                <span className={message.link ? 'underline decoration-white/60 underline-offset-2' : ''}>{message.text}</span>
                <span className={`ml-2 inline-flex items-center gap-0.5 align-bottom text-[0.7rem] ${message.me ? 'text-white/75' : 'text-subtle'}`}>
                  {message.time}
                  {message.me && <CheckCheck className="size-3.5" />}
                </span>
              </div>
            </motion.div>
          ))}
          <div className="flex items-center gap-1 pt-1 pl-1">
            {[0, 1, 2].map((dot) => (
              <motion.span key={dot} className="size-2 rounded-full bg-subtle/70" animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity, duration: 1, delay: dot * 0.15 }} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <div className="h-11 flex-1 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-subtle">{bn ? 'মেসেজ লিখুন' : 'Message'}</div>
          <span className="bg-brand-gradient inline-flex size-11 items-center justify-center rounded-2xl text-on-brand shadow-card"><Mic className="size-5" /></span>
        </div>
      </div>
      <motion.div
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 2.1 }}
        className="glass absolute -bottom-8 -left-6 flex items-center gap-3 rounded-2xl border border-border p-3 pr-4 shadow-float sm:-left-12"
      >
        <span className="relative">
          <Avatar name="Tanvir Hasan" size={44} />
          <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-2 border-surface bg-success" />
        </span>
        <div>
          <p className="text-sm font-bold">Tanvir Hasan</p>
          <p className="text-xs text-subtle">{bn ? 'ভিডিও কল আসছে…' : 'Incoming video call…'}</p>
        </div>
        <span className="ml-2 inline-flex size-9 items-center justify-center rounded-full bg-danger text-white"><Phone className="size-4 rotate-[135deg]" /></span>
        <motion.span animate={{ scale: [1, 1.12, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} className="inline-flex size-9 items-center justify-center rounded-full bg-success text-white">
          <Video className="size-4" />
        </motion.span>
      </motion.div>
    </motion.div>
  );
}

function MeetingPreview() {
  const people = ['Nusrat Jahan', 'Rafiq Ahmed', 'Mitu Akter', 'Sabbir Khan', 'Farhana Islam', 'Imran Hossain'];
  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-3 backdrop-blur" aria-hidden>
      <div className="grid grid-cols-3 gap-2">
        {people.map((name, index) => (
          <div key={name} className={`relative aspect-video overflow-hidden rounded-2xl bg-gradient-to-br ${['from-indigo-900 to-slate-900', 'from-violet-900 to-slate-900', 'from-fuchsia-900 to-slate-900', 'from-sky-900 to-slate-900', 'from-emerald-900 to-slate-900', 'from-rose-900 to-slate-900'][index]} ${index === 0 ? 'ring-2 ring-emerald-400' : ''}`}>
            <div className="absolute inset-0 flex items-center justify-center">
              <Avatar name={name} size={38} />
            </div>
            <span className="absolute bottom-1.5 left-2 text-[0.65rem] font-semibold text-white/90">{name.split(' ')[0]}</span>
            {index === 2 && <Hand className="absolute top-1.5 right-1.5 size-4 text-amber-300" />}
            {index === 4 && <MonitorUp className="absolute top-1.5 right-1.5 size-4 text-sky-300" />}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        {[Mic, Video, MonitorUp, Hand].map((Icon, index) => (
          <span key={index} className="inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white">
            <Icon className="size-4.5" />
          </span>
        ))}
        <span className="inline-flex h-10 items-center rounded-full bg-red-500 px-5 text-white">
          <Phone className="size-4.5 rotate-[135deg]" />
        </span>
      </div>
    </div>
  );
}
