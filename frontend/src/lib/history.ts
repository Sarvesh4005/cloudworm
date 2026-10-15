/**
 * Transfers this browser has sent. Stored only in this device's localStorage so
 * the sender can re-copy links, see download counts and delete early.
 * Note: entries include the decryption key and owner token — anyone with access
 * to this browser profile can use them. Users can clear the list at any time.
 */
export interface SentTransfer {
  transferId: string;
  key: string;
  ownerToken: string;
  expiresAt: number;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  label: string;
}

const STORAGE_KEY = "cloudworm.sent.v1";
const MAX_ENTRIES = 30;

export function loadHistory(now = Date.now()): SentTransfer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as SentTransfer[]) : [];
    return Array.isArray(list) ? list.filter((t) => t.expiresAt * 1000 > now) : [];
  } catch {
    return [];
  }
}

function save(list: SentTransfer[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable (private mode) — history is a convenience only */
  }
}

export function addToHistory(entry: SentTransfer) {
  save([entry, ...loadHistory().filter((t) => t.transferId !== entry.transferId)]);
}

export function removeFromHistory(transferId: string) {
  save(loadHistory().filter((t) => t.transferId !== transferId));
}

export function clearHistory() {
  save([]);
}

export function shareLink(transferId: string, key: string, origin = window.location.origin): string {
  return `${origin}/t/${transferId}#${key}`;
}
