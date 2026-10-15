import { useEffect, useMemo, useRef, useState } from "react";
import { Dropzone } from "../components/Dropzone";
import { RecentTransfers } from "../components/RecentTransfers";
import { ShareCard } from "../components/ShareCard";
import { Button, Card, ErrorPanel, FileGlyph, LockBadge, ProgressBar, Spinner, cx } from "../components/ui";
import { api, type PublicConfig } from "../lib/api";
import { isCryptoAvailable } from "../lib/crypto";
import { describeError, type FriendlyError } from "../lib/errors";
import { formatBytes, formatHoursOption } from "../lib/format";
import { addToHistory, removeFromHistory, shareLink, type SentTransfer } from "../lib/history";
import { sendFiles, validateSelection } from "../lib/upload";

type Phase = { kind: "select" } | { kind: "uploading" } | { kind: "done"; sent: SentTransfer };

const CODE_KEY = "cloudworm.accessCode";

function readSessionCode(): string {
  try {
    return sessionStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function SendPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<FriendlyError | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [expiry, setExpiry] = useState<number>(24);
  const [accessCode, setAccessCode] = useState(readSessionCode);
  const [phase, setPhase] = useState<Phase>({ kind: "select" });
  const [error, setError] = useState<FriendlyError | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number }[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadConfig = () => {
    setConfigError(null);
    api
      .getConfig()
      .then((c) => {
        setConfig(c);
        setExpiry(c.defaultExpiryHours);
      })
      .catch((e) => setConfigError(describeError(e)));
  };
  useEffect(loadConfig, []);

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    if (phase.kind !== "uploading") return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase.kind]);

  const totalBytes = useMemo(() => files.reduce((a, f) => a + f.size, 0), [files]);
  const selectionError = config && files.length ? validateSelection(files, config) : null;
  const overall = useMemo(() => {
    const t = progress.reduce((a, p) => a + p.total, 0);
    return t ? progress.reduce((a, p) => a + p.loaded, 0) / t : 0;
  }, [progress]);

  const addFiles = (incoming: File[]) => {
    setError(null);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}:${f.lastModified}`))];
    });
  };

  async function start() {
    if (!config) return;
    const problem = validateSelection(files, config);
    if (problem) return setError({ title: "Can't send these files", detail: problem });
    if (!accessCode.trim()) return setError({ title: "Access code required", detail: "Enter the upload access code." });

    try {
      sessionStorage.setItem(CODE_KEY, accessCode.trim());
    } catch {
      /* ignore */
    }
    setError(null);
    setProgress(files.map((f) => ({ loaded: 0, total: f.size + 16 })));
    setPhase({ kind: "uploading" });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await sendFiles({
        api,
        config,
        files,
        accessCode: accessCode.trim(),
        expiresInHours: expiry,
        signal: controller.signal,
        onProgress: (i, loaded, total) =>
          setProgress((prev) => prev.map((p, j) => (j === i ? { loaded, total } : p))),
      });
      const sent: SentTransfer = {
        ...result,
        createdAt: Math.floor(Date.now() / 1000),
        fileCount: files.length,
        totalBytes,
        label: files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} more`,
      };
      addToHistory(sent);
      setHistoryVersion((v) => v + 1);
      setPhase({ kind: "done", sent });
      setFiles([]);
    } catch (e) {
      const friendly = describeError(e);
      if (friendly.title === "Wrong access code") {
        try {
          sessionStorage.removeItem(CODE_KEY);
        } catch {
          /* ignore */
        }
      }
      setError(friendly);
      setPhase({ kind: "select" });
    } finally {
      abortRef.current = null;
    }
  }

  if (!isCryptoAvailable()) {
    return (
      <Card>
        <ErrorPanel
          error={{
            title: "Encryption unavailable",
            detail: "This browser can't encrypt files here. Open CloudWorm over HTTPS in an up-to-date browser.",
          }}
        />
      </Card>
    );
  }

  if (phase.kind === "done") {
    const { sent } = phase;
    return (
      <div className="space-y-6">
        <Card>
          <ShareCard
            link={shareLink(sent.transferId, sent.key)}
            transferId={sent.transferId}
            expiresAt={sent.expiresAt}
            onReset={() => setPhase({ kind: "select" })}
            onDelete={async () => {
              try {
                await api.deleteTransfer(sent.transferId, sent.ownerToken);
                removeFromHistory(sent.transferId);
                setHistoryVersion((v) => v + 1);
                setPhase({ kind: "select" });
              } catch (e) {
                setError(describeError(e));
              }
            }}
          />
          {error && (
            <div className="mt-4">
              <ErrorPanel error={error} />
            </div>
          )}
        </Card>
        <RecentTransfers version={historyVersion} onChange={() => setHistoryVersion((v) => v + 1)} />
      </div>
    );
  }

  const uploading = phase.kind === "uploading";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <LockBadge>Encrypted in your browser before upload</LockBadge>
        <h1 className="mt-4 bg-gradient-to-r from-white via-violet-100 to-cyan-200 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
          Send files through the wormhole
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">
          Files are encrypted on this device, and the key never leaves your share link. Links expire on schedule.
        </p>
      </div>

      <Card>
        {configError ? (
          <ErrorPanel error={configError}>
            <Button onClick={loadConfig}>Retry</Button>
          </ErrorPanel>
        ) : !config ? (
          <div className="py-10 text-center">
            <Spinner label="Connecting…" />
          </div>
        ) : (
          <div className="space-y-6">
            <Dropzone onFiles={addFiles} disabled={uploading} />

            {files.length > 0 && (
              <div>
                <div className="mb-2 flex items-baseline justify-between text-sm">
                  <span className="font-medium text-slate-200">
                    {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
                  </span>
                  {!uploading && (
                    <button className="text-slate-400 hover:text-white" onClick={() => setFiles([])}>
                      Clear all
                    </button>
                  )}
                </div>
                <ul className="max-h-80 space-y-2 overflow-y-auto pr-1" aria-label="Selected files">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
                      <FileGlyph />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white" title={f.name}>
                          {f.name}
                        </p>
                        {uploading && progress[i] ? (
                          <div className="mt-1.5 flex items-center gap-2">
                            <ProgressBar value={progress[i].loaded / progress[i].total} label={`Uploading ${f.name}`} />
                            <span className="w-10 text-right text-xs tabular-nums text-slate-400">
                              {Math.round((progress[i].loaded / progress[i].total) * 100)}%
                            </span>
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400">{formatBytes(f.size)}</p>
                        )}
                      </div>
                      {!uploading && (
                        <button
                          aria-label={`Remove ${f.name}`}
                          className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
                          onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {selectionError && <p className="mt-2 text-sm text-amber-300">{selectionError}</p>}
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <fieldset disabled={uploading}>
                <legend className="mb-2 text-sm font-medium text-slate-200">Link expires after</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {config.expiryHoursOptions.map((h) => (
                    <label
                      key={h}
                      className={cx(
                        "cursor-pointer rounded-xl border px-2 py-2.5 text-center text-sm font-medium transition",
                        expiry === h
                          ? "border-cyan-300/60 bg-cyan-400/15 text-white"
                          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10",
                      )}
                    >
                      <input
                        type="radio"
                        name="expiry"
                        className="sr-only"
                        checked={expiry === h}
                        onChange={() => setExpiry(h)}
                      />
                      {formatHoursOption(h)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label htmlFor="access-code" className="mb-2 block text-sm font-medium text-slate-200">
                  Upload access code
                </label>
                <input
                  id="access-code"
                  type="password"
                  autoComplete="off"
                  value={accessCode}
                  disabled={uploading}
                  onChange={(e) => setAccessCode(e.target.value)}
                  placeholder="Required to upload"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 disabled:opacity-50"
                />
              </div>
            </div>

            {error && <ErrorPanel error={error} />}

            {uploading ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-slate-300">
                  <span>Encrypting &amp; uploading…</span>
                  <span className="tabular-nums">{Math.round(overall * 100)}%</span>
                </div>
                <ProgressBar value={overall} label="Overall upload progress" />
                <Button variant="ghost" className="w-full" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                className="w-full py-3.5 text-base"
                disabled={!files.length || Boolean(selectionError) || !config.uploadsEnabled}
                onClick={start}
              >
                {config.uploadsEnabled ? "Encrypt & get link" : "Uploads are disabled on this server"}
              </Button>
            )}

            <p className="text-center text-xs text-slate-500">
              Up to {config.maxFiles} files · {formatBytes(config.maxFileBytes)} per file ·{" "}
              {formatBytes(config.maxTransferBytes)} per transfer
              {config.allowedExtensions.length > 0 && <> · Allowed: {config.allowedExtensions.join(", ")}</>}
            </p>
          </div>
        )}
      </Card>

      <RecentTransfers version={historyVersion} onChange={() => setHistoryVersion((v) => v + 1)} />
    </div>
  );
}
