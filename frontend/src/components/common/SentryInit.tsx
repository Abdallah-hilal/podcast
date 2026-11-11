"use client";

import { useEffect } from "react";

/**
 * Lightweight Sentry browser init, gated on NEXT_PUBLIC_SENTRY_DSN.
 *
 * We deliberately use `@sentry/browser` (not `@sentry/nextjs`) to avoid
 * the latter's build-time hooks and source-map uploader — those add a lot
 * of surface area for a single-page recording app. Captures uncaught
 * exceptions + unhandled promise rejections; errors we report ourselves
 * via `Sentry.captureException()` will also show up.
 *
 * Perf traces, session replays, and profiling are off — flip them on
 * when you actually have a dashboard to watch them in.
 */
export function SentryInit() {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;

    // Static import would bundle Sentry into every page even when disabled;
    // a one-shot dynamic import keeps it out of the critical path for
    // installs that don't enable error tracking.
    void import("@sentry/browser").then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
        tracesSampleRate: 0,
        // No session replays — would catch camera previews + mic levels,
        // privacy nightmare and heavy to transmit.
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      });
    });
  }, []);

  return null;
}
