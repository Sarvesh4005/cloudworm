/** Typed client for the CloudWorm HTTP API. Contains no AWS credentials, by design. */

export interface PublicConfig {
  maxFiles: number;
  maxFileBytes: number;
  maxTransferBytes: number;
  expiryHoursOptions: number[];
  defaultExpiryHours: number;
  allowedExtensions: string[];
  chunkBytes: number;
  tagBytes: number;
  uploadsEnabled: boolean;
}

export interface CreateTransferRequest {
  accessCode: string;
  expiresInHours: number;
  files: { size: number; encName: string; ext?: string }[];
}

export interface CreateTransferResponse {
  transferId: string;
  ownerToken: string;
  expiresAt: number;
  files: { index: number; partCount: number }[];
}

export type TransferStatus = "uploading" | "ready" | "deleted" | "failed";

export interface TransferFileView {
  index: number;
  encName: string;
  size: number;
  ciphertextSize: number;
  partCount: number;
  uploaded: boolean;
  downloadCount: number;
}

export interface TransferView {
  transferId: string;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number;
  totalDownloads: number;
  files: TransferFileView[];
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = typeof fetch;

export function createApi(baseUrl: string, fetchImpl: FetchLike = (...a) => fetch(...a)) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown, ownerToken?: string): Promise<T> {
    if (!base) throw new ApiError(0, "not_configured", "The app is not configured: VITE_API_URL is missing.");
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (ownerToken) headers["x-owner-token"] = ownerToken;

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ApiError(0, "network_error", "Couldn't reach CloudWorm. Check your connection and try again.");
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON (e.g. API Gateway throttling page) */
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 429) throw new ApiError(429, "throttled", "Too many requests. Wait a moment and try again.");
      throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `Request failed (${res.status}).`);
    }
    return data as T;
  }

  const t = (id: string) => `/transfers/${encodeURIComponent(id)}`;

  return {
    getConfig: () => request<PublicConfig>("GET", "/config"),
    createTransfer: (req: CreateTransferRequest) => request<CreateTransferResponse>("POST", "/transfers", req),
    getUploadUrls: (id: string, index: number, partNumbers: number[], ownerToken: string) =>
      request<{ urls: PresignedPart[]; expiresIn: number }>(
        "POST",
        `${t(id)}/files/${index}/upload-urls`,
        { partNumbers },
        ownerToken,
      ),
    completeFile: (id: string, index: number, parts: { partNumber: number; etag: string }[] | null, ownerToken: string) =>
      request<{ index: number; uploaded: boolean }>(
        "POST",
        `${t(id)}/files/${index}/complete`,
        parts ? { parts } : {},
        ownerToken,
      ),
    finalize: (id: string, ownerToken: string) => request<TransferView>("POST", `${t(id)}/finalize`, {}, ownerToken),
    deleteTransfer: (id: string, ownerToken: string) =>
      request<{ status: string }>("DELETE", t(id), undefined, ownerToken),
    getTransfer: (id: string) => request<TransferView>("GET", t(id)),
    getDownloadUrl: (id: string, index: number) =>
      request<{ url: string; expiresIn: number }>("POST", `${t(id)}/files/${index}/download-url`, {}),
  };
}

export type Api = ReturnType<typeof createApi>;

/**
 * VITE_API_URL is either an absolute API base URL, or "same-origin" when the app is
 * served by the API itself (SiteHosting=api), so the browser calls its own origin.
 */
export function resolveApiBase(configured: string | undefined, origin?: string): string {
  if (configured === "same-origin") return origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return configured ?? "";
}

export const api: Api = createApi(resolveApiBase(import.meta.env.VITE_API_URL));

export const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
