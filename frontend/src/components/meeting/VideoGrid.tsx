"use client";

import { useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { ParticipantTile } from "./ParticipantTile";

export function VideoGrid() {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );

  const count = tracks.length || 1;

  // 1 → single centered, 2 → side-by-side, 3-4 → 2x2
  const gridClass =
    count === 1
      ? "grid-cols-1 max-w-4xl"
      : count === 2
        ? "grid-cols-1 md:grid-cols-2 max-w-7xl"
        : "grid-cols-2 max-w-6xl";

  return (
    <div className={`grid ${gridClass} gap-3 md:gap-4 w-full mx-auto`}>
      {tracks.map((tr, i) => (
        <div
          key={`${tr.participant.identity}-${i}`}
          className="aspect-video w-full"
        >
          <ParticipantTile trackRef={tr} />
        </div>
      ))}
    </div>
  );
}
