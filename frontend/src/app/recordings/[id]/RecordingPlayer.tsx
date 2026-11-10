"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import { Logo } from "@/components/common/Logo";
import type { TranscriptResponse, TranscriptSegment } from "@/types";

const TRANSCRIPT_POLL_MS = 3000;

function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function isArabic(text: string | null): boolean {
  if (!text) return false;
  return /[؀-ۿ]/.test(text);
}

export default function RecordingPlayer({ recordingId }: { recordingId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("");
  const [err, setErr] = useState("");
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [retrying, setRetrying] = useState(false);

  const fetchTranscript = useCallback(async (token: string) => {
    try {
      const t = await api.getTranscript(token, recordingId);
      setTranscript(t);
      return t;
    } catch {
      return null;
    }
  }, [recordingId]);

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

      try {
        const { data } = await supabase
          .from("podcast_recordings")
          .select(
            "podcast_participants!inner(podcast_sessions!inner(title))"
          )
          .eq("id", recordingId)
          .single();
        if (mounted && data) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (data as any)?.podcast_participants?.podcast_sessions?.title;
          if (t) setTitle(t);
        }

        const dl = await api.getDownloadUrl(token, recordingId);
        if (mounted) setUrl(dl.download_url);
      } catch (e) {
        if (mounted) setErr(e instanceof Error ? e.message : "Failed to load recording");
        return;
      }

      const first = await fetchTranscript(token);
      if (
        mounted &&
        first &&
        (first.status === "pending" || first.status === "processing")
      ) {
        timer = setInterval(async () => {
          if (!token) return;
          const t = await fetchTranscript(token);
          if (t && t.status !== "pending" && t.status !== "processing" && timer) {
            clearInterval(timer);
            timer = null;
          }
        }, TRANSCRIPT_POLL_MS);
      }
    }

    load();
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [recordingId, router, supabase, fetchTranscript]);

  async function handleRetry() {
    if (retrying) return;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      router.push(loginUrlWithNext());
      return;
    }
    setRetrying(true);
    try {
      await api.retryTranscribe(session.access_token, recordingId);
      setTranscript((t) => (t ? { ...t, status: "pending", error: null } : t));
      // Resume polling
      const token = session.access_token;
      const timer = setInterval(async () => {
        const t = await fetchTranscript(token);
        if (t && t.status !== "pending" && t.status !== "processing") {
          clearInterval(timer);
        }
      }, TRANSCRIPT_POLL_MS);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to retry transcription");
    } finally {
      setRetrying(false);
    }
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    void v.play();
  }

  const rtl = isArabic(transcript?.text ?? null);

  return (
    <div className="min-h-screen bg-cream text-ink p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center justify-between gap-3">
          <Logo size="md" />
          <Link
            href="/recordings"
            className="press text-sm font-medium text-ink-muted hover:text-brand"
          >
            ← Recordings
          </Link>
        </header>

        <div className="appear">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-ink-muted">
            Recording
          </p>
          <h1 className="text-[clamp(1.5rem,4.5vw,2.25rem)] font-black truncate">
            {title || "Untitled"}
          </h1>
        </div>

        {err && (
          <p className="text-coral-700 bg-coral-600/10 border border-coral-600/20 rounded-lg px-3 py-2 text-sm">
            {err}
          </p>
        )}

        {!url && !err && (
          <p className="text-ink-muted animate-pulse">Loading…</p>
        )}

        {url && (
          <>
            <div
              className="bg-canvas rounded-2xl overflow-hidden"
              style={{ boxShadow: "var(--shadow-photo)" }}
            >
              <video
                ref={videoRef}
                src={url}
                controls
                className="w-full aspect-video"
              />
            </div>
            <div className="flex items-center gap-3">
              <a
                href={url}
                download={`recording-${recordingId}.webm`}
                className="press inline-block px-5 py-2.5 bg-coral-600 hover:bg-coral-700 text-white rounded-xl font-bold shadow-md hover:shadow-lg"
              >
                Download .webm
              </a>
            </div>
          </>
        )}

        {transcript && (
          <TranscriptSection
            transcript={transcript}
            rtl={rtl}
            onRetry={handleRetry}
            retrying={retrying}
            onSeek={seekTo}
          />
        )}
      </div>
    </div>
  );
}

const TS_PILL: Record<string, { cls: string; label: string }> = {
  ready: { cls: "bg-teal-100 text-brand ring-1 ring-teal-900/10", label: "Ready" },
  error: { cls: "bg-coral-600/15 text-coral-700 ring-1 ring-coral-600/30", label: "Error" },
  processing: { cls: "bg-orange-400/20 text-coral-700 ring-1 ring-coral-600/20", label: "Processing" },
  pending: { cls: "bg-coral-600/10 text-coral-700 ring-1 ring-coral-600/20", label: "Queued" },
  none: { cls: "bg-cream-200 text-ink-muted", label: "Not yet" },
};

function TranscriptSection({
  transcript,
  rtl,
  onRetry,
  retrying,
  onSeek,
}: {
  transcript: TranscriptResponse;
  rtl: boolean;
  onRetry: () => void;
  retrying: boolean;
  onSeek: (s: number) => void;
}) {
  const { status, text, segments, language, error } = transcript;
  const pill = TS_PILL[status] ?? TS_PILL.none;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-muted">
          Transcript
        </h2>
        <span
          className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full ${pill.cls}`}
        >
          {pill.label}
          {language ? ` · ${language}` : ""}
        </span>
      </div>

      {(status === "pending" || status === "processing") && (
        <p className="text-ink-muted text-sm bg-cream-sunken/60 border border-dashed border-border-strong/40 rounded-xl px-4 py-3">
          Transcribing with Whisper… (first run downloads the model, so this
          can take a minute)
        </p>
      )}

      {status === "error" && (
        <div className="space-y-2 bg-coral-600/5 border border-coral-600/20 rounded-xl p-4">
          <p className="text-coral-700 text-sm">
            {error || "Transcription failed."}
          </p>
          <button
            onClick={onRetry}
            disabled={retrying}
            className="press px-4 py-1.5 bg-coral-600 hover:bg-coral-700 text-white disabled:opacity-50 disabled:hover:bg-coral-600 rounded-lg font-bold text-sm"
          >
            {retrying ? "Retrying…" : "Retry transcription"}
          </button>
        </div>
      )}

      {status === "ready" && (
        <>
          {segments && segments.length > 0 ? (
            <ol
              dir={rtl ? "rtl" : "ltr"}
              className="bg-surface border border-border rounded-2xl divide-y divide-border max-h-96 overflow-y-auto"
              style={{ boxShadow: "var(--shadow-sm)" }}
            >
              {segments.map((s: TranscriptSegment, i: number) => (
                <li
                  key={i}
                  className="flex gap-3 p-3 text-sm hover:bg-cream-sunken cursor-pointer transition-colors"
                  onClick={() => onSeek(s.start)}
                >
                  <button
                    className="shrink-0 text-brand font-bold tabular-nums text-xs min-w-[48px] text-left"
                    aria-label={`Seek to ${fmtTime(s.start)}`}
                  >
                    {fmtTime(s.start)}
                  </button>
                  <span className="text-ink">{s.text.trim()}</span>
                </li>
              ))}
            </ol>
          ) : text ? (
            <p
              dir={rtl ? "rtl" : "ltr"}
              className="bg-surface border border-border rounded-2xl p-4 text-sm text-ink whitespace-pre-wrap"
              style={{ boxShadow: "var(--shadow-sm)" }}
            >
              {text}
            </p>
          ) : (
            <p className="text-ink-muted text-sm italic">(empty)</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onRetry}
              disabled={retrying}
              className="press-sm px-3 py-1 text-xs font-semibold text-ink-muted hover:text-brand underline-offset-2 hover:underline"
            >
              {retrying ? "Re-transcribing…" : "Re-transcribe"}
            </button>
            {text && (
              <button
                onClick={() => navigator.clipboard.writeText(text)}
                className="press-sm px-3 py-1 text-xs font-semibold text-ink-muted hover:text-brand underline-offset-2 hover:underline"
              >
                Copy transcript
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
