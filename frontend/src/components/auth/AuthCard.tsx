"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/common/Logo";

type Mode = "signin" | "signup";

interface Props {
  initialMode: Mode;
}

function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
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
          <div className="flex gap-1 p-1 bg-cream-sunken rounded-xl mb-5">
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
                className="w-full px-3 py-2.5 bg-cream-sunken/70 border border-border rounded-xl text-ink placeholder-cream-400 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-colors"
              />
            </label>

            {error && (
              <p className="text-coral-700 bg-coral-600/10 border border-coral-600/20 rounded-lg px-3 py-2 text-sm">
                {error}
              </p>
            )}
            {notice && (
              <p className="text-brand bg-teal-100 border border-teal-900/10 rounded-lg px-3 py-2 text-sm">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="press w-full py-3 bg-brand hover:bg-brand-hover disabled:opacity-60 disabled:hover:bg-brand text-white rounded-xl font-bold shadow-md hover:shadow-lg"
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

        <p className="text-center text-xs text-ink-muted">
          Built by <a href="https://abdallahhelal.com" className="font-bold text-brand hover:text-coral-600 transition-colors">Abdallah Helal</a>
        </p>
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
      aria-pressed={active}
      className={[
        "press-sm flex-1 py-2 text-sm font-bold rounded-lg",
        active
          ? "bg-surface text-brand shadow-sm"
          : "text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
