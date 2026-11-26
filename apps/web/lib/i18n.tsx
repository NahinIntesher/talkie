'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'bn' | 'en';

const en = {
  brand: { tagline: 'Talk freely. Meet beautifully.' },
  nav: { features: 'Features', security: 'Security', meetings: 'Meetings', signIn: 'Sign in', getStarted: 'Get started', openApp: 'Open Talkie' },
  hero: {
    badge: 'End-to-end encrypted messaging and HD meetings',
    title1: 'Every conversation,',
    title2: 'beautifully private.',
    subtitle: 'Chat, call and meet in one place. Messages are encrypted on your device, not even Talkie can read them.',
    primary: 'Start for free',
    secondary: 'Join a meeting',
    trust: 'No phone number needed · Works on Android and the web',
  },
  features: {
    heading: 'Everything you love about messaging. And meetings that feel effortless.',
    chat: { title: 'Messaging', body: 'Replies, reactions, voice notes, photos and files up to 2 GB, read receipts and typing, instant on every device.' },
    groups: { title: 'Groups & communities', body: 'Groups up to 1,024 people with admin controls, invite links, polls and mentions.' },
    calls: { title: 'Voice & video calls', body: 'Crystal-clear one-to-one and group calls with screen sharing, end-to-end encrypted.' },
    meet: { title: 'Meetings', body: 'Waiting rooms, co-hosts, polls, Q&A, breakout rooms, whiteboard and recording.' },
    status: { title: 'Status', body: 'Share moments that disappear after 24 hours, only with the people you choose.' },
    devices: { title: 'All your devices', body: 'Use Talkie on your phone and the web at the same time, even when your phone is offline.' },
  },
  security: {
    heading: 'Private by design',
    body: 'Your keys are created on your device and never leave it. We store only encrypted data we cannot open.',
    points: ['End-to-end encryption for chats and calls', 'Email sign-in, no passwords to leak', 'Stolen sessions are detected and signed out', 'You control who sees your last seen, photo and status'],
  },
  cta: { title: 'Ready when you are.', body: 'Create your Talkie in less than a minute.', button: 'Create my account' },
  footer: { rights: 'All rights reserved.', privacy: 'Privacy', terms: 'Terms' },
  auth: {
    welcome: 'Welcome to Talkie',
    emailTitle: 'Sign in or create an account',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    continue: 'Continue',
    codeTitle: 'Check your email',
    codeLabel: 'Verification code',
    changeEmail: 'Change email',
    resend: 'Send a new code',
    resendIn: 'Send a new code in {s}s',
    verifying: 'Checking…',
    attemptsLeft: '{n} attempts left',
    profileTitle: 'Create your profile',
    nameLabel: 'Your name',
    namePlaceholder: 'e.g. Nahin Intesher',
    usernameLabel: 'Username',
    usernameChecking: 'Checking…',
    usernameAvailable: 'Available',
    usernameTaken: 'Already taken',
    usernameReserved: 'Not available',
    create: 'Create account',
    back: 'Back',
    successTitle: 'You are all set!',
  },
  app: {
    chats: 'Chats',
    calls: 'Calls',
    meet: 'Meet',
    status: 'Status',
    settings: 'Settings',
    search: 'Search or start a new chat',
    newChat: 'New chat',
    emptyChatsTitle: 'Your conversations will appear here',
    emptyPaneTitle: 'Talkie for the web',
    comingSoon: 'Arriving in the next update',
    signOut: 'Sign out',
    loading: 'Loading…',
  },
  settings: {
    title: 'Settings',
    profile: 'Profile',
    privacy: 'Privacy',
    devices: 'Linked devices',
    appearance: 'Appearance',
    language: 'Language',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    about: 'About',
    aboutPlaceholder: 'Hey there! I am using Talkie.',
    save: 'Save changes',
    saved: 'Saved',
    lastSeen: 'Last seen',
    online: 'Online',
    profilePhoto: 'Profile photo',
    aboutPrivacy: 'About',
    statusPrivacy: 'Status',
    groupsAdd: 'Who can add me to groups',
    readReceipts: 'Read receipts',
    everyone: 'Everyone',
    contacts: 'My contacts',
    nobody: 'Nobody',
    thisDevice: 'This device',
    lastActive: 'Last active',
    signOutDevice: 'Sign out',
  },
  errors: {
    generic: 'Something went wrong. Please try again.',
    network: 'You seem to be offline. Check your connection.',
  },
};

type Dictionary = typeof en;

const bn: Dictionary = {
  brand: { tagline: 'মন খুলে কথা বলুন। সুন্দরভাবে মিটিং করুন।' },
  nav: { features: 'ফিচার', security: 'নিরাপত্তা', meetings: 'মিটিং', signIn: 'সাইন ইন', getStarted: 'শুরু করুন', openApp: 'Talkie খুলুন' },
  hero: {
    badge: 'এন্ড-টু-এন্ড এনক্রিপ্টেড মেসেজিং ও HD মিটিং',
    title1: 'প্রতিটি কথোপকথন,',
    title2: 'সম্পূর্ণ গোপন।',
    subtitle: 'চ্যাট, কল আর মিটিং, সব এক জায়গায়। মেসেজ আপনার ডিভাইসেই এনক্রিপ্ট হয়, Talkie-ও তা পড়তে পারে না।',
    primary: 'বিনামূল্যে শুরু করুন',
    secondary: 'মিটিংয়ে যোগ দিন',
    trust: 'ফোন নম্বর লাগবে না · Android ও ওয়েবে চলে',
  },
  features: {
    heading: 'মেসেজিংয়ের সব প্রিয় সুবিধা। আর মিটিং, একদম সহজ।',
    chat: { title: 'মেসেজিং', body: 'রিপ্লাই, রিঅ্যাকশন, ভয়েস নোট, ছবি ও ২ GB পর্যন্ত ফাইল, রিড রিসিপ্ট ও টাইপিং, সব ডিভাইসে সাথে সাথে।' },
    groups: { title: 'গ্রুপ ও কমিউনিটি', body: '১,০২৪ জন পর্যন্ত গ্রুপ, অ্যাডমিন কন্ট্রোল, ইনভাইট লিংক, পোল ও মেনশন।' },
    calls: { title: 'ভয়েস ও ভিডিও কল', body: 'ঝকঝকে ওয়ান-টু-ওয়ান ও গ্রুপ কল, স্ক্রিন শেয়ার সহ, এন্ড-টু-এন্ড এনক্রিপ্টেড।' },
    meet: { title: 'মিটিং', body: 'ওয়েটিং রুম, কো-হোস্ট, পোল, প্রশ্নোত্তর, ব্রেকআউট রুম, হোয়াইটবোর্ড ও রেকর্ডিং।' },
    status: { title: 'স্ট্যাটাস', body: '২৪ ঘণ্টা পর মুছে যাওয়া মুহূর্ত শেয়ার করুন, শুধু আপনার বাছাই করা মানুষদের সাথে।' },
    devices: { title: 'সব ডিভাইসে', body: 'ফোন আর ওয়েবে একসাথে Talkie ব্যবহার করুন, ফোন অফলাইন থাকলেও।' },
  },
  security: {
    heading: 'শুরু থেকেই গোপনীয়',
    body: 'আপনার কী আপনার ডিভাইসেই তৈরি হয় এবং সেখানেই থাকে। আমরা শুধু এনক্রিপ্টেড ডেটা রাখি, যা আমরা খুলতে পারি না।',
    points: ['চ্যাট ও কলে এন্ড-টু-এন্ড এনক্রিপশন', 'ইমেইল দিয়ে সাইন ইন, ফাঁস হওয়ার মতো পাসওয়ার্ড নেই', 'চুরি হওয়া সেশন ধরা পড়ে ও সাইন আউট হয়', 'লাস্ট সিন, ছবি ও স্ট্যাটাস কে দেখবে, আপনি ঠিক করেন'],
  },
  cta: { title: 'আপনি প্রস্তুত হলেই শুরু।', body: 'এক মিনিটেরও কম সময়ে আপনার Talkie তৈরি করুন।', button: 'অ্যাকাউন্ট তৈরি করুন' },
  footer: { rights: 'সর্বস্বত্ব সংরক্ষিত।', privacy: 'গোপনীয়তা', terms: 'শর্তাবলি' },
  auth: {
    welcome: 'Talkie-তে স্বাগতম',
    emailTitle: 'সাইন ইন বা নতুন অ্যাকাউন্ট',
    emailLabel: 'ইমেইল ঠিকানা',
    emailPlaceholder: 'you@example.com',
    continue: 'এগিয়ে যান',
    codeTitle: 'আপনার ইমেইল দেখুন',
    codeLabel: 'ভেরিফিকেশন কোড',
    changeEmail: 'ইমেইল বদলান',
    resend: 'নতুন কোড পাঠান',
    resendIn: '{s} সেকেন্ড পর নতুন কোড',
    verifying: 'যাচাই হচ্ছে…',
    attemptsLeft: 'আর {n} বার চেষ্টা করা যাবে',
    profileTitle: 'আপনার প্রোফাইল তৈরি করুন',
    nameLabel: 'আপনার নাম',
    namePlaceholder: 'যেমন: নাহিন ইনতেশার',
    usernameLabel: 'ইউজারনেম',
    usernameChecking: 'দেখা হচ্ছে…',
    usernameAvailable: 'পাওয়া যাচ্ছে',
    usernameTaken: 'আগেই নেওয়া হয়েছে',
    usernameReserved: 'ব্যবহার করা যাবে না',
    create: 'অ্যাকাউন্ট তৈরি করুন',
    back: 'পেছনে',
    successTitle: 'সব ঠিকঠাক!',
  },
  app: {
    chats: 'চ্যাট',
    calls: 'কল',
    meet: 'মিট',
    status: 'স্ট্যাটাস',
    settings: 'সেটিংস',
    search: 'খুঁজুন বা নতুন চ্যাট শুরু করুন',
    newChat: 'নতুন চ্যাট',
    emptyChatsTitle: 'আপনার কথোপকথন এখানে দেখা যাবে',
    emptyPaneTitle: 'ওয়েবে Talkie',
    comingSoon: 'পরের আপডেটে আসছে',
    signOut: 'সাইন আউট',
    loading: 'লোড হচ্ছে…',
  },
  settings: {
    title: 'সেটিংস',
    profile: 'প্রোফাইল',
    privacy: 'গোপনীয়তা',
    devices: 'লিংক করা ডিভাইস',
    appearance: 'চেহারা',
    language: 'ভাষা',
    theme: 'থিম',
    light: 'লাইট',
    dark: 'ডার্ক',
    system: 'সিস্টেম',
    about: 'অ্যাবাউট',
    aboutPlaceholder: 'হ্যালো! আমি Talkie ব্যবহার করছি।',
    save: 'সংরক্ষণ করুন',
    saved: 'সংরক্ষিত',
    lastSeen: 'লাস্ট সিন',
    online: 'অনলাইন',
    profilePhoto: 'প্রোফাইল ছবি',
    aboutPrivacy: 'অ্যাবাউট',
    statusPrivacy: 'স্ট্যাটাস',
    groupsAdd: 'কে আমাকে গ্রুপে যোগ করতে পারবে',
    readReceipts: 'রিড রিসিপ্ট',
    everyone: 'সবাই',
    contacts: 'আমার কন্টাক্ট',
    nobody: 'কেউ না',
    thisDevice: 'এই ডিভাইস',
    lastActive: 'সর্বশেষ সক্রিয়',
    signOutDevice: 'সাইন আউট',
  },
  errors: {
    generic: 'কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।',
    network: 'আপনি অফলাইনে আছেন মনে হচ্ছে। সংযোগ দেখুন।',
  },
};

const dictionaries: Record<Locale, Dictionary> = { en, bn };

interface I18n {
  locale: Locale;
  t: Dictionary;
  setLocale: (locale: Locale) => void;
  /** Replaces {name} placeholders and localizes digits. */
  format: (template: string, values: Record<string, string | number>) => string;
  digits: (value: string | number) => string;
}

const Context = createContext<I18n | null>(null);
const STORAGE_KEY = 'talkie.locale';
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function I18nProvider({ children, initial }: { children: ReactNode; initial: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    document.cookie = `talkie_locale=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const value = useMemo<I18n>(() => {
    const digits = (value: string | number) =>
      locale === 'bn' ? String(value).replace(/\d/g, (d) => BN_DIGITS[Number(d)]!) : String(value);
    return {
      locale,
      t: dictionaries[locale],
      setLocale,
      digits,
      format: (template, values) => template.replace(/\{(\w+)\}/g, (_, key: string) => digits(values[key] ?? '')),
    };
  }, [locale, setLocale]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
