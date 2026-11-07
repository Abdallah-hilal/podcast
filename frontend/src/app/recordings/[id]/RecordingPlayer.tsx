"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { loginUrlWithNext } from "@/lib/auth-redirect";
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
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold truncate">
            {title || "Recording"}
          </h1>
          <Link
            href="/recordings"
            className="text-gray-400 hover:text-white text-sm"
          >
            ← Recordings
          </Link>
        </div>

        {err && <p className="text-red-400 text-sm">{err}</p>}

        {!url && !err && <p className="text-gray-500">Loading…</p>}

        {url && (
          <>
            <div className="bg-black rounded-lg overflow-hidden">
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
                className="inline-block px-5 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
              >
                Download WebM
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

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-300">Transcript</h2>
        <span
          className={`text-xs px-2 py-1 rounded ${
            status === "ready"
              ? "bg-green-900 text-green-300"
              : status === "error"
                ? "bg-red-900 text-red-300"
                : status === "processing"
                  ? "bg-yellow-900 text-yellow-300"
                  : "bg-gray-700 text-gray-400"
          }`}
        >
          {status}{language ? ` · ${language}` : ""}
        </span>
      </div>

      {(status === "pending" || status === "processing") && (
        <p className="text-gray-500 text-sm">
          Transcribing with Whisper… (first run downloads the model, so this
          can take a minute)
        </p>
      )}

      {status === "error" && (
        <div className="space-y-2">
          <p className="text-red-400 text-sm">
            {error || "Transcription failed."}
          </p>
          <button
            onClick={onRetry}
            disabled={retrying}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm"
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
              className="bg-gray-900 rounded-lg divide-y divide-gray-800 max-h-96 overflow-y-auto"
            >
              {segments.map((s: TranscriptSegment, i: number) => (
                <li
                  key={i}
                  className="flex gap-3 p-3 text-sm hover:bg-gray-800 cursor-pointer"
                  onClick={() => onSeek(s.start)}
                >
                  <button
                    className="shrink-0 text-blue-400 tabular-nums text-xs min-w-[48px] text-left"
                    aria-label={`Seek to ${fmtTime(s.start)}`}
                  >
                    {fmtTime(s.start)}
                  </button>
                  <span className="text-gray-200">{s.text.trim()}</span>
                </li>
              ))}
            </ol>
          ) : text ? (
            <p
              dir={rtl ? "rtl" : "ltr"}
              className="bg-gray-900 rounded-lg p-4 text-sm text-gray-200 whitespace-pre-wrap"
            >
              {text}
            </p>
          ) : (
            <p className="text-gray-500 text-sm">(empty)</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onRetry}
              disabled={retrying}
              className="px-3 py-1 text-xs text-gray-400 hover:text-white underline"
            >
              {retrying ? "Re-transcribing…" : "Re-transcribe"}
            </button>
            {text && (
              <button
                onClick={() => navigator.clipboard.writeText(text)}
                className="px-3 py-1 text-xs text-gray-400 hover:text-white underline"
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
