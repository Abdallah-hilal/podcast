"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/common/Logo";

function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function AuthCard() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const search =
      typeof window !== "undefined" ? window.location.search : "";
    const nextParam = new URLSearchParams(search).get("next");
    const next = sanitizeNext(nextParam);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
        return;
      }
      router.push(next);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-6 relative overflow-hidden">
      {/* Decorative orange glow in the top-right, teal in the bottom-left — subtle brand presence */}
      <div
        aria-hidden
        className="absolute -top-32 -right-32 w-80 h-80 rounded-full opacity-40 blur-3xl"
        style={{ background: "var(--gradient-sunset)" }}
      />
      <div
        aria-hidden
        className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full opacity-25 blur-3xl"
        style={{ background: "var(--gradient-teal)" }}
      />

      <div className="relative w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <Logo size="lg" linkTo="" />
          </div>
          <p className="text-sm text-ink-muted">
            Record together. Each side uploads its own.
          </p>
        </div>

        <div
          className="bg-surface border border-border rounded-2xl p-6"
          style={{ boxShadow: "var(--shadow-photo)" }}
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="block text-[11px] uppercase tracking-widest font-bold text-ink-muted">
                Email
              </span>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2.5 bg-cream-sunken/70 border border-border rounded-xl text-ink placeholder-cream-400 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-colors"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="block text-[11px] uppercase tracking-widest font-bold text-ink-muted">
                Password
              </span>
              <input
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full px-3 py-2.5 bg-cream-sunken/70 border border-border rounded-xl text-ink placeholder-cream-400 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-colors"
              />
            </label>

            {error && (
              <p className="text-coral-700 bg-coral-600/10 border border-coral-600/20 rounded-lg px-3 py-2 text-sm">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="press w-full py-3 bg-brand hover:bg-brand-hover disabled:opacity-60 disabled:hover:bg-brand text-white rounded-xl font-bold shadow-md hover:shadow-lg"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-ink-muted">
          Built by <a href="https://abdallahhelal.com" className="font-bold text-brand hover:text-coral-600 transition-colors">Abdallah Helal</a>
        </p>
      </div>
    </div>
  );
}
