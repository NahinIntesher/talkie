// Creates the Ed25519 signing key pair for access tokens and a local .env with strong random secrets.
// Existing files are never overwritten.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const secrets = resolve(root, 'secrets');
mkdirSync(secrets, { recursive: true });

const privatePath = resolve(secrets, 'jwt-private.pem');
const publicPath = resolve(secrets, 'jwt-public.pem');
if (existsSync(privatePath)) {
  console.log('secrets/jwt-private.pem already exists, keeping it.');
} else {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey);
  console.log('Created secrets/jwt-private.pem and secrets/jwt-public.pem');
}

const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  console.log('.env already exists, keeping it.');
} else {
  const template = readFileSync(resolve(root, '.env.example'), 'utf8');
  const secret = () => randomBytes(32).toString('base64url');
  const filled = template
    .replace(/^INTERNAL_TOKEN=.*$/m, `INTERNAL_TOKEN=${secret()}`)
    .replace(/^OTP_PEPPER=.*$/m, `OTP_PEPPER=${secret()}`);
  writeFileSync(envPath, filled, { mode: 0o600 });
  console.log('Created .env with fresh INTERNAL_TOKEN and OTP_PEPPER');
}
