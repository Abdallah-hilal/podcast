"use client";

import { useParticipants } from "@livekit/components-react";

function UsersIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function ParticipantsBadge() {
  const participants = useParticipants();
  const count = participants.length;
  const alone = count <= 1;

  return (
    <div
      className={[
        "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
        alone
          ? "bg-amber-100 text-amber-800"
          : "bg-white text-ink-muted shadow-sm",
      ].join(" ")}
      aria-label={alone ? "Waiting for others" : `${count} participants in room`}
    >
      <UsersIcon className="w-3.5 h-3.5" />
      {/* Full label on sm+ screens; just the count on mobile to save header space. */}
      <span className="hidden sm:inline">
        {alone ? "Waiting for others" : `${count} in room`}
      </span>
      <span className="inline sm:hidden tabular-nums">
        {alone ? "1" : count}
      </span>
    </div>
  );
}
