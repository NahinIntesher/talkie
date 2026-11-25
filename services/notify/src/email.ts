import type { Locale } from '@talkie/contracts';

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const copy = {
  en: {
    subject: (code: string) => `${code} is your Talkie code`,
    heading: 'Your sign-in code',
    body: 'Enter this code in Talkie to continue. It expires in 10 minutes.',
    ignore: "If you didn't ask for this code, you can ignore this email. Someone may have typed your address by mistake.",
    never: 'Talkie will never ask you to share this code.',
  },
  bn: {
    subject: (code: string) => `${code} আপনার Talkie কোড`,
    heading: 'আপনার সাইন-ইন কোড',
    body: 'এগিয়ে যেতে Talkie-তে এই কোডটি লিখুন। কোডটি ১০ মিনিটের মধ্যে মেয়াদোত্তীর্ণ হবে।',
    ignore: 'আপনি এই কোড না চাইলে ইমেইলটি উপেক্ষা করুন। হয়তো কেউ ভুল করে আপনার ঠিকানা লিখেছেন।',
    never: 'Talkie কখনো আপনাকে এই কোড কাউকে জানাতে বলবে না।',
  },
} as const;

/** Bilingual, dark-mode-friendly transactional email with a large, copyable code. */
export function otpEmail(code: string, locale: Locale) {
  const t = copy[locale];
  const spaced = escape(code.split('').join(' '));
  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escape(t.subject(code))}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,'Hind Siliguri',Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.08)">
<tr><td style="background:linear-gradient(135deg,#5b5bf7,#8b5cf6 55%,#ec4899);padding:28px 32px">
<div style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ffffff">Talkie</div></td></tr>
<tr><td style="padding:32px">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3">${t.heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569">${t.body}</p>
<div style="font-size:34px;font-weight:800;letter-spacing:.18em;text-align:center;padding:18px 12px;border-radius:14px;background:#eef2ff;color:#3730a3;font-family:'SF Mono',Consolas,monospace">${spaced}</div>
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b">${t.ignore}</p>
<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#64748b"><strong>${t.never}</strong></p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#94a3b8">talkie.kodofact.com</p>
</td></tr></table></body></html>`;
  const text = `${t.heading}\n\n${code}\n\n${t.body}\n\n${t.ignore}\n${t.never}`;
  return { subject: t.subject(code), html, text };
}
