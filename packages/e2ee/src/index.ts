import sodium from 'libsodium-wrappers';

/**
 * Talkie message encryption (v1).
 *
 * - Each device owns an X25519 key pair made on the device; only the public key is uploaded.
 * - Every message gets a fresh random 256-bit key K. The body is encrypted once with XChaCha20-Poly1305(K).
 * - K is sealed separately for each recipient device (and the sender's other devices) with crypto_box
 *   (X25519 + XSalsa20-Poly1305) from the sending device's secret key, so the recipient also learns which
 *   device sent it: a forged sender key fails to open.
 * - The server stores ciphertext and sealed keys only. It never sees K or the body.
 *
 * Limits of v1, to be addressed by a ratchet in a later version: no forward secrecy (a stolen device secret key
 * opens that device's past messages), and key changes are trusted on first use until safety numbers are shown.
 */

export interface DeviceKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface Recipient {
  deviceId: string;
  identityKey: string;
}

export interface Sealed {
  ciphertext: string;
  nonce: string;
  keys: Array<{ deviceId: string; sealedKey: string }>;
}

/** What is inside an encrypted message. Extended by later message kinds (media, location, poll…). */
export interface MessageBody {
  v: 1;
  text?: string;
  [field: string]: unknown;
}

const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ready = (): Promise<void> => sodium.ready;

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);

export function generateDeviceKeys(): DeviceKeyPair {
  const pair = sodium.crypto_box_keypair();
  return { publicKey: b64(pair.publicKey), secretKey: b64(pair.privateKey) };
}

/** Encrypts `body` once and seals its key for every recipient device. */
export function seal(body: MessageBody, sender: DeviceKeyPair, recipients: Recipient[]): Sealed {
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = encoder.encode(JSON.stringify({ ...body, v: VERSION }));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key);
  const secret = unb64(sender.secretKey);
  const unique = new Map(recipients.map((r) => [r.deviceId, r]));
  const keys = [...unique.values()].map((recipient) => {
    const boxNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const boxed = sodium.crypto_box_easy(key, boxNonce, unb64(recipient.identityKey), secret);
    const sealedKey = new Uint8Array(boxNonce.length + boxed.length);
    sealedKey.set(boxNonce);
    sealedKey.set(boxed, boxNonce.length);
    return { deviceId: recipient.deviceId, sealedKey: b64(sealedKey) };
  });
  sodium.memzero(key);
  return { ciphertext: b64(ciphertext), nonce: b64(nonce), keys };
}

/**
 * Opens a message with this device's secret key and the sending device's public key.
 * Throws when anything was altered or the message was not sealed for this device.
 */
export function open(
  message: { ciphertext: string; nonce: string; sealedKey: string },
  senderIdentityKey: string,
  receiver: DeviceKeyPair,
): MessageBody {
  const sealedKey = unb64(message.sealedKey);
  const boxNonce = sealedKey.slice(0, sodium.crypto_box_NONCEBYTES);
  const key = sodium.crypto_box_open_easy(sealedKey.slice(sodium.crypto_box_NONCEBYTES), boxNonce, unb64(senderIdentityKey), unb64(receiver.secretKey));
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(message.ciphertext), null, unb64(message.nonce), key);
  sodium.memzero(key);
  const body = JSON.parse(decoder.decode(plaintext)) as MessageBody;
  if (body.v !== VERSION) throw new Error('Unsupported message version');
  return body;
}

/** Short fingerprint of two devices' keys, for comparing in person ("safety number"). */
export function safetyNumber(a: string, b: string): string {
  const [first, second] = [a, b].sort();
  const digest = sodium.crypto_generichash(30, encoder.encode(`${first}:${second}`), null);
  return Array.from(digest as Uint8Array)
    .map((byte) => String(byte % 100).padStart(2, '0'))
    .join('')
    .slice(0, 60)
    .replace(/(\d{5})(?=\d)/g, '$1 ');
}

/** A 26-character random id for idempotent sends. */
export function clientMessageId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz';
  const time = Date.now().toString(36).padStart(10, '0');
  const random = sodium.randombytes_buf(16);
  return (time + Array.from(random, (byte) => alphabet[byte % alphabet.length]).join('')).slice(0, 26);
}

// ───────── Files ─────────

/** Plaintext bytes per chunk; each encrypted chunk is 17 bytes longer (authentication tag). */
export const FILE_CHUNK = 64 * 1024;
export const FILE_CHUNK_OVERHEAD = 17;

/** Size of a file once encrypted (the 24-byte stream header travels in the message, not the file). */
export const encryptedSize = (plainSize: number) => Math.max(1, Math.ceil(plainSize / FILE_CHUNK)) * FILE_CHUNK_OVERHEAD + plainSize;

export interface FileEncryptor {
  key: string;
  header: string;
  /** Encrypts the next chunk (at most FILE_CHUNK bytes); mark the final one. */
  push(chunk: Uint8Array, last: boolean): Uint8Array;
}

/**
 * Streaming file encryption (XChaCha20-Poly1305 secretstream): every chunk is authenticated, chunks cannot be
 * reordered, removed or appended, and the end of the file is marked. A fresh key per file.
 */
export function fileEncryptor(): FileEncryptor {
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  return {
    key: b64(key),
    header: b64(header),
    push: (chunk, last) =>
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        null,
        last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      ),
  };
}

export interface FileDecryptor {
  /** Decrypts the next encrypted chunk (FILE_CHUNK + 17 bytes, the last may be shorter). */
  pull(chunk: Uint8Array): { data: Uint8Array; last: boolean };
}

export function fileDecryptor(key: string, header: string): FileDecryptor {
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(unb64(header), unb64(key));
  return {
    pull(chunk) {
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
      if (!result) throw new Error('This file was changed or damaged.');
      return { data: result.message, last: result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL };
    },
  };
}

/** Encrypts a whole in-memory file (small files, tests). */
export function encryptBytes(bytes: Uint8Array): { data: Uint8Array; key: string; header: string } {
  const encryptor = fileEncryptor();
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += FILE_CHUNK) {
    parts.push(encryptor.push(bytes.subarray(offset, offset + FILE_CHUNK), offset + FILE_CHUNK >= bytes.length));
    if (offset + FILE_CHUNK >= bytes.length) break;
  }
  return { data: concat(parts), key: encryptor.key, header: encryptor.header };
}

export function decryptBytes(data: Uint8Array, key: string, header: string): Uint8Array {
  const decryptor = fileDecryptor(key, header);
  const parts: Uint8Array[] = [];
  let finished = false;
  for (let offset = 0; offset < data.length; offset += FILE_CHUNK + FILE_CHUNK_OVERHEAD) {
    const { data: plain, last } = decryptor.pull(data.subarray(offset, offset + FILE_CHUNK + FILE_CHUNK_OVERHEAD));
    parts.push(plain);
    finished = last;
  }
  if (!finished) throw new Error('This file is incomplete.');
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ───────── Call keys ─────────

/** A random 32-byte media key for an end-to-end encrypted call (base64url). */
export const newCallKey = (): string => b64(sodium.randombytes_buf(32));

/** Seals a small secret (a call key) for each device, exactly like a message key. */
export function sealSecret(secret: string, sender: DeviceKeyPair, recipients: Recipient[]): Array<{ deviceId: string; sealedKey: string }> {
  const bytes = unb64(secret);
  const secretKey = unb64(sender.secretKey);
  return [...new Map(recipients.map((r) => [r.deviceId, r])).values()].map((recipient) => {
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const boxed = sodium.crypto_box_easy(bytes, nonce, unb64(recipient.identityKey), secretKey);
    const sealed = new Uint8Array(nonce.length + boxed.length);
    sealed.set(nonce);
    sealed.set(boxed, nonce.length);
    return { deviceId: recipient.deviceId, sealedKey: b64(sealed) };
  });
}

export function openSecret(sealedKey: string, senderIdentityKey: string, receiver: DeviceKeyPair): string {
  const sealed = unb64(sealedKey);
  const nonce = sealed.slice(0, sodium.crypto_box_NONCEBYTES);
  return b64(sodium.crypto_box_open_easy(sealed.slice(sodium.crypto_box_NONCEBYTES), nonce, unb64(senderIdentityKey), unb64(receiver.secretKey)));
}
