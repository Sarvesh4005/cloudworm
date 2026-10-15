/**
 * Upload engine: encrypt each chunk in the browser, then PUT the ciphertext
 * straight to S3 with presigned URLs. Nothing large goes through Lambda.
 */
import { ApiError, type Api, type PresignedPart, type PublicConfig } from "./api";
import {
  chunkCount,
  chunkRange,
  ciphertextSize,
  deriveFileKey,
  deriveMetaKey,
  encryptChunk,
  encryptMetadata,
  generateTransferKey,
  importTransferKey,
} from "./crypto";

export const PART_CONCURRENCY = 3;
const URL_BATCH = 20;
const MAX_ATTEMPTS = 4;

export class UploadHttpError extends Error {
  constructor(public status: number) {
    super(status === 0 ? "Network error while uploading." : `Storage rejected the upload (HTTP ${status}).`);
    this.name = "UploadHttpError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "AbortError";
  }
}

/** PUT bytes to a presigned URL; resolves with the response ETag. */
export type PutFn = (
  url: string,
  body: ArrayBuffer,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
) => Promise<string>;

export const xhrPut: PutFn = (url, body, onProgress, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      signal.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(body.byteLength);
        resolve(xhr.getResponseHeader("ETag") ?? "");
      } else reject(new UploadHttpError(xhr.status));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new UploadHttpError(0));
    };
    const onAbort = () => {
      xhr.abort();
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });

export function fileExtension(name: string): string | undefined {
  const m = /\.([A-Za-z0-9]{1,16})$/.exec(name);
  return m ? m[1].toLowerCase() : undefined;
}

/** Client-side mirror of the server's limits, for instant feedback. The server re-checks everything. */
export function validateSelection(files: File[], config: PublicConfig): string | null {
  if (files.length === 0) return "Add at least one file.";
  if (files.length > config.maxFiles) return `You can send at most ${config.maxFiles} files at once.`;
  let total = 0;
  for (const f of files) {
    if (f.size > config.maxFileBytes) return `"${f.name}" is larger than the per-file limit.`;
    if (config.allowedExtensions.length) {
      const ext = fileExtension(f.name);
      if (!ext || !config.allowedExtensions.includes(ext)) return `"${f.name}" is not an allowed file type.`;
    }
    total += f.size;
  }
  if (total > config.maxTransferBytes) return "These files exceed the total size limit for one transfer.";
  return null;
}

export interface SendOptions {
  api: Api;
  config: PublicConfig;
  files: File[];
  accessCode: string;
  expiresInHours: number;
  signal: AbortSignal;
  /** Called with ciphertext bytes uploaded for each file index. */
  onProgress?: (fileIndex: number, uploadedBytes: number, totalBytes: number) => void;
  onFileDone?: (fileIndex: number) => void;
  put?: PutFn;
}

export interface SendResult {
  transferId: string;
  ownerToken: string;
  key: string;
  expiresAt: number;
}

export async function sendFiles(opts: SendOptions): Promise<SendResult> {
  const { api, config, files, signal } = opts;
  const put = opts.put ?? xhrPut;

  const key = generateTransferKey();
  const master = await importTransferKey(key);
  const metaKey = await deriveMetaKey(master);
  const restrictTypes = config.allowedExtensions.length > 0;

  const encFiles = await Promise.all(
    files.map(async (f) => ({
      size: f.size,
      encName: await encryptMetadata(metaKey, { name: f.name, type: f.type }),
      // Only reveal the extension when the server is configured to enforce an allowlist.
      ...(restrictTypes ? { ext: fileExtension(f.name) } : {}),
    })),
  );

  const created = await api.createTransfer({
    accessCode: opts.accessCode,
    expiresInHours: opts.expiresInHours,
    files: encFiles,
  });
  const { transferId, ownerToken } = created;

  try {
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new AbortedError();
      await uploadOneFile({ ...opts, put, master, transferId, ownerToken, index: i, file: files[i] });
      opts.onFileDone?.(i);
    }
    await api.finalize(transferId, ownerToken);
  } catch (err) {
    // Best effort: don't leave half-uploaded transfers behind.
    api.deleteTransfer(transferId, ownerToken).catch(() => undefined);
    throw err;
  }
  return { transferId, ownerToken, key, expiresAt: created.expiresAt };
}

async function uploadOneFile(
  o: SendOptions & { put: PutFn; master: CryptoKey; transferId: string; ownerToken: string; index: number; file: File },
): Promise<void> {
  const { api, file, index, transferId, ownerToken } = o;
  // Local controller so one permanently failed part stops the sibling workers too.
  const local = new AbortController();
  const stop = () => local.abort();
  o.signal.addEventListener("abort", stop, { once: true });
  const signal = local.signal;
  const fileKey = await deriveFileKey(o.master, index);
  const parts = chunkCount(file.size);
  const total = ciphertextSize(file.size);
  const loaded = new Map<number, number>();
  const report = () => o.onProgress?.(index, [...loaded.values()].reduce((a, b) => a + b, 0), total);

  // Presigned URLs are fetched lazily in batches and refreshed when they expire.
  const urls = new Map<number, { url: string; expires: number }>();
  let inflight: Promise<void> | null = null;
  async function urlFor(partNumber: number, forceRefresh = false): Promise<string> {
    const cached = urls.get(partNumber);
    if (!forceRefresh && cached && cached.expires - Date.now() > 60_000) return cached.url;
    while (inflight) await inflight.catch(() => undefined);
    const again = urls.get(partNumber);
    if (!forceRefresh && again && again.expires - Date.now() > 60_000) return again.url;
    const wanted: number[] = [];
    for (let n = partNumber; n <= parts && wanted.length < URL_BATCH; n++) wanted.push(n);
    inflight = api.getUploadUrls(transferId, index, wanted, ownerToken).then((res) => {
      const expires = Date.now() + res.expiresIn * 1000;
      res.urls.forEach((p: PresignedPart) => urls.set(p.partNumber, { url: p.url, expires }));
    });
    try {
      await inflight;
    } finally {
      inflight = null;
    }
    return urls.get(partNumber)!.url;
  }

  const etags: string[] = new Array(parts);
  let next = 1;

  async function worker() {
    while (next <= parts) {
      const partNumber = next++;
      const [start, end] = chunkRange(file.size, partNumber - 1);
      const plaintext = await file.slice(start, end).arrayBuffer();
      const ciphertext = await encryptChunk(fileKey, partNumber - 1, partNumber === parts, plaintext);

      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw new AbortedError();
        try {
          const url = await urlFor(partNumber, attempt > 1);
          etags[partNumber - 1] = await o.put(
            url,
            ciphertext,
            (n) => {
              loaded.set(partNumber, n);
              report();
            },
            signal,
          );
          break;
        } catch (err) {
          loaded.set(partNumber, 0);
          report();
          const retryable =
            (err instanceof UploadHttpError && (err.status === 0 || err.status === 403 || err.status >= 500)) ||
            (err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500));
          if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
          await sleep(500 * 2 ** attempt, signal);
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts) }, worker));
  } catch (err) {
    local.abort();
    throw o.signal.aborted ? new AbortedError() : err;
  } finally {
    o.signal.removeEventListener("abort", stop);
  }
  const partList = parts > 1 ? etags.map((etag, i) => ({ partNumber: i + 1, etag })) : null;
  await api.completeFile(transferId, index, partList, ownerToken);
}
