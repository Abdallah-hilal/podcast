"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import type { CompositeStatusResponse } from "@/types";

const POLL_MS = 3000;

function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
        router.push("/login");
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
      router.push("/login");
      return;
    }
    setRendering(true);
    setErr("");
    try {
      await api.renderComposite(session.access_token, sessionId);
      await fetchStatus(session.access_token);
      // Begin polling
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

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold truncate">
            {title || "Session"} · Mix
          </h1>
          <Link href="/" className="text-gray-400 hover:text-white text-sm">
            ← Sessions
          </Link>
        </div>

        {err && <p className="text-red-400 text-sm">{err}</p>}

        {!s && !err && <p className="text-gray-500">Loading…</p>}

        {s && (
          <>
            <div className="bg-gray-900 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Composite status</span>
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    s.status === "ready"
                      ? "bg-green-900 text-green-300"
                      : s.status === "error"
                        ? "bg-red-900 text-red-300"
                        : s.status === "processing"
                          ? "bg-yellow-900 text-yellow-300"
                          : s.status === "pending"
                            ? "bg-blue-900 text-blue-300"
                            : "bg-gray-700 text-gray-400"
                  }`}
                >
                  {s.status}
                </span>
              </div>
              <div className="text-sm text-gray-400">
                {s.ready_recordings} / {s.total_recordings} recording(s) ready
              </div>
              {s.total_bytes != null && (
                <div className="text-sm text-gray-400">
                  Size: {fmtBytes(s.total_bytes)}
                </div>
              )}
              {s.error && (
                <p className="text-sm text-red-400 whitespace-pre-wrap">{s.error}</p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleRender}
                disabled={!canRender || rendering}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium"
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
                <>
                  <a
                    href={s.download_url}
                    download={`session-${sessionId}-composite.webm`}
                    className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm"
                  >
                    Download
                  </a>
                </>
              )}
            </div>

            {s.status === "ready" && s.download_url && (
              <div className="bg-black rounded-lg overflow-hidden">
                <video
                  src={s.download_url}
                  controls
                  className="w-full aspect-video"
                />
              </div>
            )}

            {(s.status === "pending" || s.status === "processing") && (
              <p className="text-sm text-gray-500">
                ffmpeg is rendering the side-by-side mix. This can take a while
                for longer recordings.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
