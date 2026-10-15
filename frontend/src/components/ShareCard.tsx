import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { api, type TransferView } from "../lib/api";
import { formatDateTime, formatTimeLeft } from "../lib/format";
import { Button, LockBadge } from "./ui";

export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy this link:", text);
        }
      }}
    >
      {copied ? "Copied!" : label}
    </Button>
  );
}

export function ShareCard({
  link,
  transferId,
  expiresAt,
  onDelete,
  onReset,
}: {
  link: string;
  transferId: string;
  expiresAt: number;
  onDelete: () => Promise<void>;
  onReset: () => void;
}) {
  const [status, setStatus] = useState<TransferView | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getTransfer(transferId)
        .then((v) => alive && setStatus(v))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [transferId]);

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
      <div className="min-w-0 space-y-5">
        <div>
          <LockBadge />
          <h2 className="mt-3 text-2xl font-bold text-white">Your files are ready to share</h2>
          <p className="mt-1 text-sm text-slate-400">
            Anyone with this link can download and decrypt the files until it expires{" "}
            <span className="text-slate-200">{formatTimeLeft(expiresAt)}</span> ({formatDateTime(expiresAt)}).
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={link}
            aria-label="Share link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm text-cyan-100"
          />
          <CopyButton text={link} />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Downloads</dt>
            <dd className="mt-0.5 text-xl font-semibold text-white" data-testid="download-count">
              {status ? status.totalDownloads : "—"}
            </dd>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <dt className="text-slate-400">Status</dt>
            <dd className="mt-0.5 text-xl font-semibold capitalize text-white">{status?.status ?? "—"}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onReset}>
            Send more files
          </Button>
          <Button
            variant="danger"
            disabled={deleting}
            onClick={async () => {
              if (!window.confirm("Delete this transfer now? The link will stop working immediately.")) return;
              setDeleting(true);
              try {
                await onDelete();
              } finally {
                setDeleting(false);
              }
            }}
          >
            {deleting ? "Deleting…" : "Delete now"}
          </Button>
        </div>
      </div>

      <figure className="mx-auto w-fit rounded-2xl bg-white p-3 shadow-xl">
        <QRCodeSVG value={link} size={176} level="M" marginSize={0} title="QR code for the share link" />
        <figcaption className="mt-2 text-center text-xs font-medium text-slate-600">Scan to download</figcaption>
      </figure>
    </div>
  );
}
