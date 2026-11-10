"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { loginUrlWithNext } from "@/lib/auth-redirect";
import { DeleteButton } from "@/components/common/DeleteButton";
import { Logo } from "@/components/common/Logo";

export default function HomePage() {
  const [title, setTitle] = useState("");
  const [sessions, setSessions] = useState<
    { id: string; title: string; status: string }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.push(loginUrlWithNext());
        return;
      }
      setToken(session.access_token);

      supabase
        .from("podcast_sessions")
        .select("id, title, status")
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          setSessions(data ?? []);
        });
    });
  }, [router, supabase]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !title.trim()) return;
    setLoading(true);

    try {
      const session = await api.createSession(token, title.trim());
      router.push(`/session/${session.session_id}`);
    } catch (err) {
      console.error("Failed to create session:", err);
      setLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function handleDelete(sessionId: string) {
    if (!token) return;
    await api.deleteSession(token, sessionId);
    setSessions((xs) => xs?.filter((s) => s.id !== sessionId) ?? xs);
  }

  if (!token) return null;

  return (
    <div className="min-h-screen bg-cream text-ink p-4 sm:p-8">
      <div className="max-w-2xl mx-auto space-y-6 sm:space-y-10">
        <header className="flex items-center justify-between gap-3">
          <Logo size="md" />
          <div className="flex items-center gap-3 sm:gap-5 shrink-0">
            <Link
              href="/recordings"
              className="press text-sm font-medium text-ink-muted hover:text-brand"
            >
              Recordings
            </Link>
            <button
              onClick={handleLogout}
              className="press text-sm font-medium text-ink-muted hover:text-brand"
            >
              Sign out
            </button>
          </div>
        </header>

        <section className="space-y-3">
          <div className="space-y-1.5">
            <h1 className="text-[clamp(1.75rem,5.5vw,2.75rem)] font-black">
              Record with someone<span className="text-coral-600">.</span>
            </h1>
            <p className="text-ink-muted text-sm sm:text-base leading-relaxed max-w-xl">
              Start a session, share the link — each side records locally at
              full quality and uploads to your own storage.
            </p>
          </div>

          <form
            onSubmit={handleCreate}
            className="flex flex-col sm:flex-row gap-2 sm:gap-3 pt-2"
          >
            <input
              type="text"
              placeholder="Episode title…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="flex-1 min-w-0 px-4 py-3 bg-surface border border-border rounded-xl text-ink placeholder-cream-400 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-colors"
            />
            <button
              type="submit"
              disabled={loading}
              className="press px-6 py-3 bg-coral-600 hover:bg-coral-700 disabled:opacity-60 disabled:hover:bg-coral-600 text-white rounded-xl font-bold shadow-md hover:shadow-lg whitespace-nowrap"
            >
              {loading ? "Creating…" : "New session"}
            </button>
          </form>
        </section>

        {sessions === null && (
          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-muted">
              Your sessions
            </h2>
            <ul className="space-y-2">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 p-4 bg-surface border border-border rounded-xl animate-pulse"
                  style={{ boxShadow: "var(--shadow-sm)" }}
                >
                  <div className="flex-1 h-4 bg-cream-200 rounded" />
                  <div className="w-12 h-5 bg-cream-200 rounded-full" />
                </li>
              ))}
            </ul>
          </section>
        )}

        {sessions && sessions.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-muted">
              Your sessions
            </h2>
            <ul className="space-y-2">
              {sessions.map((s) => {
                // An ended session has no live room to rejoin — point the main
                // link at the Mix page (recordings + composite) instead of the
                // room, which would just reject the join.
                const ended = s.status === "ended";
                const primaryHref = ended
                  ? `/session/${s.id}/mix`
                  : `/session/${s.id}`;
                return (
                  <li
                    key={s.id}
                    className={`group appear relative flex items-center gap-3 p-4 bg-surface border rounded-xl transition-[border-color,box-shadow,opacity] duration-220 ease-[cubic-bezier(.22,1,.36,1)] ${
                      ended
                        ? "border-border/60 opacity-80"
                        : "border-border hover:border-brand/30 hover:shadow-md"
                    }`}
                    style={{ boxShadow: "var(--shadow-sm)" }}
                  >
                    <Link
                      href={primaryHref}
                      className="press flex-1 min-w-0 truncate font-semibold text-ink group-hover:text-brand"
                    >
                      {s.title}
                    </Link>
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                      {!ended && (
                        <Link
                          href={`/session/${s.id}/mix`}
                          className="press text-xs font-semibold text-teal-700 hover:text-brand underline-offset-2 hover:underline"
                        >
                          Mix
                        </Link>
                      )}
                      <StatusPill status={s.status} />
                      <DeleteButton
                        onDelete={() => handleDelete(s.id)}
                        label="Delete"
                        confirmLabel="Delete?"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {sessions && sessions.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border-strong/40 bg-cream-sunken/60 p-6 text-center">
            <p className="text-sm text-ink-muted">
              No sessions yet. Give your first episode a title above to start.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    active: { cls: "bg-coral-600/10 text-coral-700 ring-1 ring-coral-600/20", label: "Active" },
    ended: { cls: "bg-cream-200 text-ink-muted", label: "Ended" },
    created: { cls: "bg-teal-100 text-brand ring-1 ring-teal-900/10", label: "Ready" },
  };
  const { cls, label } = map[status] ?? { cls: "bg-cream-200 text-ink-muted", label: status };
  return (
    <span className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full ${cls}`}>
      {label}
    </span>
  );
}
