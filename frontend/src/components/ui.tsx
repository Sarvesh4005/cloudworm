import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { FriendlyError } from "../lib/errors";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cx(
        "rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8",
        className,
      )}
    >
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-violet-500 to-cyan-500 text-white shadow-lg shadow-violet-900/40 hover:from-violet-400 hover:to-cyan-400 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-400 disabled:shadow-none",
  secondary: "border border-white/15 bg-white/5 text-slate-100 hover:bg-white/10 disabled:opacity-50",
  ghost: "text-slate-300 hover:bg-white/5 hover:text-white disabled:opacity-50",
  danger: "border border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 disabled:opacity-50",
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-400 transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-3 text-slate-300">
      <span className="size-5 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300" />
      {label}
    </span>
  );
}

export function ErrorPanel({ error, children }: { error: FriendlyError; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-rose-100">
      <p className="font-semibold">{error.title}</p>
      <p className="mt-1 text-sm text-rose-200/90">{error.detail}</p>
      {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function LockBadge({ children = "End-to-end encrypted" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
      <svg viewBox="0 0 20 20" fill="currentColor" className="size-3.5" aria-hidden>
        <path
          fillRule="evenodd"
          d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
          clipRule="evenodd"
        />
      </svg>
      {children}
    </span>
  );
}

export function FileGlyph() {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500/30 to-cyan-500/20 text-violet-100">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-5" aria-hidden>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
        <path d="M14 3v5h5" />
      </svg>
    </span>
  );
}
