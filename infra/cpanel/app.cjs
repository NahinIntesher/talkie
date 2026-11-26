// Talkie on cPanel → "Setup Node.js App" (Phusion Passenger or LiteSpeed). Application startup file: app.cjs
//
// One Node.js process runs everything that the Docker setup spreads over containers:
//   • a small gateway on the port cPanel gives the app (it does nginx's job: /api/<service>/… and /ws routing),
//   • the eight Talkie services, each on its own 127.0.0.1 port inside this process,
//   • the Next.js web app as one child process.
// Events between services travel in memory (BUS_DRIVER=process); the database is cPanel's MySQL/MariaDB.
// Built by `npm run build:cpanel` (see docs/DEPLOY.md → "cPanel").
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const started = Date.now();
const log = (...parts) => console.log(new Date().toISOString(), '[talkie]', ...parts);

// ───────── Settings: .env next to this file; values set in cPanel's interface win ─────────
(function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
})(path.join(ROOT, '.env'));

// Internal ports: unique per cPanel account (other accounts on the same server use their own range).
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const BASE = Number(process.env.TALKIE_PORT_BASE) || 21000 + (uid % 1500) * 20;
const SERVICES = [
  // name, port offset, Snowflake worker id (distinct, so event ids never collide)
  ['auth', 1, 1],
  ['users', 2, 2],
  ['notify', 7, 7],
  ['chat', 3, 3],
  ['realtime', 4, 4],
  ['media', 5, 5],
  ['meet', 6, 6],
  ['admin', 8, 8],
];
const port = Object.fromEntries(SERVICES.map(([name, offset]) => [name, BASE + offset]));
port.web = BASE;

const shared = {
  // development only for local testing of this bundle (enables DEV_FIXED_OTP); cPanel always runs production.
  NODE_ENV: process.env.NODE_ENV === 'development' ? 'development' : 'production',
  HOST: '127.0.0.1',
  TRUST_PROXY: 'true',
  BUS_DRIVER: process.env.REDIS_URL ? (process.env.BUS_DRIVER || 'redis') : 'process',
  OUTBOX_POLL_MS: process.env.OUTBOX_POLL_MS || '1000',
  JWT_PRIVATE_KEY_FILE: process.env.JWT_PRIVATE_KEY_FILE || path.join(ROOT, 'secrets', 'jwt-private.pem'),
  JWT_PUBLIC_KEY_FILE: process.env.JWT_PUBLIC_KEY_FILE || path.join(ROOT, 'secrets', 'jwt-public.pem'),
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(ROOT, 'data', 'media'),
  // Push notifications: the Firebase service-account key, uploaded as secrets/firebase-service-account.json.
  ...(!process.env.FIREBASE_SERVICE_ACCOUNT && fs.existsSync(path.join(ROOT, 'secrets', 'firebase-service-account.json'))
    ? { FIREBASE_SERVICE_ACCOUNT_FILE: path.join(ROOT, 'secrets', 'firebase-service-account.json') }
    : {}),
  ...Object.fromEntries(SERVICES.map(([name]) => [`${name.toUpperCase()}_URL`, `http://127.0.0.1:${port[name]}`])),
};

// ───────── Gateway ─────────
const API = new Set(['auth', 'users', 'chat', 'media', 'meet', 'notify', 'admin']);

/** Where a request goes: { port, path } or null (blocked). Mirrors infra/nginx/talkie.conf. */
function route(url) {
  const [pathname, query = ''] = url.split(/\?(.*)/s);
  const search = query ? `?${query}` : '';
  if (/^\/internal(\/|$)/.test(pathname) || /^\/api\/[^/]+\/internal(\/|$)/.test(pathname)) return null;
  if (pathname === '/ws' || pathname.startsWith('/ws/')) return { port: port.realtime, path: url };
  const api = /^\/api\/([a-z]+)(\/.*)?$/.exec(pathname);
  if (api) return API.has(api[1]) ? { port: port[api[1]], path: `/${api[1]}${api[2] || '/'}${search}` } : null;
  return { port: port.web, path: url };
}

function forwardedHeaders(req) {
  const remote = req.socket.remoteAddress || '';
  const prior = req.headers['x-forwarded-for'];
  return {
    'x-forwarded-for': prior ? `${prior}, ${remote}` : remote,
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
    'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host || '',
  };
}

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":{"code":"not_found","message":"Not found."}}');
};

const gateway = http.createServer((req, res) => {
  const target = route(req.url || '/');
  if (!target) return notFound(res);
  const upstream = http.request(
    { host: '127.0.0.1', port: target.port, method: req.method, path: target.path, headers: { ...req.headers, ...forwardedHeaders(req) } },
    (reply) => {
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end('{"error":{"code":"unavailable","message":"Talkie is starting. Try again in a moment."}}');
  });
  req.pipe(upstream);
});

// WebSockets (Socket.IO on /ws): pass the upgrade straight through to the realtime service.
gateway.on('upgrade', (req, socket, head) => {
  const target = route(req.url || '/');
  if (!target || target.port !== port.realtime) return socket.destroy();
  const upstream = net.connect(target.port, '127.0.0.1', () => {
    const extra = forwardedHeaders(req);
    let raw = `${req.method} ${target.path} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^x-forwarded-(for|proto|host)$/i.test(req.rawHeaders[i])) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    for (const [name, value] of Object.entries(extra)) raw += `${name}: ${value}\r\n`;
    upstream.write(`${raw}\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

gateway.keepAliveTimeout = 65_000;

// Passenger hands the app its socket through the first listen() call; this must happen before anything else listens.
if (typeof PhusionPassenger !== 'undefined') {
  PhusionPassenger.configure({ autoInstall: false });
  gateway.listen('passenger', () => log('gateway listening (Passenger)'));
} else {
  const publicPort = Number(process.env.PORT) || 3000;
  gateway.listen(publicPort, () => log(`gateway listening on ${publicPort}`));
}

// ───────── Web app (Next.js standalone) ─────────
let stopping = false;
function startWeb() {
  const server = path.join(ROOT, 'web', 'apps', 'web', 'server.js');
  if (!fs.existsSync(server)) return log('web app missing: run `npm run build:cpanel` and upload again');
  const child = spawn(process.execPath, [server], {
    cwd: path.dirname(server),
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port.web), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (stopping) return;
    log(`web app exited (${code}); restarting in 2 s`);
    setTimeout(startWeb, 2000);
  });
  process.on('exit', () => child.kill());
}

// ───────── Services ─────────
async function main() {
  startWeb();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    try {
      const { runMigrations } = await import(pathToFileURL(path.join(ROOT, 'migrate.mjs')).href);
      await runMigrations(path.join(ROOT, 'database'));
      log('database is up to date');
    } catch (error) {
      log('database migration failed — check DB_* settings:', error && error.message);
    }
  }

  // Each service reads its settings while it loads, so the per-service values are set just before its import.
  for (const [name, , worker] of SERVICES) {
    Object.assign(process.env, shared, { PORT: String(port[name]), WORKER_ID: String(worker) });
    try {
      await import(pathToFileURL(path.join(ROOT, 'services', name, 'main.mjs')).href);
      log(`${name} ready on ${port[name]}`);
    } catch (error) {
      log(`${name} failed to start:`, error && (error.stack || error.message));
    }
  }
  log(`all services started in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));
process.on('unhandledRejection', (error) => log('unhandled rejection:', error && (error.stack || error)));

main().catch((error) => log('startup failed:', error && (error.stack || error)));
