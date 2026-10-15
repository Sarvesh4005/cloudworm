// @vitest-environment node
/**
 * End-to-end test of the real frontend engines (encryption, chunked/multipart upload,
 * streaming download + decryption) against a running CloudWorm API.
 * Skipped unless CLOUDWORM_API_URL and CLOUDWORM_ACCESS_CODE are set, e.g.:
 *
 *   CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code npx vitest run src/e2e.integration.test.ts
 */
import { describe, expect, it } from "vitest";
import { createApi } from "./lib/api";
import { CHUNK_SIZE, decryptMetadata, deriveMetaKey, importTransferKey } from "./lib/crypto";
import { downloadFile, type Sink } from "./lib/download";
import { sendFiles, type PutFn } from "./lib/upload";

const API = process.env.CLOUDWORM_API_URL ?? "";
const CODE = process.env.CLOUDWORM_ACCESS_CODE ?? "";

/** Node has no XMLHttpRequest; use fetch for the presigned PUTs. */
const fetchPut: PutFn = async (url, body, onProgress, signal) => {
  const res = await fetch(url, { method: "PUT", body, signal, headers: { "content-type": "application/octet-stream" } });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
  onProgress(body.byteLength);
  return res.headers.get("etag") ?? "";
};

function pattern(n: number, seed: number) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 0xff;
  return b;
}

describe.skipIf(!API || !CODE)("live API end-to-end", () => {
  it("sends and receives files through real encryption, S3 and the API", async () => {
    const api = createApi(API);
    const config = await api.getConfig();
    const data = [pattern(5000, 1), pattern(CHUNK_SIZE * 2 + 1234, 2)];
    const files = [new File([data[0]], "hello.txt", { type: "text/plain" }), new File([data[1]], "big.bin")];

    const sent = await sendFiles({
      api, config, files, accessCode: CODE, expiresInHours: config.expiryHoursOptions[0],
      signal: new AbortController().signal, put: fetchPut,
    });

    const view = await api.getTransfer(sent.transferId);
    expect(view.status).toBe("ready");
    const master = await importTransferKey(sent.key);
    const metaKey = await deriveMetaKey(master);
    expect((await decryptMetadata(metaKey, view.files[1].encName)).name).toBe("big.bin");

    for (const f of view.files) {
      const parts: Uint8Array[] = [];
      const sink: Sink = { write: async (c) => void parts.push(c), close: async () => {}, abort: async () => {} };
      await downloadFile({ api, transferId: sent.transferId, master, index: f.index, size: f.size, ciphertextSize: f.ciphertextSize, sink });
      const got = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
      expect(Buffer.from(got).equals(Buffer.from(data[f.index]))).toBe(true);
    }

    expect((await api.getTransfer(sent.transferId)).totalDownloads).toBe(2);
    await api.deleteTransfer(sent.transferId, sent.ownerToken);
    await expect(api.getTransfer(sent.transferId)).rejects.toMatchObject({ code: "transfer_deleted" });
  }, 60_000);
});
