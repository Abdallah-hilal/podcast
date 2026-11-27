"use client";

import type { PipelineState } from "@/types";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function RecBadge({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="appear absolute top-4 left-4 z-20 flex items-center gap-2 bg-coral-600/95 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs md:text-sm font-bold shadow-xl ring-1 ring-white/10">
      <span className="relative flex w-2.5 h-2.5">
        <span className="absolute inset-0 rounded-full bg-white opacity-75 animate-ping" />
        <span className="relative rounded-full bg-white w-2.5 h-2.5" />
      </span>
      <span className="tabular-nums tracking-wider">REC · {fmt(elapsedMs)}</span>
    </div>
  );
}

interface UploadBadgeProps {
  state: PipelineState;
  batchesUploaded: number;
  batchesTotal: number;
  bytesUploaded: number;
  /** Size of the whole take so far; drives the upload percentage. */
  bytesRecorded?: number;
  batchesFailed?: number;
  lastError?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function UploadBadge({
  state,
  bytesUploaded,
  bytesRecorded = 0,
  batchesFailed = 0,
  lastError,
}: UploadBadgeProps) {
  if (state === "idle") return null;

  const isError = state === "error";

  // Plain words about the studio copy (the server). The user's own copy is
  // the download in their Downloads folder — see DownloadRecordingBadge.
  const msg = isError
    ? batchesFailed > 0
      ? "Studio upload paused — your file is safe on this device; reopen the link later to finish"
      : "Studio upload failed — your file is safe on this device"
    : state === "recording"
      ? "Recording on this device"
      : state === "stopping"
        ? "Finishing your file…"
        : state === "uploading"
          ? `Uploading to the studio · ${bytesRecorded > 0 ? Math.min(99, Math.floor((bytesUploaded / bytesRecorded) * 100)) : 0}% (${fmtBytes(bytesUploaded)} of ${fmtBytes(bytesRecorded)}) — keep this tab open`
          : "Uploaded to the studio ✓ " + fmtBytes(bytesUploaded);

  const color = isError
    ? "bg-coral-700 text-white border-coral-600 shadow-coral-700/30"
    : state === "complete"
      ? "bg-white text-emerald-700 border-black/5"
      : "bg-white text-ink border-black/5";

  return (
    <div
      className={`appear absolute bottom-4 right-4 z-20 flex max-w-[min(26rem,calc(100%-2rem))] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold tracking-tight shadow-[0_6px_18px_rgba(24,24,27,0.10)] ${color}`}
      title={isError && lastError ? lastError : undefined}
      role={isError ? "alert" : "status"}
    >
      {!isError && state !== "complete" && (
        <span className="w-2 h-2 rounded-full bg-coral-500 animate-pulse" />
      )}
      {isError && <span className="text-white font-bold" aria-hidden>⚠</span>}
      <span className="tabular-nums">{msg}</span>
    </div>
  );
}

/** Shown while an earlier take left behind by a refresh/crash is uploading. */
export function RecoveryBadge({ percent }: { percent: number }) {
  return (
    <div
      role="status"
      className="appear absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-full border border-black/5 bg-white px-3 py-1.5 text-xs font-semibold tracking-tight text-ink shadow-[0_6px_18px_rgba(24,24,27,0.10)]"
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-900" aria-hidden />
      <span className="tabular-nums">Recovering an earlier recording · {percent}%</span>
    </div>
  );
}
