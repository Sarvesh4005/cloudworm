import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { cx } from "./ui";

export function Dropzone({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const open = () => !disabled && input.current?.click();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    // Dropped folders show up as zero-byte, type-less entries; skip them (folders aren't supported).
    const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== "");
    if (files.length) onFiles(files);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Add files: drop them here or press Enter to browse"
      aria-disabled={disabled}
      onClick={open}
      onKeyDown={onKey}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        "group relative flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed px-6 py-10 text-center transition sm:py-14",
        over ? "border-cyan-300 bg-cyan-400/10" : "border-white/15 bg-white/[0.02] hover:border-violet-300/60 hover:bg-white/[0.04]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <div className="relative mb-4 grid size-20 place-items-center" aria-hidden>
        <div className="animate-spin-slow absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,#a78bfa,#22d3ee,#6366f1,#a78bfa)] opacity-70 blur-[2px]" />
        <div className="absolute inset-[5px] rounded-full bg-void" />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="relative size-8 text-cyan-200">
          <path d="M12 16V4m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-lg font-semibold text-white">Drop files here</p>
      <p className="mt-1 text-sm text-slate-400">
        or <span className="font-medium text-cyan-300 underline-offset-4 group-hover:underline">browse your device</span>
      </p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
