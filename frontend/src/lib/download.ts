/** Download engine: fetch ciphertext from S3, decrypt chunk by chunk, save locally. */
import type { Api } from "./api";
import { decryptStream, deriveFileKey } from "./crypto";

export interface Sink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Remove path separators and control characters from a decrypted (untrusted) file name. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "download").slice(0, 200);
}

type SaveFilePicker = (opts: { suggestedName?: string }) => Promise<{
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}>;

export function canStreamToDisk(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/**
 * Must be called directly from a click handler (user activation).
 * Chromium streams to disk; other browsers collect a Blob in memory.
 */
export async function openSink(name: string, type: string, preferDisk = true): Promise<Sink> {
  const fileName = safeFileName(name);
  if (preferDisk && canStreamToDisk()) {
    const picker = (window as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker;
    const handle = await picker({ suggestedName: fileName });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  return {
    write: async (chunk) => {
      parts.push(chunk);
    },
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: type || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

export interface DownloadOptions {
  api: Api;
  transferId: string;
  master: CryptoKey;
  index: number;
  size: number;
  ciphertextSize: number;
  sink: Sink;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  fetchImpl?: typeof fetch;
}

export async function downloadFile(o: DownloadOptions): Promise<void> {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    const fileKey = await deriveFileKey(o.master, o.index);
    const { url } = await o.api.getDownloadUrl(o.transferId, o.index);
    const res = await doFetch(url, { signal: o.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok || !res.body) throw new Error(`Storage returned HTTP ${res.status}. The link may have expired; reload and try again.`);
    await decryptStream(
      res.body,
      fileKey,
      o.size,
      (chunk) => o.sink.write(chunk),
      (read) => o.onProgress?.(Math.min(1, read / o.ciphertextSize)),
    );
    await o.sink.close();
  } catch (err) {
    await o.sink.abort().catch(() => undefined);
    throw err;
  }
}
