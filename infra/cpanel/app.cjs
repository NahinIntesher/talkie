// Talkie on cPanel → "Setup Node.js App" (Phusion Passenger or LiteSpeed). Application startup file: app.cjs
//
// Runs everything that the Docker setup spreads over containers, as three Node.js processes:
//   • this process: a small gateway on the port cPanel gives the app (nginx's job: /api/<service>/… and /ws routing),
//   • child "services": the eight Talkie services, each on its own 127.0.0.1 port,
//   • child "web": the Next.js web app.
// The children are separate processes because LiteSpeed (lsnode) hooks http.Server.listen in the app's own process and
// ignores every listen() after the first one; each child exits when this process goes away (e.g. LiteSpeed idles it).
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
const revisionFile = path.join(ROOT, 'revision.txt');
const revision = fs.existsSync(revisionFile) ? fs.readFileSync(revisionFile, 'utf8').trim() : null;
const started = Date.now();
// Everything is also written to talkie.log in the app folder: LiteSpeed keeps only errors (stderr.log).
const LOG_FILE = path.join(__dirname, 'talkie.log');
try {
  if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
} catch {}
const log = (...parts) => {
  const line = [new Date().toISOString(), `[talkie:${process.argv.includes('--talkie-services') ? 'services' : process.argv.includes('--talkie-web') ? 'web' : 'gateway'}]`, ...parts.map((p) => (typeof p === 'string' ? p : String(p)))].join(' ');
  console.log(line);
  // Children's output is already redirected into talkie.log by the gateway; only the gateway appends itself.
  if (process.argv.includes('--talkie-services') || process.argv.includes('--talkie-web')) return;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
};
const MODE = process.argv.includes('--talkie-services') ? 'services' : process.argv.includes('--talkie-web') ? 'web' : 'gateway';

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

/** GET /api/health: which parts are running (open it in a browser to check the install). */
async function health(res) {
  const probe = (port, path) =>
    new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (reply) => {
        reply.resume();
        resolve(reply.statusCode >= 200 && reply.statusCode < 400 ? 'up' : `error ${reply.statusCode}`);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve('down'));
    });
  // Install checks from the services themselves: LiveKit keys, email login, Firebase key (answers only, no secrets).
  const selfcheck = (name) =>
    new Promise((resolve) => {
      const request = http.get(
        { host: '127.0.0.1', port: port[name], path: '/internal/selfcheck', timeout: 9000, headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' } },
        (reply) => {
          let body = '';
          reply.on('data', (chunk) => (body += chunk));
          reply.on('end', () => {
            try {
              resolve(reply.statusCode === 200 ? JSON.parse(body) : { [name]: `error ${reply.statusCode}` });
            } catch {
              resolve({ [name]: 'unreadable answer' });
            }
          });
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve({ [name]: 'down' }));
    });
  const names = SERVICES.map(([name]) => name);
  const [results, meetCheck, notifyCheck] = await Promise.all([
    Promise.all([...names.map((name) => probe(port[name], '/readyz')), probe(port.web, '/')]),
    selfcheck('meet'),
    selfcheck('notify'),
  ]);
  const body = {
    gateway: 'up',
    revision,
    host: typeof PhusionPassenger !== 'undefined' ? 'passenger' : 'litespeed-or-node',
    uptimeSeconds: Math.round(process.uptime()),
    services: Object.fromEntries(names.map((name, i) => [name, results[i]])),
    web: results[names.length],
    checks: { ...meetCheck, ...notifyCheck },
    node: process.version,
  };
  const ok = Object.values(body.services).every((v) => v === 'up') && body.web === 'up';
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

const gateway = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/api/health') return void health(res);
  const target = route(req.url || '/');
  if (!target) return notFound(res);
  const deadline = Date.now() + 8_000;
  let upstream;
  let pending;
  res.on('close', () => {
    clearTimeout(pending);
    upstream?.destroy();
  });
  const forward = () => {
    if (res.destroyed) return;
    let connected = false;
    upstream = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: target.path, headers: { ...req.headers, ...forwardedHeaders(req) } },
      (reply) => {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.once('socket', (socket) => {
      const pipe = () => {
        connected = true;
        req.pipe(upstream);
      };
      if (socket.connecting) socket.once('connect', pipe);
      else pipe();
    });
    upstream.on('error', (error) => {
      if (res.destroyed) return;
      // No request body was forwarded, so this also works for sends and calls.
      if (!connected && error.code === 'ECONNREFUSED' && Date.now() < deadline) {
        pending = setTimeout(forward, 350);
        return;
      }
      if (res.headersSent) return res.destroy();
      const service = Object.keys(port).find((name) => port[name] === target.port);
      log('upstream unavailable:', service, error.code || error.name);
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end('{"error":{"code":"unavailable","message":"Talkie is starting. Try again in a moment."}}');
    });
  };
  forward();
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
if (MODE === 'gateway') {
  if (typeof PhusionPassenger !== 'undefined') {
    PhusionPassenger.configure({ autoInstall: false });
    gateway.listen('passenger', () => log('gateway listening (Passenger)'));
  } else {
    const publicPort = process.env.PORT || 3000; // LiteSpeed passes a socket path here
    gateway.listen(publicPort, () => log(`gateway listening on ${publicPort}`));
  }
}

// ───────── Child processes (started by the gateway) ─────────
let stopping = false;
const children = new Set();

/** The app's settings for a child, without any loader hook the host injected into this process. */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  if (env.NODE_OPTIONS && /lsnode|lsapi/i.test(env.NODE_OPTIONS)) delete env.NODE_OPTIONS;
  return env;
}

/** Starts a child (this file in another mode) and restarts it if it stops. */
function keep(name, mode, env) {
  if (stopping) return;
  // The IPC channel lets the child notice when this process is gone, so it never outlives it holding the ports.
  // Child output goes to talkie.log too.
  let out = 'inherit';
  try {
    out = fs.openSync(LOG_FILE, 'a');
  } catch {}
  const child = spawn(process.execPath, [__filename, mode], { cwd: ROOT, env, stdio: ['ignore', out, out, 'ipc'] });
  if (typeof out === 'number') fs.closeSync(out);
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    log(`${name} stopped (${code ?? signal}); restarting in 2 s`);
    setTimeout(() => keep(name, mode, env), 2000);
  });
}

function stopChildren() {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}

/** In a child: leave when the gateway process is gone. */
function followParent() {
  process.on('disconnect', () => process.exit(0));
}

// ───────── Services (child) ─────────
async function runServices() {
  followParent();
  if (process.env.RUN_MIGRATIONS !== 'false') {
    try {
      const { runMigrations } = await import(pathToFileURL(path.join(ROOT, 'migrate.mjs')).href);
      await runMigrations(path.join(ROOT, 'database'));
      log('database is up to date');
    } catch (error) {
      log('database migration failed, check DB_* settings:', error && error.message);
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

// ───────── Web app (child) ─────────
function runWeb() {
  followParent();
  const server = path.join(ROOT, 'web', 'apps', 'web', 'server.js');
  if (!fs.existsSync(server)) {
    log('web app missing: run `npm run build:cpanel` and upload again');
    return;
  }
  process.chdir(path.dirname(server));
  // Next.js standalone server (an ES module here): reads PORT / HOSTNAME.
  import(pathToFileURL(server).href).catch((error) => {
    log('web app failed:', error && (error.stack || error.message));
    process.exit(1);
  });
}

process.on('unhandledRejection', (error) => log('unhandled rejection:', error && (error.stack || error)));

if (MODE === 'services') {
  runServices().catch((error) => log('services failed:', error && (error.stack || error)));
} else if (MODE === 'web') {
  runWeb();
} else {
  keep('web app', '--talkie-web', childEnv({ NODE_ENV: 'production', PORT: String(port.web), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' }));
  keep('services', '--talkie-services', childEnv({}));
  process.on('exit', stopChildren);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => (stopChildren(), process.exit(0)));
}
