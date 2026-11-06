"use client";

import {
  useParticipantIds,
  useLocalSessionId,
  DailyVideo,
} from "@daily-co/daily-react";

export function VideoGrid() {
  const localId = useLocalSessionId();
  const participantIds = useParticipantIds();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-4xl mx-auto">
      {participantIds.map((id) => (
        <div
          key={id}
          className="relative aspect-video bg-gray-900 rounded-lg overflow-hidden"
        >
          <DailyVideo
            sessionId={id}
            type="video"
            className="w-full h-full object-cover"
          />
          <span className="absolute bottom-2 left-2 bg-black/60 text-white text-sm px-2 py-1 rounded">
            {id === localId ? "You" : "Guest"}
          </span>
        </div>
      ))}
    </div>
  );
}
