import type { MetadataRoute } from 'next';

/** Lets people install Talkie from the browser ("Add to home screen") with the proper icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Talkie',
    short_name: 'Talkie',
    description: 'End-to-end encrypted messaging, calls and meetings.',
    start_url: '/app',
    display: 'standalone',
    background_color: '#f6f7fb',
    theme_color: '#F59E0B',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
