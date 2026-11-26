import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Baloo_Da_2, Quicksand } from 'next/font/google';
import { Providers } from './providers';
import { themeScript } from '@/lib/theme';
import './globals.css';

// English in Quicksand, Bangla in Baloo Da 2. Baloo is loaded for the Bengali range only, so every Latin letter, digit
// and symbol stays in Quicksand while Bangla letters fall through to Baloo — in either app language.
const latin = Quicksand({ subsets: ['latin'], variable: '--font-latin', display: 'swap' });
const bangla = Baloo_Da_2({ subsets: ['bengali'], variable: '--font-bangla', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://talkie.kodofact.com'),
  title: { default: 'Talkie — Private messaging and meetings', template: '%s · Talkie' },
  description: 'End-to-end encrypted messaging, voice and video calls, and beautiful meetings — on Android and the web.',
  applicationName: 'Talkie',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: '/apple-touch-icon.png',
  },
  openGraph: { title: 'Talkie', description: 'Talk freely. Meet beautifully.', type: 'website' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#080a14' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const stored = (await cookies()).get('talkie_locale')?.value;
  const locale = stored === 'en' ? 'en' : 'bn';
  return (
    <html lang={locale} className={`${latin.variable} ${bangla.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
