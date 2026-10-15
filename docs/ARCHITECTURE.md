# CloudWorm architecture

CloudWorm is a Wormhole-style file transfer app. Files are **encrypted in the
browser**, uploaded **directly to S3** with short-lived presigned URLs, and
downloaded and decrypted **in the receiver's browser**. AWS only ever stores
ciphertext.

```
            ┌───────────────────────────── browser (sender / receiver) ─────────────────────────────┐
            │  React SPA  ─ WebCrypto AES-256-GCM ─ key lives only in URL #fragment / memory          │
            └──────┬──────────────────────────────┬───────────────────────────────────▲───────────────┘
                   │ HTTPS (static site)          │ HTTPS JSON API                    │ HTTPS PUT/GET ciphertext
                   ▼                              ▼                                   │ (presigned, 5–15 min)
        ┌────────────────────┐        ┌──────────────────────────┐                    │
        │ CloudFront (OAC)   │        │ API Gateway HTTP API     │                    │
        │  + security headers│        │  CORS = site origin only │                    │
        └─────────┬──────────┘        │  throttling              │                    │
                  ▼                   └─────┬──────────────┬─────┘                    │
        ┌────────────────────┐              ▼              ▼                          │
        │ S3 site bucket     │      ┌──────────────┐ ┌──────────────┐                 │
        │ (private)          │      │ SenderFn     │ │ ReceiverFn   │                 │
        └────────────────────┘      │ create/presign│ │ metadata /   │                 │
                                    │ complete/del │ │ download URL │                 │
                                    └──┬────────┬──┘ └──┬────────┬──┘                 │
                                       ▼        ▼       ▼        ▼                    │
                               ┌─────────────┐ ┌────────────────────────────┐         │
                               │ DynamoDB    │ │ S3 files bucket            │◄────────┘
                               │ transfers   │ │ private, SSE-S3, TLS-only, │
                               │ (TTL=cleanup│ │ lifecycle = cleanup only   │
                               └─────────────┘ └────────────────────────────┘
```

## Request flow

### Send
1. `GET /config`: the browser reads limits (max file size, max files, expiry options).
2. The browser generates a random 256-bit **transfer key** (`crypto.getRandomValues`).
3. It encrypts each file name with a key derived from the transfer key, then calls
   `POST /transfers` with the **access code**, the expiry, and for each file its
   plaintext size and encrypted name.
4. The server checks the access code (constant-time compare against a SHA-256 hash),
   limits, expiry, and the optional extension allowlist. It then writes metadata to
   DynamoDB and returns:
   - a random **transfer ID** (128 bits, `secrets.token_urlsafe(16)`)
   - a random **owner token** (only its SHA-256 hash is stored)
   - the upload plan for each file: single `PUT`, or S3 multipart with N parts
5. The browser encrypts each 8 MiB chunk and requests presigned part URLs in batches
   (`POST …/upload-urls`, owner token required). It uploads each encrypted chunk
   **directly to S3** with XHR, which gives progress events.
6. `POST …/complete` finishes the multipart upload. The server runs `HeadObject` and
   checks that the stored size matches the expected ciphertext size **exactly**. On a
   mismatch it deletes the object and marks the file failed.
7. `POST …/finalize` marks the transfer `ready` once every file is verified.
8. The share link is `https://<site>/t/<transferId>#<key>`. Browsers never send the
   `#fragment` to any server.

### Receive
1. `GET /transfers/{id}` returns status, expiry, sizes, download counts and encrypted
   names. The browser decrypts the names with the key from the fragment.
2. `POST …/files/{i}/download-url` runs **one conditional DynamoDB update**: it
   increments the download count only if `status = ready AND expiresAt > now`. Only
   if that succeeds does the server presign a `GET` URL. The URL lives for at most
   300 s, and never past the transfer's expiry.
3. The browser streams the ciphertext, decrypts it chunk by chunk, and saves the
   result:
   - **Chromium:** streams to disk with the File System Access API.
   - **Other browsers:** builds a Blob.

## End-to-end encryption format (v1)

| Item | Construction |
|---|---|
| Transfer key `K` | 32 random bytes, base64url-encoded in the URL fragment |
| File key | `HKDF-SHA256(K, salt="", info="cloudworm/v1/file/<index>")` → AES-256-GCM |
| Metadata key | `HKDF-SHA256(K, salt="", info="cloudworm/v1/meta")` → AES-256-GCM |
| Chunking | Plaintext chunks of 8 MiB. Each chunk is encrypted independently and gains a 16-byte tag |
| Chunk IV (96-bit) | `uint64_be(chunkIndex) ‖ 0x000000 ‖ lastFlag` |
| Ciphertext size | `size + 16 × max(1, ceil(size / 8 MiB))` |
| Name blob | `base64url(iv12 ‖ AES-GCM(metaKey, JSON{name,type}))` with a random IV |

- Each file has its own derived key, and each chunk's IV is its index, so no
  `(key, IV)` pair is ever reused.
- The last-chunk flag in the IV detects truncation.
- The index in the IV detects reordering.
- GCM tags detect modification.
- One encrypted chunk equals one S3 multipart part, and each part is at least 5 MiB
  (except the last), as S3 requires.

## Data model (DynamoDB, one item per transfer)

```
transferId (PK)   status: uploading | ready | deleted | failed
createdAt, expiresAt (epoch s), ttl (= expiresAt + grace, cleanup only)
ownerTokenHash    totalDownloads
files: [ { index, encName, ext?, size, ctSize, partCount, uploadId?, uploaded, downloadCount } ]
```

S3 object keys are `transfers/<transferId>/<fileIndex>`. They contain no file names.

## Expiry enforcement

Expiry is enforced **in code on every request**:
- Reads compare `expiresAt` with the current time.
- Download URL issuance uses a conditional DynamoDB update.
- Presigned URLs are capped at the remaining lifetime.

DynamoDB TTL and the S3 lifecycle rules are **garbage collection only**. Either may
run hours or days late, and correctness never depends on them. Senders can also
delete a transfer immediately with their owner token.

## Abuse controls
- A shared upload access code. Only its SHA-256 hash is stored, as a NoEcho
  CloudFormation parameter.
- API Gateway throttling (stage default rate and burst).
- Server-side limits on file count, size per file, size per transfer, expiry options
  and the optional extension allowlist.
- Exact ciphertext size verification after upload. When it's supported, the
  `Content-Length` header is also signed into the presigned URLs.
- Owner token required for every sender operation after create.
- S3 lifecycle: abort incomplete multipart uploads after 1 day, and expire objects
  after the retention window.
- An optional AWS Budget with email alerts.
