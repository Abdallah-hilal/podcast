"use client";

import { useEffect, useRef, useState } from "react";
import { uploadPercent } from "@/lib/recording/hostSwitch";
import { timeLeftText, type CallEndedPhase } from "@/lib/recording/callEnded";

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Keeps the screen (and so the laptop) awake while the upload runs. The
 *  browser drops the lock whenever the tab is hidden; take it back when the
 *  tab is visible again. */
function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch (e) {
        console.warn("Screen wake lock unavailable:", e);
      }
    };
    void acquire();
    const onVisible = () => void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

/** Upload speed since this screen opened, in bytes/s; null for the first
 *  30 s (too little to go on). */
function useUploadSpeed(bytesUploaded: number): number | null {
  const start = useRef<{ t: number; bytes: number } | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    if (!start.current) {
      start.current = { t: now, bytes: bytesUploaded };
      return;
    }
    const secs = (now - start.current.t) / 1000;
    if (secs < 30) return;
    setSpeed((bytesUploaded - start.current.bytes) / secs);
  }, [bytesUploaded]);
  return speed;
}

export function CallEnded({
  title,
  phase,
  bytesUploaded,
  bytesRecorded,
  hasTake,
  recovery,
  lastError,
  isHost,
  downloadCard,
  onBack,
  onRejoin,
}: {
  title: string;
  phase: CallEndedPhase;
  bytesUploaded: number;
  bytesRecorded: number;
  /** A take from this call is (or was) uploading; false when only an
   *  earlier recording is being recovered. */
  hasTake: boolean;
  recovery: { active: boolean; percent: number };
  lastError?: string;
  isHost: boolean;
  /** The "Saved to your Downloads folder" card, when there's a local copy. */
  downloadCard?: React.ReactNode;
  onBack: () => void;
  onRejoin: () => void;
}) {
  useScreenWakeLock(phase === "uploading");
  const speed = useUploadSpeed(bytesUploaded);
  const done = phase === "saved";
  const percent = done ? 100 : Math.min(99, uploadPercent(bytesUploaded, bytesRecorded));
  const left = phase === "uploading" ? timeLeftText(bytesRecorded - bytesUploaded, speed) : null;

  return (
    <div className="min-h-screen bg-cream text-ink flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-2 sm:px-6">
        <div
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-[11px] font-extrabold text-white"
        >
          PS
        </div>
        <h1 className="truncate text-base font-bold tracking-tight md:text-lg">{title}</h1>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-4 sm:p-6">
        <section
          className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-surface p-6 sm:p-8"
          style={{ boxShadow: "var(--shadow-photo)" }}
          role="status"
          aria-live="polite"
        >
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-ink-muted">Call ended</p>
            <h2 className="text-2xl font-extrabold tracking-tight">
              {done && !hasTake
                ? "You left the call"
                : done
                  ? "Saved to the studio ✓"
                : phase === "paused"
                  ? "The studio upload paused"
                  : hasTake
                    ? "Uploading your recording"
                    : "Finishing an earlier recording"}
            </h2>
          </div>

          {hasTake && (
            <div className="space-y-2">
              <div
                className="h-3 w-full overflow-hidden rounded-full bg-cream-200"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="Studio upload"
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                    done ? "bg-emerald-600" : phase === "paused" ? "bg-coral-600" : "bg-zinc-900"
                  }`}
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>
              <div className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
                <span className="font-bold">{percent}%</span>
                <span className="text-ink-muted">
                  {fmtBytes(Math.min(bytesUploaded, bytesRecorded))} of {fmtBytes(bytesRecorded)}
                  {left ? ` · ${left}` : ""}
                </span>
              </div>
            </div>
          )}

          {recovery.active && (
            <p className="flex items-center gap-2 text-sm font-semibold tabular-nums">
              <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-900" aria-hidden />
              {hasTake ? "Also finishing an earlier recording" : "Uploading"} · {recovery.percent}%
            </p>
          )}

          {phase === "uploading" && (
            <ul className="space-y-2 text-sm leading-relaxed text-ink-muted">
              <li>
                <strong className="text-ink">Keep this tab open</strong> and the laptop plugged in
                — don&apos;t close the lid until this says Saved.
              </li>
              <li>The call is over, so the upload now has your whole connection.</li>
              <li>If the tab does close, open the link again — it picks up where it stopped.</li>
            </ul>
          )}

          {phase === "paused" && (
            <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
              <p>
                Your recording is safe on this device. Open this link again later (or press Try
                again) and the upload carries on from where it stopped.
              </p>
              {lastError && (
                <p className="break-words rounded-xl bg-cream-sunken px-3 py-2 font-mono text-xs text-coral-700">
                  {lastError}
                </p>
              )}
            </div>
          )}

          {done && (
            <p className="text-sm leading-relaxed text-ink-muted">
              {hasTake ? "Everything is in the studio. " : ""}You can close this tab.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {phase === "paused" && (
              <button
                onClick={() => window.location.reload()}
                className="press rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Try again
              </button>
            )}
            {done && isHost && (
              <button
                onClick={onBack}
                className="press rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-zinc-700"
              >
                Back to sessions
              </button>
            )}
            <button
              onClick={onRejoin}
              className="press rounded-full px-3 py-2.5 text-sm font-semibold text-ink-muted hover:text-ink"
            >
              Rejoin the call
            </button>
          </div>
        </section>

        {downloadCard}
      </main>
    </div>
  );
}
