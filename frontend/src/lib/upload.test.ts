// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api, type PublicConfig } from "./api";
import { CHUNK_SIZE, chunkCount, decryptMetadata, decryptStream, deriveFileKey, deriveMetaKey, importTransferKey } from "./crypto";
import { UploadHttpError, fileExtension, sendFiles, validateSelection, type PutFn } from "./upload";

const config: PublicConfig = {
  maxFiles: 3,
  maxFileBytes: 40 * 1024 * 1024,
  maxTransferBytes: 50 * 1024 * 1024,
  expiryHoursOptions: [1, 24],
  defaultExpiryHours: 24,
  allowedExtensions: [],
  chunkBytes: CHUNK_SIZE,
  tagBytes: 16,
  uploadsEnabled: true,
};

function bytes(n: number, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

/** In-memory fake of the API + S3, recording everything the client sends. */
function fakeBackend() {
  const stored = new Map<string, Uint8Array>(); // url -> bytes
  const created: { files: { size: number; encName: string; ext?: string }[] }[] = [];
  const completions: { index: number; parts: unknown }[] = [];
  const api = {
    createTransfer: vi.fn(async (req) => {
      created.push(req);
      return {
        transferId: "T".repeat(22),
        ownerToken: "o".repeat(43),
        expiresAt: 9_999_999_999,
        files: req.files.map((f: { size: number }, index: number) => ({ index, partCount: chunkCount(f.size) })),
      };
    }),
    getUploadUrls: vi.fn(async (_id: string, index: number, partNumbers: number[]) => ({
      expiresIn: 900,
      urls: partNumbers.map((n) => ({ partNumber: n, url: `https://s3.test/${index}/${n}` })),
    })),
    completeFile: vi.fn(async (_id: string, index: number, parts: unknown) => {
      completions.push({ index, parts });
      return { index, uploaded: true };
    }),
    finalize: vi.fn(async () => ({}) as never),
    deleteTransfer: vi.fn(async () => ({ status: "deleted" })),
  } as unknown as Api;
  const put: PutFn = async (url, body, onProgress) => {
    stored.set(url, new Uint8Array(body));
    onProgress(body.byteLength);
    return `"etag-${url.split("/").slice(-2).join("-")}"`;
  };
  return { api, put, stored, created, completions };
}

async function readBack(stored: Map<string, Uint8Array>, index: number, parts: number) {
  const pieces = Array.from({ length: parts }, (_, i) => stored.get(`https://s3.test/${index}/${i + 1}`)!);
  return new ReadableStream<Uint8Array>({
    start(c) {
      pieces.forEach((p) => c.enqueue(p));
      c.close();
    },
  });
}

describe("sendFiles", () => {
  it("encrypts, uploads, completes and finalizes; the receiver can decrypt", async () => {
    const be = fakeBackend();
    const small = new File([bytes(1000)], "notes.txt", { type: "text/plain" });
    const bigData = bytes(CHUNK_SIZE * 2 + 99, 7);
    const big = new File([bigData], "video.mp4", { type: "video/mp4" });
    const progress = vi.fn();

    const result = await sendFiles({
      api: be.api,
      config,
      files: [small, big],
      accessCode: "code",
      expiresInHours: 24,
      signal: new AbortController().signal,
      put: be.put,
      onProgress: progress,
    });

    expect(result.transferId).toBe("T".repeat(22));
    expect(result.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Plaintext names never reach the server; no extension leaked when no allowlist is set.
    const sent = JSON.stringify(be.created[0]);
    expect(sent).not.toContain("notes");
    expect(sent).not.toContain("video");
    expect(be.created[0].files[0].ext).toBeUndefined();

    expect(be.completions[0]).toEqual({ index: 0, parts: null });
    expect(be.completions[1].parts).toEqual([
      { partNumber: 1, etag: '"etag-1-1"' },
      { partNumber: 2, etag: '"etag-1-2"' },
      { partNumber: 3, etag: '"etag-1-3"' },
    ]);
    expect(be.api.finalize).toHaveBeenCalledOnce();
    expect(be.api.deleteTransfer).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalled();

    // Receiver side: derive keys from the link key and decrypt what "S3" stored.
    const master = await importTransferKey(result.key);
    const meta = await decryptMetadata(await deriveMetaKey(master), be.created[0].files[1].encName);
    expect(meta).toEqual({ name: "video.mp4", type: "video/mp4" });
    const out: Uint8Array<ArrayBuffer>[] = [];
    await decryptStream(await readBack(be.stored, 1, 3), await deriveFileKey(master, 1), bigData.length, (c) => {
      out.push(c);
    });
    const roundTrip = new Uint8Array(await new Blob(out).arrayBuffer());
    expect(Buffer.from(roundTrip).equals(Buffer.from(bigData))).toBe(true);
  });

  it("sends the extension only when the server enforces an allowlist", async () => {
    const be = fakeBackend();
    await sendFiles({
      api: be.api,
      config: { ...config, allowedExtensions: ["pdf"] },
      files: [new File(["x"], "Report.PDF")],
      accessCode: "c",
      expiresInHours: 1,
      signal: new AbortController().signal,
      put: be.put,
    });
    expect(be.created[0].files[0].ext).toBe("pdf");
  });

  it("retries transient storage failures", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const be = fakeBackend();
    let failures = 1;
    const flaky: PutFn = async (...args) => {
      if (failures-- > 0) throw new UploadHttpError(503);
      return be.put(...args);
    };
    const run = sendFiles({
      api: be.api,
      config,
      files: [new File(["hello"], "a.txt")],
      accessCode: "c",
      expiresInHours: 1,
      signal: new AbortController().signal,
      put: flaky,
    });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeTruthy();
    expect(be.api.getUploadUrls).toHaveBeenCalledTimes(2); // URL refreshed on retry
    vi.useRealTimers();
  });

  it("cleans up the transfer when an upload fails permanently", async () => {
    const be = fakeBackend();
    const failing: PutFn = async () => {
      throw new UploadHttpError(400);
    };
    await expect(
      sendFiles({
        api: be.api,
        config,
        files: [new File(["hello"], "a.txt")],
        accessCode: "c",
        expiresInHours: 1,
        signal: new AbortController().signal,
        put: failing,
      }),
    ).rejects.toBeInstanceOf(UploadHttpError);
    expect(be.api.deleteTransfer).toHaveBeenCalledOnce();
    expect(be.api.finalize).not.toHaveBeenCalled();
  });

  it("surfaces API errors such as a wrong access code without uploading", async () => {
    const be = fakeBackend();
    (be.api.createTransfer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(401, "invalid_access_code", "bad"),
    );
    await expect(
      sendFiles({
        api: be.api,
        config,
        files: [new File(["x"], "a.txt")],
        accessCode: "nope",
        expiresInHours: 1,
        signal: new AbortController().signal,
        put: be.put,
      }),
    ).rejects.toMatchObject({ code: "invalid_access_code" });
    expect(be.stored.size).toBe(0);
  });
});

describe("validateSelection", () => {
  it("mirrors server limits", () => {
    const f = (n: number, name = "a.bin") => new File([new Uint8Array(n)], name);
    expect(validateSelection([], config)).toMatch(/at least one/);
    expect(validateSelection([f(1), f(1), f(1), f(1)], config)).toMatch(/at most 3/);
    expect(validateSelection([f(41 * 1024 * 1024)], config)).toMatch(/per-file/);
    expect(validateSelection([f(30 * 1024 * 1024), f(30 * 1024 * 1024)], config)).toMatch(/total/);
    expect(validateSelection([f(1, "x.exe")], { ...config, allowedExtensions: ["pdf"] })).toMatch(/not an allowed/);
    expect(validateSelection([f(1)], config)).toBeNull();
  });

  it("extracts extensions", () => {
    expect(fileExtension("a.tar.GZ")).toBe("gz");
    expect(fileExtension("README")).toBeUndefined();
  });
});
