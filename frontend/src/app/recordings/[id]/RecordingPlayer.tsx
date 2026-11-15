"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import { Logo } from "@/components/common/Logo";

export default function RecordingPlayer({ recordingId }: { recordingId: string }) {
  const router = useRouter();
  const supabase = createClient();

  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("");
  const [err, setErr] = useState("");

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

      try {
        const { data } = await supabase
          .schema("podcast")
          .from("recordings")
          .select(
            "participants!inner(sessions!inner(title))"
          )
          .eq("id", recordingId)
          .single();
        if (mounted && data) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (data as any)?.participants?.sessions?.title;
          if (t) setTitle(t);
        }

        const dl = await api.getDownloadUrl(session.access_token, recordingId);
        if (mounted) setUrl(dl.download_url);
      } catch (e) {
        if (mounted) setErr(e instanceof Error ? e.message : "Failed to load recording");
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [recordingId, router, supabase]);

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
              <video src={url} controls className="w-full aspect-video" />
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
      </div>
    </div>
  );
}
