// Runs the Next.js CLI. Node 22.0–22.11 needs --experimental-require-module for Tailwind's tooling
// (built in from Node 22.12); the flag is harmless on newer versions.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The call-encryption worker runs from its own file: copy the installed version into public/.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const workerSource = join(dirname(require.resolve('livekit-client')), 'livekit-client.e2ee.worker.mjs');
copyFileSync(workerSource, new URL('./public/livekit-e2ee-worker.mjs', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
if (major === 22 && minor < 12) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --experimental-require-module --no-warnings=ExperimentalWarning`.trim();

const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
