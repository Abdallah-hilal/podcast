"use client";

import { useState } from "react";
import { LinkIcon, CheckIcon } from "./icons";

export function InviteButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    if (!origin) return;
    const url = `${origin}/session/${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.createElement("textarea");
      el.value = url;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } catch {
        // Nothing we can do.
      }
      document.body.removeChild(el);
    }
  }

  return (
    <button
      onClick={copy}
      aria-live="polite"
      className={[
        "press flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold",
        copied
          ? "bg-teal-500/20 text-teal-100 ring-1 ring-teal-300/40"
          : "bg-coral-600 hover:bg-coral-700 text-white shadow-md hover:shadow-lg",
      ].join(" ")}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      <span className="hidden sm:inline">
        {copied ? "Copied!" : "Copy invite link"}
      </span>
      <span className="inline sm:hidden">
        {copied ? "Copied" : "Invite"}
      </span>
    </button>
  );
}
