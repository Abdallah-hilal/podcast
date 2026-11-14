"use client";

// Guest landing. An invite link is the credential — if the viewer isn't
// already signed in, create an anonymous Supabase user transparently and
// bounce them into /session/:id. If they're already signed in (owner or
// previous guest in this tab), skip straight to the session.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function JoinClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    async function go() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (cancelled) return;
        if (error) {
          setError(
            error.message ||
              "Couldn't open this session. Ask the host for a fresh invite link.",
          );
          return;
        }
      }

      // replace, not push — pressing Back shouldn't come back to /join.
      router.replace(`/session/${sessionId}`);
    }

    go();
    return () => {
      cancelled = true;
    };
  }, [sessionId, router]);

  if (error) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div
          className="max-w-md text-center space-y-4 bg-surface border border-border rounded-2xl p-6"
          style={{ boxShadow: "var(--shadow-photo)" }}
        >
          <p className="text-coral-700 font-bold text-lg">{error}</p>
          <Link
            href="/"
            className="press inline-block px-5 py-2 bg-brand hover:bg-brand-hover text-white rounded-xl font-bold shadow-md"
          >
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--gradient-teal)" }}
    >
      <div className="text-teal-100 text-sm animate-pulse">Opening session…</div>
    </div>
  );
}
