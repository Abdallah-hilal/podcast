"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import * as api from "@/lib/api";
import { DeleteButton } from "@/components/common/DeleteButton";
import { Logo } from "@/components/common/Logo";

type Row = {
  id: string;
  status: string;
  total_bytes: number | null;
  created_at: string;
  mime_type: string | null;
  transcript_status: string | null;
  podcast_participants: {
    role: "host" | "guest";
    podcast_sessions: { id: string; title: string };
  };
};

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_CLASS: Record<string, { cls: string; label: string }> = {
  ready: {
    cls: "bg-teal-100 text-brand ring-1 ring-teal-900/10",
    label: "Ready",
  },
  recording: {
    cls: "bg-coral-600/10 text-coral-700 ring-1 ring-coral-600/20",
    label: "Recording",
  },
  uploading: {
    cls: "bg-coral-600/10 text-coral-700 ring-1 ring-coral-600/20",
    label: "Uploading",
  },
  uploaded: {
    cls: "bg-teal-100 text-brand ring-1 ring-teal-900/10",
    label: "Uploaded",
  },
  processing: {
    cls: "bg-orange-400/20 text-coral-700 ring-1 ring-coral-600/20",
    label: "Processing",
  },
  error: {
    cls: "bg-coral-600/15 text-coral-700 ring-1 ring-coral-600/30",
    label: "Error",
  },
};

export default function RecordingsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push(loginUrlWithNext());
        return;
      }
      if (mounted) setToken(session.access_token);

      const { data, error } = await supabase
        .from("podcast_recordings")
        .select(
          "id, status, total_bytes, created_at, mime_type, transcript_status, " +
          "podcast_participants!inner(role, podcast_sessions!inner(id, title))"
        )
        .order("created_at", { ascending: false });

      if (!mounted) return;
      if (error) {
        setErr(error.message);
      } else {
        setRows((data || []) as unknown as Row[]);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [router, supabase]);

  async function handleDelete(recordingId: string) {
    if (!token) return;
    await api.deleteRecording(token, recordingId);
    setRows((xs) => xs?.filter((r) => r.id !== recordingId) ?? xs);
  }

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

        <div>
          <h1 className="text-[clamp(1.5rem,4.5vw,2.25rem)] font-black">Recordings</h1>
          <p className="text-sm text-ink-muted mt-1 leading-relaxed">
            One row per participant per session.
          </p>
        </div>

        {err && (
          <p className="text-coral-700 bg-coral-600/10 border border-coral-600/20 rounded-lg px-3 py-2 text-sm">
            {err}
          </p>
        )}

        {rows === null && !err && (
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="flex items-center gap-3 p-4 bg-surface border border-border rounded-xl animate-pulse"
                style={{ boxShadow: "var(--shadow-sm)" }}
              >
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-cream-200 rounded w-1/2" />
                  <div className="h-3 bg-cream-200 rounded w-2/3" />
                </div>
                <div className="w-14 h-5 bg-cream-200 rounded-full" />
              </li>
            ))}
          </ul>
        )}

        {rows && rows.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border-strong/40 bg-cream-sunken/60 p-6 text-center">
            <p className="text-sm text-ink-muted">
              No recordings yet. Start a session and record to see them here.
            </p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((r) => {
              const title = r.podcast_participants?.podcast_sessions?.title ?? "Untitled";
              const role = r.podcast_participants?.role ?? "—";
              const clickable = r.status === "ready";
              const statusInfo = STATUS_CLASS[r.status] ?? { cls: "bg-cream-200 text-ink-muted", label: r.status };
              const ts = r.transcript_status;

              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-ink group-hover:text-brand transition-colors">
                      {title}
                    </div>
                    <div className="text-xs text-ink-muted mt-0.5 flex flex-wrap items-center gap-x-1">
                      <span className="font-medium capitalize">{role}</span>
                      <span>·</span>
                      <span>{fmtDate(r.created_at)}</span>
                      <span>·</span>
                      <span>{fmtBytes(r.total_bytes)}</span>
                      {ts && ts !== "none" && (
                        <>
                          <span>·</span>
                          <span>
                            transcript:{" "}
                            <span
                              className={
                                ts === "ready"
                                  ? "text-brand font-semibold"
                                  : ts === "error"
                                    ? "text-coral-700 font-semibold"
                                    : "text-coral-500 font-semibold"
                              }
                            >
                              {ts}
                            </span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full shrink-0 ${statusInfo.cls}`}
                  >
                    {statusInfo.label}
                  </span>
                </>
              );

              return (
                <li
                  key={r.id}
                  className={`group appear relative flex items-center gap-3 p-4 rounded-xl border transition-[border-color,box-shadow,opacity] duration-220 ease-[cubic-bezier(.22,1,.36,1)] ${
                    clickable
                      ? "bg-surface border-border hover:border-brand/30 hover:shadow-md"
                      : "bg-cream-sunken/60 border-border/50 opacity-70"
                  }`}
                  style={{ boxShadow: clickable ? "var(--shadow-sm)" : undefined }}
                >
                  {clickable ? (
                    <Link
                      href={`/recordings/${r.id}`}
                      className="press flex items-center gap-3 flex-1 min-w-0"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 flex-1 min-w-0 cursor-not-allowed">
                      {inner}
                    </div>
                  )}
                  <DeleteButton
                    onDelete={() => handleDelete(r.id)}
                    label="Delete"
                    confirmLabel="Delete?"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
