import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { ACCESS_TOKEN_ALG, type AuthContext } from '@talkie/auth-kit';
import { env, privateKeyPem } from './config.ts';

let signingKey: CryptoKey | undefined;

async function key(): Promise<CryptoKey> {
  signingKey ??= await importPKCS8(privateKeyPem(), ACCESS_TOKEN_ALG);
  return signingKey;
}

/** Short-lived access token every service verifies with the public key. */
export async function signAccessToken(context: AuthContext): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_MINUTES * 60_000);
  const token = await new SignJWT({ did: context.deviceId, sid: context.sessionId, role: context.role })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALG, typ: 'JWT' })
    .setSubject(context.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(await key());
  return { token, expiresAt };
}
