'use client';

import * as e2ee from '@talkie/e2ee';
import { api } from '../api';

/**
 * This browser's device key pair, kept in IndexedDB (never sent anywhere; only the public half is uploaded).
 * One pair per signed-in device id: signing in again creates a new device with a new pair.
 */
const DB_NAME = 'talkie-keys';
const STORE = 'devices';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read(deviceId: string): Promise<e2ee.DeviceKeyPair | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(deviceId);
    request.onsuccess = () => resolve(request.result as e2ee.DeviceKeyPair | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function write(deviceId: string, pair: e2ee.DeviceKeyPair): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(pair, deviceId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let current: { deviceId: string; pair: e2ee.DeviceKeyPair } | null = null;

/** Loads (or creates and registers) this device's keys. Call once after sign-in. */
export async function ensureDeviceKeys(deviceId: string): Promise<{ deviceId: string; pair: e2ee.DeviceKeyPair }> {
  if (current?.deviceId === deviceId) return current;
  await e2ee.ready();
  let pair = await read(deviceId).catch(() => undefined);
  if (!pair) {
    pair = e2ee.generateDeviceKeys();
    await write(deviceId, pair);
    await api('/auth/devices/current/identity-key', { method: 'PUT', body: { identityKey: pair.publicKey } });
  }
  current = { deviceId, pair };
  return current;
}

export const deviceKeys = () => current;

// ───────── Other devices' public keys ─────────

const publicKeys = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

export function rememberKeys(devices: Array<{ deviceId: string; identityKey: string }>) {
  for (const device of devices) publicKeys.set(device.deviceId, device.identityKey);
}

/** Public keys for the given sender devices, fetched in one request for the ones not cached yet. */
export async function senderKeys(deviceIds: string[]): Promise<Map<string, string>> {
  const missing = [...new Set(deviceIds)].filter((id) => !publicKeys.has(id) && !pending.has(id));
  if (missing.length) {
    const request = api<{ devices: Array<{ deviceId: string; identityKey: string }> }>('/auth/device-keys/lookup', { method: 'POST', body: { deviceIds: missing.slice(0, 200) } })
      .then(({ devices }) => rememberKeys(devices))
      .finally(() => missing.forEach((id) => pending.delete(id)));
    missing.forEach((id) => pending.set(id, request));
  }
  await Promise.all([...new Set(deviceIds)].map((id) => pending.get(id)).filter(Boolean));
  return publicKeys;
}
