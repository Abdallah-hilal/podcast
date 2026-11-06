"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";

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
        router.push("/login");
        return;
      }

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
                src={url}
                controls
                className="w-full aspect-video"
              />
            </div>
            <a
              href={url}
              download={`recording-${recordingId}.webm`}
              className="inline-block px-5 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
            >
              Download WebM
            </a>
          </>
        )}
      </div>
    </div>
  );
}
