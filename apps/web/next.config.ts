import type { NextConfig } from 'next';

// In development the browser talks to each service through these rewrites (same origin, like Nginx in production).
const services: Record<string, number> = { auth: 4101, users: 4102, chat: 4103, media: 4105, meet: 4106, notify: 4107, admin: 4108 };

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@talkie/contracts', '@talkie/e2ee'],
  experimental: { optimizePackageImports: ['lucide-react', 'motion'] },
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return Object.entries(services).map(([name, port]) => ({
      source: `/api/${name}/:path*`,
      destination: `http://127.0.0.1:${port}/${name}/:path*`,
    }));
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
