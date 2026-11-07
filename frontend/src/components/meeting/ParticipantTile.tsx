"use client";

import {
  VideoTrack,
  useSpeakingParticipants,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { MicOffIcon } from "./icons";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function isMicMuted(p: Participant): boolean {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  return !pub || pub.isMuted;
}

function hasVideoTrack(tr: TrackReferenceOrPlaceholder): boolean {
  if (!("publication" in tr)) return false;
  const pub = tr.publication;
  return !!pub && !pub.isMuted;
}

export function ParticipantTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const speakers = useSpeakingParticipants();
  const participant = trackRef.participant;
  const name = participant.name || participant.identity || "Participant";
  const speaking = speakers.some((s) => s.identity === participant.identity);
  const muted = isMicMuted(participant);
  const hasVideo = hasVideoTrack(trackRef);
  const isLocal = participant.isLocal;

  return (
    <div
      className={[
        "relative w-full h-full rounded-2xl overflow-hidden bg-gray-900 shadow-xl ring-2 transition-all duration-150",
        speaking && !muted ? "ring-blue-500 shadow-blue-500/20" : "ring-white/5",
      ].join(" ")}
    >
      {hasVideo && "publication" in trackRef && trackRef.publication ? (
        <VideoTrack
          trackRef={trackRef as never}
          className="w-full h-full object-cover"
          style={isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900">
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-3xl md:text-4xl font-bold text-white shadow-2xl">
            {initials(name)}
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between pointer-events-none">
        <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md rounded-full px-3 py-1.5 max-w-full">
          {muted && <MicOffIcon className="w-3.5 h-3.5 text-red-400 shrink-0" />}
          <span className="text-xs md:text-sm font-medium text-white truncate">
            {name}
            {isLocal && <span className="text-gray-400"> (You)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
