import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Button, Card, ErrorPanel, FileGlyph, LockBadge, ProgressBar, Spinner } from "../components/ui";
import { api, ApiError, TRANSFER_ID_RE, type TransferView } from "../lib/api";
import { decryptMetadata, deriveMetaKey, importTransferKey, InvalidKeyError, type FileMeta } from "../lib/crypto";
import { canStreamToDisk, downloadFile, openSink } from "../lib/download";
import { describeError, type FriendlyError } from "../lib/errors";
import { formatBytes, formatDateTime, formatTimeLeft } from "../lib/format";

type FileState = { progress: number; status: "idle" | "downloading" | "done" | "error"; error?: string };

type Loaded = { view: TransferView; names: FileMeta[]; master: CryptoKey };

export function ReceivePage() {
  const { transferId = "" } = useParams();
  const { hash } = useLocation();
  const key = hash.replace(/^#/, "");

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [files, setFiles] = useState<Record<number, FileState>>({});
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    setRetryable(false);
    try {
      if (!TRANSFER_ID_RE.test(transferId)) throw new ApiError(400, "invalid_transfer_id", "Invalid link.");
      if (!key) throw new InvalidKeyError();
      const master = await importTransferKey(key);
      const view = await api.getTransfer(transferId);
      if (view.status === "uploading") throw new ApiError(409, "transfer_not_ready", "Still uploading.");
      const metaKey = await deriveMetaKey(master);
      const names = await Promise.all(view.files.map((f) => decryptMetadata(metaKey, f.encName)));
      setData({ view, names, master });
    } catch (e) {
      setData(null);
      setError(describeError(e));
      setRetryable(e instanceof ApiError && (e.status === 0 || e.status === 409 || e.status === 429 || e.status >= 500));
    }
  }, [transferId, key]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the countdown fresh, and flip to the expired state on time.
  useEffect(() => {
    if (!data) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= data.view.expiresAt * 1000) {
        setData(null);
        setError(describeError(new ApiError(410, "transfer_expired", "")));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [data]);

  const update = (index: number, patch: Partial<FileState>) =>
    setFiles((prev) => {
      const base: FileState = prev[index] ?? { progress: 0, status: "idle" };
      return { ...prev, [index]: { ...base, ...patch } };
    });

  async function download(index: number, preferDisk: boolean) {
    if (!data) return;
    const f = data.view.files[index];
    const meta = data.names[index];
    let sink;
    try {
      // Open the save dialog first, while we still have the click's user activation.
      sink = await openSink(meta.name, meta.type, preferDisk);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return; // user closed the picker
      throw e;
    }
    update(index, { status: "downloading", progress: 0, error: undefined });
    try {
      await downloadFile({
        api,
        transferId,
        master: data.master,
        index,
        size: f.size,
        ciphertextSize: f.ciphertextSize,
        sink,
        onProgress: (p) => update(index, { progress: p }),
      });
      update(index, { status: "done", progress: 1 });
    } catch (e) {
      const err = describeError(e);
      update(index, { status: "error", error: `${err.title}. ${err.detail}` });
      if (e instanceof ApiError && e.status === 410) {
        setData(null);
        setError(err);
      }
    }
  }

  async function downloadAll() {
    if (!data) return;
    for (const f of data.view.files) await download(f.index, false);
  }

  if (error) {
    return (
      <Card className="mx-auto max-w-xl text-center">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-full bg-rose-500/10 text-3xl" aria-hidden>
          🕳️
        </div>
        <ErrorPanel error={error}>
          {retryable && <Button onClick={load}>Try again</Button>}
          <Link
            to="/"
            className="inline-flex min-h-11 items-center rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-semibold text-slate-100 hover:bg-white/10"
          >
            Send your own files
          </Link>
        </ErrorPanel>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="mx-auto max-w-xl py-16 text-center">
        <Spinner label="Opening the wormhole…" />
      </Card>
    );
  }

  const { view, names } = data;
  const totalSize = view.files.reduce((a, f) => a + f.size, 0);
  const busy = Object.values(files).some((s) => s.status === "downloading");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <LockBadge>Decrypted in your browser</LockBadge>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          {view.files.length === 1 ? "Someone sent you a file" : `Someone sent you ${view.files.length} files`}
        </h1>
        <p className="mt-2 text-slate-400">
          {formatBytes(totalSize)} · expires <span className="text-slate-200">{formatTimeLeft(view.expiresAt)}</span>{" "}
          <span className="hidden sm:inline">({formatDateTime(view.expiresAt)})</span>
        </p>
      </div>

      <Card>
        <ul className="space-y-2" aria-label="Files in this transfer">
          {view.files.map((f) => {
            const st = files[f.index];
            return (
              <li key={f.index} className="rounded-xl bg-white/5 p-3">
                <div className="flex items-center gap-3">
                  <FileGlyph />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white" title={names[f.index].name}>
                      {names[f.index].name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatBytes(f.size)} · {f.downloadCount} download{f.downloadCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button
                    variant={st?.status === "done" ? "secondary" : "primary"}
                    disabled={st?.status === "downloading"}
                    onClick={() => download(f.index, true)}
                    aria-label={`Download ${names[f.index].name}`}
                  >
                    {st?.status === "downloading"
                      ? `${Math.round(st.progress * 100)}%`
                      : st?.status === "done"
                        ? "Again"
                        : "Download"}
                  </Button>
                </div>
                {st?.status === "downloading" && (
                  <div className="mt-3">
                    <ProgressBar value={st.progress} label={`Downloading ${names[f.index].name}`} />
                  </div>
                )}
                {st?.status === "error" && <p className="mt-2 text-sm text-rose-300">{st.error}</p>}
              </li>
            );
          })}
        </ul>

        {view.files.length > 1 && (
          <Button variant="primary" className="mt-5 w-full py-3.5 text-base" disabled={busy} onClick={downloadAll}>
            Download all ({formatBytes(totalSize)})
          </Button>
        )}

        <p className="mt-5 text-xs leading-relaxed text-slate-500">
          Files are decrypted on this device with the key in your link; CloudWorm's servers only store encrypted data.{" "}
          {canStreamToDisk()
            ? "Large files are streamed straight to disk."
            : "This browser assembles files in memory, so very large files may need a desktop browser such as Chrome or Edge."}
        </p>
      </Card>
    </div>
  );
}
