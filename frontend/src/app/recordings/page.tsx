"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import * as api from "@/lib/api";
import { DeleteButton } from "@/components/common/DeleteButton";

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

const STATUS_CLASS: Record<string, string> = {
  ready: "bg-green-900 text-green-300",
  recording: "bg-blue-900 text-blue-300",
  uploading: "bg-blue-900 text-blue-300",
  uploaded: "bg-blue-900 text-blue-300",
  processing: "bg-yellow-900 text-yellow-300",
  error: "bg-red-900 text-red-300",
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
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Recordings</h1>
          <Link href="/" className="text-gray-400 hover:text-white text-sm">
            ← Sessions
          </Link>
        </div>

        {err && <p className="text-red-400 text-sm">{err}</p>}

        {rows === null && !err && (
          <p className="text-gray-500">Loading…</p>
        )}

        {rows && rows.length === 0 && (
          <p className="text-gray-500">
            No recordings yet. Start a session and record to see them here.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((r) => {
              const title = r.podcast_participants?.podcast_sessions?.title ?? "Untitled";
              const role = r.podcast_participants?.role ?? "—";
              const clickable = r.status === "ready";
              const cls = STATUS_CLASS[r.status] ?? "bg-gray-700 text-gray-300";
              const ts = r.transcript_status;
              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {role} · {fmtDate(r.created_at)} · {fmtBytes(r.total_bytes)}
                      {ts && ts !== "none" && (
                        <> · transcript: <span className={
                          ts === "ready" ? "text-green-400"
                          : ts === "error" ? "text-red-400"
                          : "text-yellow-400"
                        }>{ts}</span></>
                      )}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded shrink-0 ${cls}`}>
                    {r.status}
                  </span>
                </>
              );
              return (
                <li
                  key={r.id}
                  className={`relative flex items-center gap-4 p-4 rounded-lg transition-colors ${
                    clickable
                      ? "bg-gray-900 hover:bg-gray-800"
                      : "bg-gray-900/60 opacity-60"
                  }`}
                >
                  {clickable ? (
                    <Link
                      href={`/recordings/${r.id}`}
                      className="flex items-center gap-4 flex-1 min-w-0"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-4 flex-1 min-w-0 cursor-not-allowed">
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
