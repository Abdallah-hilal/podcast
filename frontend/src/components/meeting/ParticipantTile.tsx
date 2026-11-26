"use client";

import {
  VideoTrack,
  useParticipantAttributes,
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
        "relative h-full w-full overflow-hidden rounded-[22px] bg-studio-tile transition-shadow duration-150",
        speaking && !muted
          ? "ring-[3px] ring-zinc-900 ring-offset-2 ring-offset-cream"
          : "",
      ].join(" ")}
      style={{ boxShadow: "0 10px 30px rgba(24, 24, 27, 0.12)" }}
    >
      {hasVideo && "publication" in trackRef && trackRef.publication ? (
        <VideoTrack
          trackRef={trackRef as never}
          className="w-full h-full object-cover"
          style={isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-studio-tile">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-studio-btn-hover text-2xl font-bold text-white md:h-24 md:w-24 md:text-3xl">
            {initials(name)}
          </div>
        </div>
      )}

      <RecStatusChip participant={participant} />

      <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between pointer-events-none">
        <div className="flex max-w-full items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-sm">
          {muted && <MicOffIcon className="h-3.5 w-3.5 shrink-0 text-coral-700" />}
          <span className="truncate text-xs font-semibold text-ink md:text-sm">
            {name}
            {isLocal && <span className="font-medium text-ink-muted"> (you)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Each client publishes `rec` / `up` participant attributes from its own
 * recorder. This chip lets the host see that a guest is actually recording,
 * and when their upload has finished (safe to hang up).
 */
function RecStatusChip({ participant }: { participant: Participant }) {
  const { attributes } = useParticipantAttributes({ participant });
  const rec = attributes?.rec;
  const up = attributes?.up ?? "0";
  if (!rec || rec === "idle") return null;

  const { text, cls } =
    rec === "recording"
      ? { text: "● REC", cls: "bg-coral-600 text-white" }
      : rec === "uploading"
        ? { text: `↑ Uploading ${up}%`, cls: "bg-white text-ink" }
        : rec === "done"
          ? { text: "✓ Saved", cls: "bg-white text-emerald-700" }
          : { text: "⚠ Upload paused", cls: "bg-white text-coral-700" };

  return (
    <div
      role="status"
      aria-label={`${participant.name || "Participant"}: ${text}`}
      className={`appear pointer-events-none absolute right-3 top-3 z-10 rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums tracking-wide shadow-sm ${cls}`}
    >
      {text}
    </div>
  );
}
