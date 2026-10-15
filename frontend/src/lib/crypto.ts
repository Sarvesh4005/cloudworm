/**
 * CloudWorm end-to-end encryption, format v1 (see docs/ARCHITECTURE.md).
 *
 * - A random 256-bit transfer key lives only in the share link's #fragment.
 * - HKDF-SHA256 derives one AES-256-GCM key per file and one for metadata.
 * - Files are encrypted in independent 8 MiB chunks; chunk i uses
 *   IV = uint64_be(i) || 0x000000 || lastFlag, so IVs never repeat under a key,
 *   reordering is detected, and truncation is detected by the last-chunk flag.
 *
 * CHUNK_SIZE / TAG_SIZE must match backend/src/cloudworm/config.py.
 */

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const TAG_SIZE = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const INFO_PREFIX = "cloudworm/v1/";

export class DecryptionError extends Error {
  constructor(message = "Decryption failed. The link may be wrong or the file was modified.") {
    super(message);
    this.name = "DecryptionError";
  }
}

export class InvalidKeyError extends Error {
  constructor(message = "This link is missing its decryption key or the key is malformed.") {
    super(message);
    this.name = "InvalidKeyError";
  }
}

// ---------------------------------------------------------------- sizes ----
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

export function ciphertextSize(size: number): number {
  return size + TAG_SIZE * chunkCount(size);
}

/** Plaintext byte range [start, end) of chunk `index` (0-based). */
export function chunkRange(size: number, index: number): [number, number] {
  const start = index * CHUNK_SIZE;
  return [start, Math.min(size, start + CHUNK_SIZE)];
}

export function encryptedChunkSize(size: number, index: number): number {
  const [start, end] = chunkRange(size, index);
  return end - start + TAG_SIZE;
}

// --------------------------------------------------------------- base64url --
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------- keys ---
function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot encrypt files (WebCrypto requires HTTPS or localhost).");
  }
  return globalThis.crypto.subtle;
}

export function isCryptoAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle);
}

/** New random transfer key, base64url-encoded (43 chars). */
export function generateTransferKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Import the fragment key as HKDF input keying material (non-extractable). */
export async function importTransferKey(encoded: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64Url(encoded);
  } catch {
    throw new InvalidKeyError();
  }
  if (raw.length !== KEY_BYTES) throw new InvalidKeyError();
  return subtle().importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}

async function deriveAesKey(master: CryptoKey, info: string): Promise<CryptoKey> {
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(INFO_PREFIX + info) },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const deriveFileKey = (master: CryptoKey, index: number) => deriveAesKey(master, `file/${index}`);
export const deriveMetaKey = (master: CryptoKey) => deriveAesKey(master, "meta");

// ----------------------------------------------------------------- chunks ---
export function chunkIv(index: number, last: boolean): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(IV_BYTES);
  new DataView(iv.buffer).setBigUint64(0, BigInt(index), false);
  iv[IV_BYTES - 1] = last ? 1 : 0;
  return iv;
}

export async function encryptChunk(
  key: CryptoKey,
  index: number,
  last: boolean,
  plaintext: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return subtle().encrypt({ name: "AES-GCM", iv: chunkIv(index, last) }, key, plaintext);
}

export async function decryptChunk(
  key: CryptoKey,
  index: number,
  last: boolean,
  ciphertext: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  try {
    return await subtle().decrypt({ name: "AES-GCM", iv: chunkIv(index, last) }, key, ciphertext);
  } catch {
    throw new DecryptionError();
  }
}

// --------------------------------------------------------------- metadata ---
export interface FileMeta {
  name: string;
  type: string;
}

export async function encryptMetadata(metaKey: CryptoKey, meta: FileMeta): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify({ n: meta.name, t: meta.type }));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, metaKey, data));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return toBase64Url(out);
}

export async function decryptMetadata(metaKey: CryptoKey, blob: string): Promise<FileMeta> {
  try {
    const bytes = fromBase64Url(blob);
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
      metaKey,
      bytes.subarray(IV_BYTES),
    );
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as { n?: unknown; t?: unknown };
    return {
      name: typeof parsed.n === "string" ? parsed.n : "file",
      type: typeof parsed.t === "string" ? parsed.t : "",
    };
  } catch {
    throw new DecryptionError();
  }
}

// ---------------------------------------------------------- streaming -------
/** Accumulates network bytes and hands back exact-length slices. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array) {
    if (bytes.length) {
      this.parts.push(bytes);
      this.length += bytes.length;
    }
  }

  take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.parts[0];
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.parts.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.parts[0] = head.subarray(need);
        filled += need;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * Decrypt a ciphertext stream chunk by chunk, so memory use stays at about one
 * chunk regardless of file size. `onPlaintext` receives each verified chunk in order.
 */
export async function decryptStream(
  stream: ReadableStream<Uint8Array>,
  key: CryptoKey,
  plaintextSize: number,
  onPlaintext: (chunk: Uint8Array<ArrayBuffer>) => Promise<void> | void,
  onProgress?: (ciphertextBytesRead: number) => void,
): Promise<void> {
  const total = chunkCount(plaintextSize);
  const queue = new ByteQueue();
  const reader = stream.getReader();
  let index = 0;
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        queue.push(value);
        read += value.length;
        onProgress?.(read);
      }
      while (index < total && queue.length >= encryptedChunkSize(plaintextSize, index)) {
        const ct = queue.take(encryptedChunkSize(plaintextSize, index));
        const pt = await decryptChunk(key, index, index === total - 1, ct);
        await onPlaintext(new Uint8Array(pt));
        index++;
      }
      if (index === total && queue.length > 0) throw new DecryptionError("The downloaded file is larger than expected.");
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (index !== total) throw new DecryptionError("The download ended early. Please try again.");
}
