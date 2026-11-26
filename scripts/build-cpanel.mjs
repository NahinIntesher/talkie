// Builds the folder (and zip) to upload to cPanel → "Setup Node.js App". Run: npm run build:cpanel
//   --skip-web    reuse the last Next.js build
//   --no-zip      only the folder
// Output: build/cpanel/ and build/talkie-cpanel.zip. Settings come from .env.hosted; the access-token key pair is
// created once in secrets/hosted/ and reused, so a new upload does not sign everyone out.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'build', 'cpanel');
const args = new Set(process.argv.slice(2));
const step = (text) => console.log(`\n\x1b[1;35m==> ${text}\x1b[0m`);
const run = (command, commandArgs, cwd = root) => {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed`);
};

if (!existsSync(join(root, '.env.hosted'))) throw new Error('.env.hosted is missing');

step('Bundling services');
run('node', ['scripts/build-services.mjs']);
const services = readdirSync(join(root, 'services')).filter((name) => existsSync(join(root, 'services', name, 'dist', 'main.js')));

step('Bundling the database migrator');
mkdirSync(join(root, 'build'), { recursive: true });
await build({
  entryPoints: [join(root, 'scripts', 'cpanel-migrate.ts')],
  outfile: join(root, 'build', 'migrate.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  plugins: [
    {
      name: 'bundle-workspace',
      setup(b) {
        b.onResolve({ filter: /^@talkie\// }, (a) => ({ path: join(root, 'packages', a.path.split('/')[1], 'src', 'index.ts') }));
      },
    },
  ],
});

// Public web settings (NEXT_PUBLIC_*, e.g. the Firebase web-push key) are baked into the web build.
for (const line of readFileSync(join(root, '.env.hosted'), 'utf8').split(/\r?\n/)) {
  const match = /^(NEXT_PUBLIC_[A-Z0-9_]+)=(.+)$/.exec(line);
  if (match) process.env[match[1]] = match[2].trim();
}

if (!args.has('--skip-web')) {
  step('Building the web app');
  run('npm', ['run', 'build', '-w', '@talkie/web']);
}
const standalone = join(root, 'apps', 'web', '.next', 'standalone');
if (!existsSync(join(standalone, 'apps', 'web', 'server.js'))) throw new Error('No web build found (apps/web/.next/standalone)');

step('Assembling build/cpanel');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'infra', 'cpanel', 'app.cjs'), join(out, 'app.cjs'));
cpSync(join(root, 'build', 'migrate.mjs'), join(out, 'migrate.mjs'));
cpSync(join(root, 'database'), join(out, 'database'), { recursive: true, filter: (path) => !path.endsWith('README.md') });
for (const name of services) {
  mkdirSync(join(out, 'services', name), { recursive: true });
  // .mjs: the bundles are ES modules and the upload's package.json is not "type": "module".
  cpSync(join(root, 'services', name, 'dist', 'main.js'), join(out, 'services', name, 'main.mjs'));
}
cpSync(standalone, join(out, 'web'), { recursive: true });
cpSync(join(root, 'apps', 'web', '.next', 'static'), join(out, 'web', 'apps', 'web', '.next', 'static'), { recursive: true });
cpSync(join(root, 'apps', 'web', 'public'), join(out, 'web', 'apps', 'web', 'public'), { recursive: true });
// The standalone build carries a copy of the local .env; the real settings live in the upload's own .env.
rmSync(join(out, 'web', '.env'), { force: true });
rmSync(join(out, 'web', 'apps', 'web', '.env'), { force: true });

// Runtime dependencies: every package the bundles import, pinned to the version installed here.
const bundles = [join(out, 'migrate.mjs'), ...services.map((name) => join(out, 'services', name, 'main.mjs'))];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const wanted = new Set();
for (const file of bundles) {
  const code = readFileSync(file, 'utf8');
  for (const match of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"'./][^"']*)["']/g)) {
    const spec = match[1];
    if (builtins.has(spec) || spec.startsWith('node:')) continue;
    wanted.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
}
const dependencies = {};
for (const name of [...wanted].sort()) {
  const manifest = join(root, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(manifest)) throw new Error(`Dependency ${name} is not installed`);
  dependencies[name] = JSON.parse(readFileSync(manifest, 'utf8')).version;
}
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: 'talkie', version: '1.0.0', private: true, main: 'app.cjs', engines: { node: '>=20.11' }, scripts: { start: 'node app.cjs' }, dependencies }, null, 2) + '\n',
);
console.log(`    ${Object.keys(dependencies).length} runtime packages: ${Object.keys(dependencies).join(', ')}`);

// Access-token signing keys for the hosted site (never the development ones).
const keys = join(root, 'secrets', 'hosted');
mkdirSync(keys, { recursive: true });
if (!existsSync(join(keys, 'jwt-private.pem'))) {
  const pair = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(join(keys, 'jwt-private.pem'), pair.privateKey, { mode: 0o600 });
  writeFileSync(join(keys, 'jwt-public.pem'), pair.publicKey);
  console.log('    created secrets/hosted/jwt-*.pem (keep them: a new pair signs everyone out)');
}
cpSync(keys, join(out, 'secrets'), { recursive: true });

// Settings: .env.hosted, with the values a cPanel install needs.
let env = readFileSync(join(root, '.env.hosted'), 'utf8');
for (const [key, value] of Object.entries({ BUS_DRIVER: 'process' })) {
  env = new RegExp(`^${key}=`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync(join(out, '.env'), env, { mode: 0o600 });
for (const key of ['SMTP_PASSWORD', 'LIVEKIT_API_SECRET', 'OWNER_EMAILS', 'DB_PASSWORD']) {
  if (!new RegExp(`^${key}=[^\\r\\n]+`, 'm').test(env)) console.log(`    \x1b[33mnote: ${key} is empty in .env.hosted (fine when it is set in cPanel)\x1b[0m`);
}

if (!args.has('--no-zip')) {
  step('Zipping build/talkie-cpanel.zip');
  const zip = join(root, 'build', 'talkie-cpanel.zip');
  rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`]);
  } else {
    run('zip', ['-qr', zip, '.'], out);
  }
  console.log(`    ${zip}`);
}
console.log('\nUpload the zip to the Node.js app folder in cPanel, extract it, then Run NPM Install and Restart (docs/DEPLOY.md).');
