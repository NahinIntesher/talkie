import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

/** Where uploaded bytes live. Uploads arrive as ordered parts and become one object on completion. */
export interface Storage {
  /** Stores part `index` (0-based). Returns S3 bookkeeping, if any. */
  putPart(key: string, index: number, data: Buffer, uploadId: string | null): Promise<{ uploadId: string | null; etag: string | null }>;
  complete(key: string, uploadId: string | null, etags: string[]): Promise<void>;
  abort(key: string, uploadId: string | null): Promise<void>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** A byte range (inclusive) or the whole object. */
  read(key: string, range?: { start: number; end: number }): Promise<Readable>;
  remove(key: string): Promise<void>;
}

/** Local disk: for development and single-server installs. Keep the folder on persistent storage and in backups. */
export function diskStorage(root: string): Storage {
  const base = resolve(root);
  const path = (key: string) => {
    const full = resolve(base, key);
    if (!full.startsWith(base)) throw new Error('Invalid storage key');
    return full;
  };
  return {
    async putPart(key, index, data) {
      const file = `${path(key)}.part`;
      await mkdir(dirname(file), { recursive: true });
      const handle = await open(file, index === 0 ? 'w' : 'a');
      try {
        await handle.write(data);
      } finally {
        await handle.close();
      }
      return { uploadId: null, etag: null };
    },
    async complete(key) {
      await rename(`${path(key)}.part`, path(key));
    },
    async abort(key) {
      await rm(`${path(key)}.part`, { force: true });
    },
    async put(key, data) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), data);
    },
    async read(key, range) {
      await stat(path(key));
      return createReadStream(path(key), range);
    },
    async remove(key) {
      await rm(path(key), { force: true });
    },
  };
}

/** S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO). */
export function s3Storage(options: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }): Storage {
  const client = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: !!options.endpoint,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  const Bucket = options.bucket;
  return {
    async putPart(key, index, data, uploadId) {
      let id = uploadId;
      if (!id) id = (await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'application/octet-stream' }))).UploadId ?? null;
      const result = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId: id!, PartNumber: index + 1, Body: data }));
      return { uploadId: id, etag: result.ETag ?? null };
    },
    async complete(key, uploadId, etags) {
      await client.send(
        new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId!, MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) } }),
      );
    },
    async abort(key, uploadId) {
      if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })).catch(() => {});
    },
    async put(key, data, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: data, ContentType: contentType }));
    },
    async read(key, range) {
      const result = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
      return result.Body as Readable;
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

export const joinKey = (...parts: string[]) => join(...parts).replace(/\\/g, '/');
