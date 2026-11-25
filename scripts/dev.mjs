// Starts every implemented service plus the web app, each in its own process, with prefixed coloured logs.
// `npm run dev` — all; `npm run dev -- auth users` — only those services (plus web).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const available = readdirSync(resolve(root, 'services')).filter((name) => existsSync(resolve(root, 'services', name, 'src', 'main.ts')));
const chosen = process.argv.slice(2);
const services = chosen.length ? available.filter((name) => chosen.includes(name)) : available;
const colors = [36, 35, 33, 32, 34, 31, 96, 95, 93];

const children = [];
const run = (label, command, args, cwd, color) => {
  // Each service has its own default port; a PORT set for the web app must not leak into them.
  const env = { ...process.env, FORCE_COLOR: '1' };
  if (label !== 'web') delete env.PORT;
  const child = spawn(command, args, { cwd, shell: process.platform === 'win32', env });
  const prefix = `\x1b[${color}m${label.padEnd(8)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with code ${code}\n`));
  children.push(child);
};

services.forEach((name, index) => run(name, 'npx', ['tsx', 'watch', '--clear-screen=false', 'src/main.ts'], resolve(root, 'services', name), colors[index % colors.length]));
run('web', 'npm', ['run', 'dev'], resolve(root, 'apps', 'web'), 97);

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
