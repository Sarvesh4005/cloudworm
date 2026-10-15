import { ApiError } from "./api";
import { DecryptionError, InvalidKeyError } from "./crypto";
import { UploadHttpError } from "./upload";

export interface FriendlyError {
  title: string;
  detail: string;
}

const BY_CODE: Record<string, FriendlyError> = {
  transfer_expired: { title: "This transfer has expired", detail: "Ask the sender to share the files again." },
  transfer_deleted: { title: "This transfer was deleted", detail: "The sender removed these files." },
  transfer_failed: { title: "This transfer failed", detail: "The upload didn't complete. Ask the sender to try again." },
  transfer_not_found: { title: "Transfer not found", detail: "Check that you copied the whole link." },
  invalid_transfer_id: { title: "Invalid link", detail: "This doesn't look like a CloudWorm link. Check that you copied all of it." },
  transfer_not_ready: { title: "Still uploading", detail: "The sender hasn't finished uploading yet. Try again in a moment." },
  invalid_access_code: { title: "Wrong access code", detail: "Check the upload access code and try again." },
  uploads_disabled: { title: "Uploads are disabled", detail: "The server has no upload access code configured." },
  throttled: { title: "Slow down", detail: "Too many requests. Wait a few seconds and try again." },
  network_error: { title: "Connection problem", detail: "Couldn't reach CloudWorm. Check your connection." },
  size_mismatch: { title: "Upload verification failed", detail: "A file didn't arrive intact. Please try again." },
};

export function describeError(err: unknown): FriendlyError {
  if (err instanceof InvalidKeyError) {
    return { title: "Missing decryption key", detail: "The part of the link after # is missing or damaged. Ask the sender for the full link." };
  }
  if (err instanceof DecryptionError) {
    return { title: "Couldn't decrypt", detail: err.message };
  }
  if (err instanceof ApiError) {
    return BY_CODE[err.code] ?? { title: "Something went wrong", detail: err.message };
  }
  if (err instanceof UploadHttpError) {
    return { title: "Upload failed", detail: `${err.message} Check your connection and try again.` };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { title: "Cancelled", detail: "The operation was cancelled." };
  }
  return { title: "Something went wrong", detail: err instanceof Error ? err.message : String(err) };
}
