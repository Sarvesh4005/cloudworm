// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  DecryptionError,
  InvalidKeyError,
  TAG_SIZE,
  chunkCount,
  chunkIv,
  ciphertextSize,
  decryptChunk,
  decryptMetadata,
  decryptStream,
  deriveFileKey,
  deriveMetaKey,
  encryptChunk,
  encryptMetadata,
  encryptedChunkSize,
  fromBase64Url,
  generateTransferKey,
  importTransferKey,
  toBase64Url,
} from "./crypto";

/** Byte equality without vitest's deep-diff (which is O(n) objects for typed arrays). */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function encryptWhole(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const parts = chunkCount(data.length);
  const out = new Uint8Array(ciphertextSize(data.length));
  let offset = 0;
  for (let i = 0; i < parts; i++) {
    const pt = data.slice(i * CHUNK_SIZE, Math.min(data.length, (i + 1) * CHUNK_SIZE));
    const ct = new Uint8Array(await encryptChunk(key, i, i === parts - 1, pt));
    out.set(ct, offset);
    offset += ct.length;
  }
  return out;
}

/** Feed bytes to decryptStream in irregular network-sized pieces. */
function streamOf(bytes: Uint8Array, pieceSize = 777_777): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(pos, pos + pieceSize));
      pos += pieceSize;
    },
  });
}

async function decryptAll(key: CryptoKey, ct: Uint8Array, size: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await decryptStream(streamOf(ct), key, size, (c) => {
    chunks.push(c);
  });
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

describe("size math (must match backend config.py)", () => {
  it("matches the server's ciphertext formula", () => {
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(ciphertextSize(0)).toBe(TAG_SIZE);
    expect(ciphertextSize(10)).toBe(26);
    expect(ciphertextSize(CHUNK_SIZE)).toBe(CHUNK_SIZE + 16);
    expect(ciphertextSize(CHUNK_SIZE + 1)).toBe(CHUNK_SIZE + 1 + 32);
    expect(encryptedChunkSize(CHUNK_SIZE * 2 + 3, 2)).toBe(3 + 16);
  });
});

describe("keys", () => {
  it("generates 256-bit base64url keys", () => {
    const k = generateTransferKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(k)).toHaveLength(32);
    expect(generateTransferKey()).not.toBe(k);
  });

  it("rejects malformed keys", async () => {
    await expect(importTransferKey("")).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(importTransferKey("abc")).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(importTransferKey("!!!not-base64!!!")).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it("base64url round-trips", () => {
    const b = randomBytes(100);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
  });

  it("encodes chunk index and last flag in the IV", () => {
    const iv = chunkIv(258, true);
    expect(Array.from(iv)).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1]);
  });
});

describe("file encryption", () => {
  it("round-trips a multi-chunk file through the streaming decryptor", async () => {
    const master = await importTransferKey(generateTransferKey());
    const key = await deriveFileKey(master, 0);
    const data = randomBytes(CHUNK_SIZE * 2 + 12_345);
    const ct = await encryptWhole(key, data);
    expect(ct.length).toBe(ciphertextSize(data.length));
    expect(same(await decryptAll(key, ct, data.length), data)).toBe(true);
  });

  it("round-trips an empty file", async () => {
    const key = await deriveFileKey(await importTransferKey(generateTransferKey()), 3);
    const ct = await encryptWhole(key, new Uint8Array(0));
    expect(ct.length).toBe(16);
    expect(await decryptAll(key, ct, 0)).toHaveLength(0);
  });

  it("detects tampering", async () => {
    const key = await deriveFileKey(await importTransferKey(generateTransferKey()), 0);
    const ct = await encryptWhole(key, randomBytes(1000));
    ct[10] ^= 0xff;
    await expect(decryptAll(key, ct, 1000)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("detects truncation (dropping the final chunk)", async () => {
    const key = await deriveFileKey(await importTransferKey(generateTransferKey()), 0);
    const size = CHUNK_SIZE + 50;
    const ct = await encryptWhole(key, randomBytes(size));
    const truncated = ct.slice(0, CHUNK_SIZE + TAG_SIZE);
    // Claims to be a one-chunk file: chunk 0 was encrypted with last=false, so it must fail.
    await expect(decryptAll(key, truncated, CHUNK_SIZE)).rejects.toBeInstanceOf(DecryptionError);
    // With the true size, the stream simply ends early.
    await expect(decryptAll(key, truncated, size)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("uses a different key per file and per transfer", async () => {
    const master = await importTransferKey(generateTransferKey());
    const pt = randomBytes(64);
    const a = new Uint8Array(await encryptChunk(await deriveFileKey(master, 0), 0, true, pt));
    const b = new Uint8Array(await encryptChunk(await deriveFileKey(master, 1), 0, true, pt));
    expect(a).not.toEqual(b);
    const other = await deriveFileKey(await importTransferKey(generateTransferKey()), 0);
    await expect(decryptChunk(other, 0, true, a)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("metadata encryption", () => {
  it("round-trips names and rejects the wrong key", async () => {
    const meta = await deriveMetaKey(await importTransferKey(generateTransferKey()));
    const blob = await encryptMetadata(meta, { name: "Résumé 2026 📄.pdf", type: "application/pdf" });
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blob).not.toContain("sum");
    expect(await decryptMetadata(meta, blob)).toEqual({ name: "Résumé 2026 📄.pdf", type: "application/pdf" });
    const wrong = await deriveMetaKey(await importTransferKey(generateTransferKey()));
    await expect(decryptMetadata(wrong, blob)).rejects.toBeInstanceOf(DecryptionError);
  });
});
