import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatBytes, formatTimeLeft } from "../lib/format";
import { clearHistory, loadHistory, removeFromHistory, shareLink } from "../lib/history";
import { CopyButton } from "./ShareCard";
import { Button, Card } from "./ui";

/** Transfers sent from this browser (stored locally only). */
export function RecentTransfers({ version, onChange }: { version: number; onChange: () => void }) {
  const items = useMemo(() => loadHistory(), [version]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!items.length) return null;

  return (
    <Card className="!p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Sent from this device</h2>
        <button
          className="text-xs text-slate-500 hover:text-slate-200"
          onClick={() => {
            if (window.confirm("Forget these links on this device? (The transfers themselves are not deleted.)")) {
              clearHistory();
              onChange();
            }
          }}
        >
          Forget all
        </button>
      </div>
      {message && <p className="mb-2 text-sm text-rose-300">{message}</p>}
      <ul className="divide-y divide-white/5">
        {items.map((t) => (
          <li key={t.transferId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white" title={t.label}>
                {t.label}
              </p>
              <p className="text-xs text-slate-400">
                {formatBytes(t.totalBytes)} · expires {formatTimeLeft(t.expiresAt)}
              </p>
            </div>
            <div className="flex gap-2">
              <CopyButton text={shareLink(t.transferId, t.key)} label="Copy" />
              <Button
                variant="danger"
                disabled={busy === t.transferId}
                onClick={async () => {
                  if (!window.confirm("Delete this transfer now? The link stops working immediately.")) return;
                  setBusy(t.transferId);
                  setMessage(null);
                  try {
                    await api.deleteTransfer(t.transferId, t.ownerToken);
                    removeFromHistory(t.transferId);
                    onChange();
                  } catch (e) {
                    const err = describeError(e);
                    // Already gone server-side: just forget it locally.
                    if (/expired|deleted|not found/i.test(err.title)) {
                      removeFromHistory(t.transferId);
                      onChange();
                    } else setMessage(`${err.title}: ${err.detail}`);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
