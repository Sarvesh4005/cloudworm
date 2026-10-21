# CloudWorm

CloudWorm is a Wormhole-style file transfer app with **real end-to-end encryption**.
Senders drag and drop files, which are encrypted in the browser with AES-256-GCM and
uploaded straight to a private S3 bucket. The sender gets back a link and a QR code.
The decryption key lives only in the link's `#fragment`, so CloudWorm's servers, and
AWS, only ever hold ciphertext.

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS 4, WebCrypto |
| API | Amazon API Gateway (HTTP API), throttled, CORS locked to the site origin |
| Compute | Two Python 3.13 Lambdas (sender / receiver), least-privilege IAM |
| Storage | Amazon S3: Block Public Access, SSE-S3, TLS-only, presigned URLs, multipart |
| Metadata | Amazon DynamoDB (on-demand) |
| Hosting | S3 + CloudFront (Origin Access Control, CSP, HSTS, `no-referrer`) |
| IaC | AWS SAM (`template.yaml`) |
| Tests | pytest + moto (backend), Vitest + Testing Library (frontend), live integration tests |

**Contents:** [Features](#features) · [How it works](#how-it-works) · [Security model](#security-model-read-this) · [Project structure](#project-structure) · [Mac setup](#1-mac-setup-one-time) · [Local dev](#2-local-development-no-aws-needed) · [Tests](#3-tests) · [Deploy](#4-deploy-to-aws) · [Cleanup](#5-cleanup-delete-everything) · [Costs](#6-cost-control) · [Every command](#7-every-command-in-order) · [Troubleshooting](#troubleshooting)

---

## Features

- Drag-and-drop or browse, with multiple files per transfer.
- Per-file and overall upload progress, plus a cancel button.
- Large files use S3 multipart uploads: 8 MiB encrypted parts, 3 in parallel, with automatic retries and URL refresh.
- 128-bit cryptographically random transfer IDs, and 256-bit encryption keys.
- A share link plus QR code, with a copy button.
- **Receiver page:** decrypted file names, sizes, per-file download counts, and an expiry countdown.
- Downloads stream and decrypt chunk by chunk:
  - **Chrome and Edge:** written straight to disk.
  - **Other browsers:** built as a Blob in memory.
- Configurable expiry options (default 1 h / 1 day / 3 days / 7 days), enforced **in code on every request**.
- Download counts and transfer status (`uploading`, `ready`, `deleted`, `failed`).
- Senders can **delete a transfer immediately**. A "Sent from this device" list lets them re-copy links or revoke them.
- Clear errors for expired, deleted or invalid links, a missing or wrong key, a wrong access code, throttling, network failures and upload verification failures.
- Responsive dark UI, with keyboard and screen-reader friendly controls.

## How it works

The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Browser ──(JSON)──► API Gateway ──► Lambda ──► DynamoDB (metadata)
   │                                   └─────► presigns short-lived S3 URLs
   └──(encrypted bytes, presigned PUT/GET)──► S3   (never through Lambda)
```

1. The browser generates a key and encrypts the file names. It calls
   `POST /transfers` with the **access code**, the sizes and the encrypted names.
2. The Lambda validates everything and creates the S3 multipart uploads. It returns a
   transfer ID and an **owner token**; only the token's hash is stored.
3. The browser encrypts each 8 MiB chunk and PUTs it to S3 with a presigned URL. Each
   URL lasts at most 15 minutes and has its exact `Content-Length` signed in.
4. `complete` checks the stored object size **exactly** with `HeadObject`. `finalize`
   then marks the transfer `ready`.
5. The receiver opens `https://site/t/<id>#<key>`:
   - `GET /transfers/<id>` returns the metadata.
   - `POST …/download-url` increments the counter **atomically**, and only while the
     transfer is ready and unexpired. It returns a GET URL that lasts at most 5 minutes.
   - The browser downloads and decrypts.

## Security model (read this)

**What is protected**
- **End-to-end encryption** with AES-256-GCM:
  - One key per file (HKDF), plus authenticated chunks with counter and last-chunk
    flag IVs, so tampering, reordering and truncation are all detected.
  - File names and MIME types are encrypted too.
  - The server stores only ciphertext, plaintext sizes and timestamps.
- **The key never reaches the server.** Browsers don't send the `#fragment` in
  requests. The site also sets `Referrer-Policy: no-referrer`.
- **The S3 bucket is fully private:**
  - Block Public Access, Bucket Owner Enforced, SSE-S3 encryption at rest, and a
    bucket policy that denies non-TLS access.
  - Every access goes through short-lived presigned URLs, issued only after
    server-side validation.
- **Least-privilege IAM:**
  - The receiver Lambda can only `GetObject` and read or update its table.
  - The sender Lambda can't list the bucket. Both are scoped to `transfers/*`.
- **Abuse controls:**
  - A shared upload **access code**. AWS stores only its SHA-256 hash, as a NoEcho
    parameter, and checks it in constant time. Uploads fail closed if it isn't set.
  - API throttling.
  - Limits on file count, per-file size and per-transfer size.
  - An optional extension allowlist.
  - Exact size verification.
- **Expiry does not depend on TTL or Lifecycle.** Every request checks `expiresAt`.
  Download URLs are issued through a conditional DynamoDB update, and are capped at
  the transfer's remaining lifetime. DynamoDB TTL and S3 Lifecycle only clean up
  afterwards, possibly days later.

**Limitations you should understand**
- **Links are bearer tokens.** Anyone who gets the full link can download and
  decrypt the files until they expire or the sender deletes them. That includes
  links sent through chat apps, read by browser extensions, or saved in history.
  Share links over channels you trust.
- **Without the `#key`**, a transfer ID alone still reveals some metadata (file
  count, sizes, timestamps, download counts) and lets someone download the
  ciphertext. It does not reveal names or contents.
- **Server-side encryption (SSE-S3) alone would *not* protect you from AWS or from
  anyone with access to the account.** S3 decrypts objects transparently for any
  authorised request. In CloudWorm, SSE-S3 is just a second layer under the
  browser-side encryption.
- **You must trust the JavaScript the site serves.** Whoever controls the
  CloudFront distribution or the site bucket could ship code that leaks keys. This
  limitation applies to every web-based E2E tool.
- **The allowed-extension check can't be fully enforced.** Contents are encrypted,
  so the server can only check the extension the client *declares*.
- **Download counts** count issued download URLs, not completed downloads.
- **A presigned URL issued just before expiry or deletion** keeps working until it
  expires: at most 5 minutes, and never past the transfer's expiry.
- **The "Sent from this device" list** stores keys and owner tokens in this
  browser's `localStorage`.
- **The access code is shared.** Anyone who has it can upload. Rotate it by
  redeploying with a new code.

## Project structure

```
.
├── README.md
├── template.yaml               # AWS SAM: S3, DynamoDB, Lambdas, HTTP API, CloudFront, Budget
├── samconfig.toml              # non-secret SAM defaults (stack "cloudworm", ap-south-1)
├── docs/ARCHITECTURE.md        # design, crypto format, data model
├── scripts/
│   ├── dev-backend.sh          # offline backend (moto) for local dev
│   ├── hash-access-code.sh     # SHA-256 of your access code
│   ├── deploy-backend.sh       # sam build + sam deploy
│   ├── deploy-frontend.sh      # build SPA, upload to S3, invalidate CloudFront
│   └── destroy.sh              # empty buckets + delete stack
├── backend/
│   ├── src/cloudworm/
│   │   ├── config.py           # settings + chunk/ciphertext size math
│   │   ├── core.py             # clients, validation, persistence helpers
│   │   ├── http.py             # API Gateway v2 event helpers, error envelope
│   │   ├── sender.py           # create / upload-urls / complete / finalize / delete
│   │   └── receiver.py         # config / metadata / download-url
│   ├── site/cloudworm_site.py  # SiteHosting=api: serves the built app from the API
│   ├── local/dev_server.py     # runs the real handlers + moto S3/DynamoDB offline
│   ├── tests/                  # pytest unit tests (moto) + integration/test_live_api.py
│   ├── requirements-dev.txt
│   ├── pytest.ini
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── lib/crypto.ts       # E2E encryption (WebCrypto)
    │   ├── lib/upload.ts       # encrypted multipart upload engine
    │   ├── lib/download.ts     # streaming download + decrypt
    │   ├── lib/api.ts          # typed API client
    │   ├── pages/              # SendPage, ReceivePage
    │   ├── components/         # Dropzone, ShareCard (QR), RecentTransfers, UI kit
    │   └── **/*.test.ts(x)     # Vitest tests (+ e2e.integration.test.ts)
    ├── .env.example
    └── package.json
```

### API

| Method & path | Who | Purpose |
|---|---|---|
| `GET /config` | public | Limits, expiry options, chunk size |
| `POST /transfers` | access code | Create a transfer and return the ID, owner token and part counts |
| `POST /transfers/{id}/files/{i}/upload-urls` | owner token | Presigned PUT URLs, in batches of up to 50 |
| `POST /transfers/{id}/files/{i}/complete` | owner token | Complete the multipart upload and verify the size |
| `POST /transfers/{id}/finalize` | owner token | Mark the transfer `ready` |
| `DELETE /transfers/{id}` | owner token | Delete the objects and revoke immediately |
| `GET /transfers/{id}` | link | Metadata: encrypted names, sizes, counts, expiry |
| `POST /transfers/{id}/files/{i}/download-url` | link | Count the download and return a presigned GET (≤ 5 min) |

The owner token travels in the `x-owner-token` header. Errors look like
`{"error": {"code": "...", "message": "..."}}`.

### Configuration (SAM parameters)

| Parameter | Default | Notes |
|---|---|---|
| `UploadAccessCodeHash` | — (required) | SHA-256 hex of the access code |
| `MaxFiles` / `MaxFileBytes` / `MaxTransferBytes` | 50 / 2 GiB / 5 GiB | |
| `ExpiryHoursOptions` / `DefaultExpiryHours` | `1,24,72,168` / 24 | |
| `AllowedExtensions` | empty (all types) | e.g. `pdf,png,zip` |
| `ObjectRetentionDays` | 8 | Lifecycle cleanup; must exceed the longest expiry |
| `ApiRateLimit` / `ApiBurstLimit` | 10 / 20 | Per route |
| `SiteHosting` | `cloudfront` | `cloudfront`, `api` or `none`; see [Hosting modes](#hosting-modes) |
| `DevAllowedOrigin` | empty | e.g. `http://localhost:5173` for local frontend + cloud API. Required when `SiteHosting=none` |
| `BudgetAlertEmail` / `MonthlyBudgetUsd` | empty / 5 | Creates an AWS Budget when the email is set |

### Hosting modes

| `SiteHosting` | Where the app is served | When to use it |
|---|---|---|
| `cloudfront` (default) | Private S3 bucket behind CloudFront, with security headers | Normal production setup |
| `api` | A small `SiteFunction` Lambda serves the built app from the HTTP API's own HTTPS URL. The app and API share one origin, so the API needs no CORS. | New AWS accounts are blocked from creating CloudFront distributions until AWS Support verifies them. This mode needs no CloudFront. |
| `none` | No hosted site; the frontend runs on your Mac against the deployed API | Backend-only testing. Requires `DevAllowedOrigin`, and share links only work on your machine. |

In `api` mode:
- Only the small static bundle (~350 KB) goes through Lambda. Files still go directly
  between the browser and S3.
- The Lambda adds the same security headers that CloudFront would: CSP, HSTS,
  `no-referrer` and `X-Frame-Options: DENY`.
- The trade-offs are a long `execute-api` URL, an occasional cold start of about half
  a second, and page loads counting toward the API's rate limit.
- Moving to CloudFront later takes one redeploy with `SITE_HOSTING=cloudfront`,
  followed by `scripts/deploy-frontend.sh`.

---

## 1. Mac setup (one time)

```bash
brew install node python@3.13 awscli aws-sam-cli
```

- If `aws-sam-cli` isn't in Homebrew for your setup, use AWS's official macOS `.pkg`
  installer for the SAM CLI instead.
- Docker is **not** required.
- Node 20+ is fine (this was built with Node 24).
- `python@3.13` matches the Lambda runtime and is needed for `sam build`. The
  scripts fall back gracefully without it.

Install the project dependencies:

```bash
python3.13 -m venv backend/.venv
```

```bash
backend/.venv/bin/pip install -r backend/requirements-dev.txt
```

```bash
npm --prefix frontend install
```

(Python 3.11 or 3.12 also works for local dev and tests.)

## 2. Local development (no AWS needed)

The offline backend runs the **real Lambda handlers**. A small HTTP shim stands in
for API Gateway, and [moto](https://github.com/getmoto/moto) emulates S3 and
DynamoDB in memory. Data is wiped when you stop it.

Terminal 1, the backend (API on `http://127.0.0.1:3001`, access code `local-dev-code`):

```bash
scripts/dev-backend.sh
```

Terminal 2, the frontend:

```bash
cp frontend/.env.example frontend/.env.local
```

```bash
npm --prefix frontend run dev
```

Open http://localhost:5173. Drop some files, enter `local-dev-code`, and open the
link you get back in another tab.

> **Notes:**
> - WebCrypto only works on `https://` or `localhost`. Testing from a phone on your
>   LAN therefore needs the deployed site, or an HTTPS tunnel.
> - To run the local frontend against the **deployed** API instead, deploy with
>   `DEV_ORIGIN=http://localhost:5173`. Then set `VITE_API_URL` in
>   `frontend/.env.local` to the stack's `ApiUrl`.

**Trying the `SiteHosting=api` setup offline.** In this mode the backend serves the app
itself, on one origin, with the real security headers. Build the frontend in
same-origin mode:

```bash
VITE_API_URL=same-origin npm --prefix frontend run build
```

Then start the backend with site serving turned on, and open http://127.0.0.1:3001:

```bash
CLOUDWORM_SERVE_SITE=1 scripts/dev-backend.sh
```

## 3. Tests

**Backend unit tests.** These use pytest with moto and need no AWS:

```bash
cd backend && .venv/bin/python -m pytest
```

**Frontend unit tests.** These cover crypto, the upload engine, the API client and
the pages:

```bash
npm --prefix frontend test
```

**Typecheck and production build:**

```bash
npm --prefix frontend run build
```

**Integration tests** run against a live API, either the local dev server or the
deployed stack. They are skipped unless both environment variables are set.
- The backend integration test uploads, downloads, byte-compares and deletes a
  single-PUT file and a multipart file.
- The frontend integration test does the same through the real encryption and
  upload/download engines.

With `scripts/dev-backend.sh` running:

```bash
cd backend && CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code .venv/bin/python -m pytest tests/integration -v
```

```bash
cd frontend && CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code npx vitest run src/e2e.integration.test.ts
```

Against AWS after deploying, use your real `ApiUrl` and code. Note that
`CLOUDWORM_ACCESS_CODE` will be in your shell history.

```bash
cd backend && CLOUDWORM_API_URL=https://XXXX.execute-api.ap-south-1.amazonaws.com CLOUDWORM_ACCESS_CODE='your-code' .venv/bin/python -m pytest tests/integration -v
```

**Manual checklist after deploying:**
1. Open the `SiteUrl` and send two files, one of them over 8 MiB.
2. Open the link in a private window and on a phone (scan the QR code). Check the
   names, sizes and expiry, then download both and confirm they open.
3. Remove the `#…` part of the link and confirm you see "Missing decryption key".
4. Change one character of the ID and confirm you see "Transfer not found".
5. Click **Delete now** and confirm the link shows "This transfer was deleted".
6. Send with a 1-hour expiry, come back later, and confirm you see "This transfer has expired".

## 4. Deploy to AWS

**Prerequisites:**
- An AWS account and an IAM user or SSO role that can create CloudFormation stacks.
  For learning, `AdministratorAccess` on a dedicated account is simplest.
- Don't use the root user.

```bash
aws configure
```

(Or run `aws configure sso`.) Set the region to `ap-south-1`. Check who you are:

```bash
aws sts get-caller-identity
```

Create a strong upload access code and store it in a password manager:

```bash
openssl rand -base64 18
```

Deploy the backend and infrastructure. The script prompts for the code and sends only
its SHA-256 hash to AWS. The first deploy takes about 5–10 minutes because of
CloudFront.

```bash
BUDGET_EMAIL=you@example.com scripts/deploy-backend.sh
```

- Review the change set and answer `y`.
- Optional extra environment variables: `DEV_ORIGIN=http://localhost:5173` and
  `ALLOWED_EXTENSIONS=pdf,png,zip`.

Build and publish the frontend. This writes `frontend/.env.production` with your
`ApiUrl`, uploads to S3 and invalidates CloudFront:

```bash
scripts/deploy-frontend.sh
```

Open the printed `SiteUrl`. To change settings, or to **rotate the access code**,
rerun `scripts/deploy-backend.sh`.

**If AWS says "Your account must be verified before you can add new CloudFront
resources":**
- This is a restriction on new AWS accounts. Open a free support case under
  **Account and billing** asking AWS to verify the account for CloudFront.
- Meanwhile, deploy with the API serving the site. The script builds the frontend and
  bundles it automatically, so you don't run `deploy-frontend.sh` in this mode:
  ```bash
  SITE_HOSTING=api BUDGET_EMAIL=you@example.com scripts/deploy-backend.sh
  ```
- If a failed first deploy left the stack in `ROLLBACK_COMPLETE`, delete that empty
  stack record first:
  ```bash
  aws cloudformation delete-stack --stack-name cloudworm --region ap-south-1
  ```
- After AWS verifies the account, switch to CloudFront:
  ```bash
  SITE_HOSTING=cloudfront BUDGET_EMAIL=you@example.com scripts/deploy-backend.sh
  ```
  ```bash
  scripts/deploy-frontend.sh
  ```

**Viewing logs:**

```bash
sam logs --stack-name cloudworm --region ap-south-1 --tail
```

## 5. Cleanup (delete everything)

This permanently deletes every transfer and the site:

```bash
scripts/destroy.sh
```

The script empties both buckets, aborts any unfinished multipart uploads, and runs
`sam delete`. Afterwards:
- Check **CloudFormation → Stacks** to confirm `cloudworm` is gone.
- Check **S3** for the leftover `aws-sam-cli-managed-default-…` artifact bucket, and
  delete it if you no longer use SAM.
- Keep an eye on **Billing → Bills** for a day or two.

## 6. Cost control

For light, personal or class use, this stack typically costs **a few cents to a few
dollars a month**. At idle it costs close to nothing, because there are no servers,
no NAT gateways and no provisioned capacity.

All figures below are approximate. Check the [AWS Pricing Calculator](https://calculator.aws/)
for ap-south-1, and note that Free Tier terms depend on when your account was created.

| Service | What you pay for | Notes |
|---|---|---|
| **S3 data transfer out** | Each GB downloaded from S3 to the internet (~US$0.11/GB in ap-south-1, after any free allowance) | **The biggest cost driver.** One 2 GB file downloaded 50 times ≈ 100 GB of egress. |
| S3 storage | ~US$0.025/GB-month | Small, because transfers expire and lifecycle cleanup runs. |
| S3 requests | PUT/GET requests (one per 8 MiB part) | Fractions of a cent per transfer. |
| API Gateway HTTP API | ~US$1 per million requests | |
| Lambda | Requests and GB-seconds (arm64, 256 MB, millisecond runtimes) | Usually within the free allowance. |
| DynamoDB on-demand | Per read/write | Fractions of a cent. |
| CloudFront | Site delivery (~300 KB per visit) | Usually within the free allowance. |
| CloudWatch Logs | Ingestion and storage | Retention is set to 14 days. |

**Recommendations**
1. **Create a budget.** Deploy with `BUDGET_EMAIL=…`. You'll get emails at 50% and
   100% of actual spend, and at 100% of forecast spend, against a US$5/month budget
   (`BUDGET_USD` changes it). The first two AWS Budgets are free.
2. In **Billing → Billing preferences**, turn on **Free Tier usage alerts**. Also
   consider enabling **Cost Anomaly Detection**, which is free.
3. Keep the access code secret, and **rotate it** if it leaks. It's what stops
   strangers from using your bucket as free storage and bandwidth.
4. Keep the size limits modest. Lower `MaxFileBytes` and `MaxTransferBytes`, or
   tighten `ApiRateLimit`, if costs creep up.
5. Delete transfers you no longer need, and run `scripts/destroy.sh` when the
   project or demo is over.
6. Don't enable S3 versioning, DynamoDB point-in-time recovery or WAF unless you
   need them. Each one adds cost, and WAF alone is roughly US$5+/month.

---

## 7. Every command, in order

```bash
# --- one-time Mac setup ---
brew install node python@3.13 awscli aws-sam-cli
python3.13 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
npm --prefix frontend install

# --- run the tests ---
(cd backend && .venv/bin/python -m pytest)
npm --prefix frontend test
npm --prefix frontend run build

# --- local development (two terminals) ---
scripts/dev-backend.sh                                   # terminal 1
cp frontend/.env.example frontend/.env.local             # terminal 2 (once)
npm --prefix frontend run dev                            # terminal 2 → http://localhost:5173, code: local-dev-code

# --- local integration tests (with dev-backend running) ---
(cd backend && CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code .venv/bin/python -m pytest tests/integration -v)
(cd frontend && CLOUDWORM_API_URL=http://127.0.0.1:3001 CLOUDWORM_ACCESS_CODE=local-dev-code npx vitest run src/e2e.integration.test.ts)

# --- deploy to AWS (ap-south-1) ---
aws configure                                            # or: aws configure sso
aws sts get-caller-identity
openssl rand -base64 18                                  # your upload access code, save it
BUDGET_EMAIL=you@example.com scripts/deploy-backend.sh  # prompts for the code
scripts/deploy-frontend.sh                               # prints your SiteUrl
# (account not yet verified for CloudFront? instead run:)
SITE_HOSTING=api BUDGET_EMAIL=you@example.com scripts/deploy-backend.sh   # site served by the API

# --- after deploying ---
sam logs --stack-name cloudworm --region ap-south-1 --tail

# --- tear down ---
scripts/destroy.sh
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Couldn't reach CloudWorm" locally | Is `scripts/dev-backend.sh` running? Is `VITE_API_URL` in `frontend/.env.local` set to `http://127.0.0.1:3001`? Restart `npm run dev` after editing env files. |
| CORS error in the browser console | The page origin must be the CloudFront `SiteUrl`, or `DEV_ORIGIN` if you deployed with it. Redeploy the backend after changing `DEV_ORIGIN`. |
| "Uploads are disabled on this server" | The stack was deployed without an access-code hash. Rerun `scripts/deploy-backend.sh`. |
| "Encryption unavailable" | You opened the app over plain `http://` on a non-localhost address. Use HTTPS. |
| Large download fails on iPhone / Safari | Non-Chromium browsers decrypt into memory. Use desktop Chrome or Edge for very large files, or lower `MaxFileBytes`. |
| `sam build` complains about the Python version | `brew install python@3.13`, or let the deploy script skip the build. The Lambdas have no third-party dependencies. |
| Site shows old content after deploy | Wait a minute for the CloudFront invalidation, then hard-refresh. |
| "Your account must be verified before you can add new CloudFront resources" | Open an AWS Support case (Account and billing), and deploy with `SITE_HOSTING=api` meanwhile. See [Deploy to AWS](#4-deploy-to-aws). |
| "CloudWorm site bundle is missing" (`SiteHosting=api`) | Deploy through `scripts/deploy-backend.sh`, which builds the frontend into `backend/site/dist`, rather than plain `sam deploy`. |
