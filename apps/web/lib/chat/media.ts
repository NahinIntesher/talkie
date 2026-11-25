'use client';

import * as e2ee from '@talkie/e2ee';
import type { AttachmentRef, MediaPurpose, UploadCreated } from '@talkie/contracts';
import { ApiError, refreshSession, tokenStore } from '../api';

/** Authorized fetch for binary media endpoints (refreshes the access token once on 401). */
async function mediaFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-talkie-client', 'web');
  if (tokenStore.get()) headers.set('authorization', `Bearer ${tokenStore.get()}`);
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
  if (response.status === 401 && !retried && (await refreshSession())) return mediaFetch(path, init, true);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
    throw new ApiError(response.status, body.error?.code ?? 'internal', body.error?.message ?? 'Upload failed', body.error?.details);
  }
  return response;
}

const json = async <T>(path: string, body: unknown) =>
  (await (await mediaFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as T;

async function putPart(mediaId: string, index: number, data: Uint8Array, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      await mediaFetch(`/media/uploads/${mediaId}/parts/${index}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data as BodyInit, signal });
      return;
    } catch (error) {
      if (signal?.aborted || attempt >= 3 || (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) throw error;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}

/**
 * Encrypts a file on this device while uploading it in parts. Memory stays bounded: the file is read in 8 MB
 * slices, encrypted in 64 KB chunks and sent part by part. Returns the reference to put inside the message.
 */
export async function uploadEncrypted(
  file: Blob,
  purpose: Extract<MediaPurpose, 'message' | 'status'>,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ mediaId: string; key: string; header: string }> {
  await e2ee.ready();
  const total = e2ee.encryptedSize(file.size);
  const created = await json<UploadCreated>('/media/uploads', { purpose, byteSize: total, contentType: 'application/octet-stream' });
  const encryptor = e2ee.fileEncryptor();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let index = 0;
  let sent = 0;
  const flush = async (force: boolean) => {
    while (pendingBytes >= created.partSize || (force && pendingBytes > 0)) {
      const all = e2ee.concat(pending);
      const part = all.subarray(0, Math.min(created.partSize, all.length));
      const rest = all.subarray(part.length);
      await putPart(created.mediaId, index++, part, signal);
      sent += part.length;
      onProgress?.(sent / total);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  };
  const SLICE = 8 * 1024 * 1024;
  if (file.size === 0) {
    pending.push(encryptor.push(new Uint8Array(0), true));
    pendingBytes = pending[0]!.length;
  }
  for (let offset = 0; offset < file.size; offset += SLICE) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const slice = new Uint8Array(await file.slice(offset, offset + SLICE).arrayBuffer());
    for (let at = 0; at < slice.length; at += e2ee.FILE_CHUNK) {
      const last = offset + at + e2ee.FILE_CHUNK >= file.size;
      const encrypted = encryptor.push(slice.subarray(at, at + e2ee.FILE_CHUNK), last);
      pending.push(encrypted);
      pendingBytes += encrypted.length;
    }
    await flush(false);
  }
  await flush(true);
  await json(`/media/uploads/${created.mediaId}/complete`, {});
  return { mediaId: created.mediaId, key: encryptor.key, header: encryptor.header };
}

/** Profile and group photos (not encrypted; the server re-encodes them). */
export async function uploadPhoto(file: Blob, purpose: 'avatar' | 'group_avatar'): Promise<string> {
  const created = await json<UploadCreated>('/media/uploads', { purpose, byteSize: file.size, contentType: file.type || 'image/jpeg' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  for (let index = 0, offset = 0; offset < bytes.length; index++, offset += created.partSize) await putPart(created.mediaId, index, bytes.subarray(offset, offset + created.partSize));
  await json(`/media/uploads/${created.mediaId}/complete`, {});
  return created.mediaId;
}

// ───────── Download ─────────

const cache = new Map<string, Promise<string>>();

/** Downloads, verifies and decrypts an attachment; returns an object URL (cached for the session). */
export function openAttachment(ref: AttachmentRef, onProgress?: (fraction: number) => void): Promise<string> {
  const hit = cache.get(ref.mediaId);
  if (hit) return hit;
  const job = (async () => {
    await e2ee.ready();
    const response = await mediaFetch(`/media/files/${ref.mediaId}`);
    const total = Number(response.headers.get('content-length')) || e2ee.encryptedSize(ref.size);
    const reader = response.body!.getReader();
    const decryptor = e2ee.fileDecryptor(ref.key, ref.header);
    const size = e2ee.FILE_CHUNK + e2ee.FILE_CHUNK_OVERHEAD;
    const out: BlobPart[] = [];
    let buffer = new Uint8Array(0);
    let received = 0;
    let finished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        received += value.length;
        onProgress?.(received / total);
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
        while (buffer.length >= size) {
          const { data, last } = decryptor.pull(buffer.subarray(0, size));
          out.push(data.slice());
          finished = last;
          buffer = buffer.slice(size);
        }
      }
      if (done) break;
    }
    if (buffer.length) {
      const { data, last } = decryptor.pull(buffer);
      out.push(data.slice());
      finished = last;
    }
    if (!finished) throw new Error('The file is incomplete.');
    return URL.createObjectURL(new Blob(out, { type: ref.mime }));
  })();
  cache.set(ref.mediaId, job);
  job.catch(() => cache.delete(ref.mediaId));
  return job;
}

export function cachedAttachment(mediaId: string): Promise<string> | undefined {
  return cache.get(mediaId);
}

/** Lets the sender see their own attachment at once, without downloading it again. */
export function primeAttachment(mediaId: string, blob: Blob) {
  cache.set(mediaId, Promise.resolve(URL.createObjectURL(blob)));
}

// ───────── Preparing files ─────────

export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'document';

export function kindOf(file: File): AttachmentKind {
  if (/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(file.type)) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

const canvasJpeg = (source: CanvasImageSource, width: number, height: number, max: number, quality: number) => {
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

/**
 * Photos: sent at up to 2560 px (like "standard quality"), metadata removed by re-encoding; HD keeps the original.
 * Returns the file to upload plus dimensions and a tiny blurred preview.
 */
export async function prepareImage(file: File, hd = false): Promise<{ blob: Blob; width: number; height: number; thumb: string }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const thumb = canvasJpeg(bitmap, width, height, 32, 0.5).toDataURL('image/jpeg', 0.5);
  let blob: Blob = file;
  if (!hd && file.type !== 'image/gif' && (Math.max(width, height) > 2560 || file.size > 1.5 * 1024 * 1024)) {
    const canvas = canvasJpeg(bitmap, width, height, 2560, 0.86);
    blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.86));
  }
  bitmap.close();
  return { blob, width, height, thumb };
}

export async function prepareVideo(file: File): Promise<{ width: number; height: number; durationMs: number; thumb: string }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Unsupported video'));
    });
    video.currentTime = Math.min(0.5, video.duration / 2 || 0);
    await new Promise((resolve) => (video.onseeked = resolve));
    const thumb = canvasJpeg(video, video.videoWidth, video.videoHeight, 48, 0.55).toDataURL('image/jpeg', 0.55);
    return { width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(video.duration * 1000), thumb };
  } catch {
    return { width: 0, height: 0, durationMs: 0, thumb: '' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const formatBytes = (bytes: number, locale: 'bn' | 'en') => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale === 'bn' ? 'bn-BD' : 'en', { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`;
};

export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

// ───────── Voice notes ─────────

export interface Recording {
  stop(): Promise<{ blob: Blob; durationMs: number; waveform: number[] }>;
  cancel(): void;
  /** Live level 0–1 for the recording animation. */
  level(): number;
  startedAt: number;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples: number[] = [];
  const data = new Uint8Array(analyser.fftSize);
  const current = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
    return Math.min(1, peak * 1.6);
  };
  const sampler = setInterval(() => samples.push(current()), 80);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  recorder.start(250);
  const startedAt = Date.now();
  const cleanup = () => {
    clearInterval(sampler);
    stream.getTracks().forEach((track) => track.stop());
    void audio.close();
  };
  return {
    startedAt,
    level: current,
    cancel() {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      cleanup();
    },
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          cleanup();
          const bars = 48;
          const waveform = Array.from({ length: bars }, (_, i) => {
            const from = Math.floor((i * samples.length) / bars);
            const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / bars));
            const slice = samples.slice(from, to);
            return Math.round(Math.min(100, (slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length)) * 140 + 6));
          });
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), durationMs: Date.now() - startedAt, waveform });
        };
        recorder.stop();
      }),
  };
}
