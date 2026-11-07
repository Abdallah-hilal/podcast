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
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
        alone
          ? "bg-amber-900/30 text-amber-300"
          : "bg-gray-800 text-gray-300",
      ].join(" ")}
      aria-label={alone ? "Waiting for others" : `${count} participants in room`}
    >
      <UsersIcon className="w-3.5 h-3.5" />
      <span>
        {alone
          ? "Waiting for others"
          : `${count} in room`}
      </span>
    </div>
  );
}
