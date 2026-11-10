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
  batchesUploaded,
  batchesTotal,
  bytesUploaded,
  batchesFailed = 0,
  lastError,
}: UploadBadgeProps) {
  if (state === "idle") return null;

  const isError = state === "error";

  const msg = isError
    ? batchesFailed > 0
      ? `Upload failed · ${batchesFailed} batch${batchesFailed > 1 ? "es" : ""}`
      : "Upload failed"
    : state === "recording"
      ? batchesTotal > 0
        ? `Uploading · ${batchesUploaded}/${batchesTotal}`
        : "Recording locally"
      : state === "stopping"
        ? "Finalizing…"
        : state === "uploading"
          ? `Uploading · ${batchesUploaded}/${batchesTotal}`
          : "Saved · " + fmtBytes(bytesUploaded);

  const color = isError
    ? "bg-coral-700 text-white border-coral-600 shadow-coral-700/30"
    : state === "complete"
      ? "bg-teal-900/85 text-teal-100 border-teal-700"
      : "bg-black/70 text-white border-white/10";

  return (
    <div
      className={`appear absolute bottom-4 right-4 z-20 flex items-center gap-2 backdrop-blur-md border px-3 py-1.5 rounded-full text-xs font-medium shadow-lg tracking-tight ${color}`}
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
