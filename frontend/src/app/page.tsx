"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";

export default function HomePage() {
  const [title, setTitle] = useState("");
  const [sessions, setSessions] = useState<
    { id: string; title: string; status: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.push("/login");
        return;
      }
      setToken(session.access_token);

      supabase
        .from("podcast_sessions")
        .select("id, title, status")
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (data) setSessions(data);
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

  if (!token) return null;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Podcast Studio</h1>
          <button
            onClick={handleLogout}
            className="text-gray-400 hover:text-white text-sm"
          >
            Sign Out
          </button>
        </div>

        <form onSubmit={handleCreate} className="flex gap-3">
          <input
            type="text"
            placeholder="Episode title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg font-medium transition-colors"
          >
            {loading ? "Creating..." : "New Session"}
          </button>
        </form>

        {sessions.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-300">
              Your Sessions
            </h2>
            {sessions.map((s) => (
              <a
                key={s.id}
                href={`/session/${s.id}`}
                className="flex items-center justify-between p-4 bg-gray-900 hover:bg-gray-800 rounded-lg transition-colors"
              >
                <span>{s.title}</span>
                <span
                  className={`text-sm px-2 py-1 rounded ${
                    s.status === "active"
                      ? "bg-green-900 text-green-300"
                      : s.status === "ended"
                        ? "bg-gray-700 text-gray-400"
                        : "bg-blue-900 text-blue-300"
                  }`}
                >
                  {s.status}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
