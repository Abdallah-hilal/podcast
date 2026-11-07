"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

interface Props {
  initialMode: Mode;
}

function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  // Only allow relative in-app paths, not open-redirects to arbitrary URLs.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function AuthCard({ initialMode }: Props) {
  const router = useRouter();
  const supabase = createClient();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    const search =
      typeof window !== "undefined" ? window.location.search : "";
    const nextParam = new URLSearchParams(search).get("next");
    const next = sanitizeNext(nextParam);

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          setError(error.message);
          return;
        }
        router.push(next);
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) {
          setError(error.message);
          return;
        }
        // If email confirmation is off, the user is already signed in.
        if (data.session) {
          router.push(next);
          return;
        }
        setNotice(
          "Account created. Check your email for a confirmation link, then sign in.",
        );
        setMode("signin");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-3xl font-bold text-white">Podcast Studio</h1>
          <p className="text-sm text-gray-500">
            Record together. Each side uploads its own.
          </p>
        </div>

        <div className="bg-gray-900/80 backdrop-blur-sm border border-white/5 rounded-2xl p-6 shadow-2xl">
          <div className="flex gap-1 p-1 bg-gray-950/70 rounded-lg mb-5">
            <TabButton
              active={mode === "signin"}
              onClick={() => {
                setMode("signin");
                setError("");
                setNotice("");
              }}
            >
              Sign in
            </TabButton>
            <TabButton
              active={mode === "signup"}
              onClick={() => {
                setMode("signup");
                setError("");
                setNotice("");
              }}
            >
              Create account
            </TabButton>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="block text-xs uppercase tracking-wider text-gray-500">
                Email
              </span>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2.5 bg-gray-950/60 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="block text-xs uppercase tracking-wider text-gray-500">
                Password
              </span>
              <input
                type="password"
                placeholder={
                  mode === "signup" ? "At least 6 characters" : "Your password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "signup" ? 6 : undefined}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                className="w-full px-3 py-2.5 bg-gray-950/60 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>

            {error && (
              <p className="text-red-400 text-sm px-1">{error}</p>
            )}
            {notice && (
              <p className="text-green-400 text-sm px-1">{notice}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors shadow-lg shadow-blue-600/20"
            >
              {loading
                ? mode === "signin"
                  ? "Signing in…"
                  : "Creating account…"
                : mode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex-1 py-2 text-sm font-medium rounded-md transition-colors",
        active
          ? "bg-gray-800 text-white shadow"
          : "text-gray-500 hover:text-gray-300",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
