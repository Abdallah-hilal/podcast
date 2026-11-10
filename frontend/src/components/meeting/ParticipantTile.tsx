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
        "relative w-full h-full rounded-2xl overflow-hidden bg-black ring-2 transition-all duration-150",
        speaking && !muted
          ? "ring-coral-600 shadow-[0_0_0_4px_rgba(255,111,60,0.2)]"
          : "ring-white/10",
      ].join(" ")}
      style={{ boxShadow: "var(--shadow-photo)" }}
    >
      {hasVideo && "publication" in trackRef && trackRef.publication ? (
        <VideoTrack
          trackRef={trackRef as never}
          className="w-full h-full object-cover"
          style={isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center"
          style={{ background: "var(--gradient-teal)" }}
        >
          <div
            className="w-20 h-20 md:w-28 md:h-28 rounded-full flex items-center justify-center text-3xl md:text-4xl font-black text-white shadow-2xl"
            style={{ background: "var(--gradient-sunset)" }}
          >
            {initials(name)}
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between pointer-events-none">
        <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md rounded-full px-3 py-1.5 max-w-full ring-1 ring-white/10">
          {muted && <MicOffIcon className="w-3.5 h-3.5 text-coral-500 shrink-0" />}
          <span className="text-xs md:text-sm font-semibold text-white truncate">
            {name}
            {isLocal && <span className="text-teal-300 font-normal"> (You)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
