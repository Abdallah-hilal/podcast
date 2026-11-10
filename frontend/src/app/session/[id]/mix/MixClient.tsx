"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import { Logo } from "@/components/common/Logo";
import type { CompositeStatusResponse } from "@/types";

const POLL_MS = 3000;

function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  ready: { cls: "bg-teal-100 text-brand ring-1 ring-teal-900/10", label: "Ready" },
  error: { cls: "bg-coral-600/15 text-coral-700 ring-1 ring-coral-600/30", label: "Error" },
  processing: { cls: "bg-orange-400/20 text-coral-700 ring-1 ring-coral-600/20", label: "Rendering" },
  pending: { cls: "bg-coral-600/10 text-coral-700 ring-1 ring-coral-600/20", label: "Queued" },
  none: { cls: "bg-cream-200 text-ink-muted", label: "Not rendered" },
};

export default function MixClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const supabase = createClient();

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<CompositeStatusResponse | null>(null);
  const [err, setErr] = useState("");
  const [rendering, setRendering] = useState(false);

  const fetchStatus = useCallback(
    async (token: string) => {
      try {
        const s = await api.getComposite(token, sessionId);
        setStatus(s);
        return s;
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load composite");
        return null;
      }
    },
    [sessionId]
  );

  useEffect(() => {
    let mounted = true;
    let token: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push(loginUrlWithNext());
        return;
      }
      token = session.access_token;

      const { data } = await supabase
        .from("podcast_sessions")
        .select("title")
        .eq("id", sessionId)
        .single();
      if (mounted && data?.title) setTitle(data.title);

      const first = await fetchStatus(token);
      if (
        mounted &&
        first &&
        (first.status === "pending" || first.status === "processing")
      ) {
        timer = setInterval(async () => {
          if (!token) return;
          const s = await fetchStatus(token);
          if (s && s.status !== "pending" && s.status !== "processing" && timer) {
            clearInterval(timer);
            timer = null;
          }
        }, POLL_MS);
      }
    }

    load();
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, router, supabase, fetchStatus]);

  async function handleRender() {
    if (rendering) return;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      router.push(loginUrlWithNext());
      return;
    }
    setRendering(true);
    setErr("");
    try {
      await api.renderComposite(session.access_token, sessionId);
      await fetchStatus(session.access_token);
      const token = session.access_token;
      const timer = setInterval(async () => {
        const s = await fetchStatus(token);
        if (s && s.status !== "pending" && s.status !== "processing") {
          clearInterval(timer);
        }
      }, POLL_MS);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start render");
    } finally {
      setRendering(false);
    }
  }

  const s = status;
  const canRender =
    s &&
    s.ready_recordings >= 1 &&
    s.status !== "pending" &&
    s.status !== "processing";

  const pill = s ? STATUS_PILL[s.status] ?? STATUS_PILL.none : STATUS_PILL.none;

  return (
    <div className="min-h-screen bg-cream text-ink p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between gap-3">
          <Logo size="md" />
          <Link
            href="/"
            className="press text-sm font-medium text-ink-muted hover:text-brand"
          >
            ← Sessions
          </Link>
        </header>

        <div className="appear">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-ink-muted">
            Mix
          </p>
          <h1 className="text-[clamp(1.5rem,4.5vw,2.25rem)] font-black truncate">
            {title || "Session"}
          </h1>
        </div>

        {err && (
          <p className="text-coral-700 bg-coral-600/10 border border-coral-600/20 rounded-lg px-3 py-2 text-sm">
            {err}
          </p>
        )}

        {!s && !err && (
          <p className="text-ink-muted animate-pulse">Loading…</p>
        )}

        {s && (
          <>
            <div
              className="bg-surface border border-border rounded-2xl p-5 space-y-3"
              style={{ boxShadow: "var(--shadow-sm)" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-ink-muted">
                  Composite status
                </span>
                <span
                  className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full ${pill.cls}`}
                >
                  {pill.label}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
                <span>
                  <span className="font-bold text-ink tabular-nums">
                    {s.ready_recordings}
                  </span>
                  {" / "}
                  <span className="tabular-nums">{s.total_recordings}</span>
                  {" recording(s) ready"}
                </span>
                {s.total_bytes != null && (
                  <span className="tabular-nums">{fmtBytes(s.total_bytes)}</span>
                )}
              </div>

              {s.error && (
                <p className="text-sm text-coral-700 bg-coral-600/5 border border-coral-600/20 rounded-lg px-3 py-2 whitespace-pre-wrap">
                  {s.error}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleRender}
                disabled={!canRender || rendering}
                className="press px-5 py-2.5 bg-coral-600 hover:bg-coral-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-coral-600 rounded-xl font-bold text-white shadow-md hover:shadow-lg"
              >
                {rendering
                  ? "Queuing…"
                  : s.status === "ready"
                    ? "Re-render composite"
                    : s.status === "processing" || s.status === "pending"
                      ? "Rendering…"
                      : s.ready_recordings === 0
                        ? "No ready recordings yet"
                        : "Render composite"}
              </button>
              {s.status === "ready" && s.download_url && (
                <a
                  href={s.download_url}
                  download={`session-${sessionId}-composite.webm`}
                  className="press px-5 py-2.5 bg-surface border border-border hover:border-brand text-brand rounded-xl font-bold text-sm"
                >
                  Download .webm
                </a>
              )}
            </div>

            {s.status === "ready" && s.download_url && (
              <div
                className="bg-canvas rounded-2xl overflow-hidden"
                style={{ boxShadow: "var(--shadow-photo)" }}
              >
                <video
                  src={s.download_url}
                  controls
                  className="w-full aspect-video"
                />
              </div>
            )}

            {(s.status === "pending" || s.status === "processing") && (
              <div className="rounded-2xl border border-dashed border-border-strong/40 bg-cream-sunken/60 p-4 text-sm text-ink-muted">
                ffmpeg is rendering the side-by-side mix. This can take a while
                for longer recordings.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
