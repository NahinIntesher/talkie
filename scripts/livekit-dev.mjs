// Runs a local LiveKit media server for development (tools/livekit/livekit-server.exe).
// First run: creates LIVEKIT_* development keys in .env. Webhooks go to the local meet service.
//   npm run livekit
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env');
const binary = resolve(root, 'tools', 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
if (!existsSync(binary)) throw new Error(`LiveKit server not found at ${binary}`);

let env = readFileSync(envPath, 'utf8');
const get = (key) => (env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
const put = (key, value) => {
  env = new RegExp(`^${key}=`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
};
if (!get('LIVEKIT_API_KEY') || !get('LIVEKIT_API_SECRET')) {
  put('LIVEKIT_URL', 'ws://127.0.0.1:7880');
  put('LIVEKIT_API_KEY', 'talkiedev');
  put('LIVEKIT_API_SECRET', randomBytes(32).toString('base64url'));
  writeFileSync(envPath, env, { mode: 0o600 });
  console.log('Added local LiveKit development keys to .env (restart `npm run dev` to use them).');
}
const key = get('LIVEKIT_API_KEY');
const secret = get('LIVEKIT_API_SECRET');

// Browsers will not send call media to a loopback address, so media also listens on this PC's network address.
const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.1';
const config = `port: 7880
bind_addresses: ["127.0.0.1"${lan === '127.0.0.1' ? '' : `, "${lan}"`}]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: false
  node_ip: ${lan}
keys:
  ${key}: ${secret}
webhook:
  api_key: ${key}
  urls:
    - http://127.0.0.1:4106/meet/livekit/webhook
logging:
  level: info
`;
const configPath = resolve(root, 'tools', 'livekit', 'livekit.dev.yaml');
writeFileSync(configPath, config, { mode: 0o600 });

const child = spawn(binary, ['--config', configPath, '--dev'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
