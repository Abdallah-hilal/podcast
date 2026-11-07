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
      className={[
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all",
        copied
          ? "bg-green-900/40 text-green-300 ring-1 ring-green-700/50"
          : "bg-blue-600/20 hover:bg-blue-600/30 text-blue-300",
      ].join(" ")}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      <span>{copied ? "Copied!" : "Copy invite link"}</span>
    </button>
  );
}
