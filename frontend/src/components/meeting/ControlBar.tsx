"use client";

import { useTrackToggle } from "@livekit/components-react";
import { Track } from "livekit-client";
import type { PipelineState } from "@/types";
import {
  MicIcon,
  MicOffIcon,
  CamIcon,
  CamOffIcon,
  RecordIcon,
  StopIcon,
  PhoneOffIcon,
} from "./icons";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

interface Props {
  recState: PipelineState;
  elapsedMs: number;
  onRecord: () => void;
  onStop: () => void;
  onLeave: () => void;
}

export function ControlBar({ recState, elapsedMs, onRecord, onStop, onLeave }: Props) {
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const cam = useTrackToggle({ source: Track.Source.Camera });

  const isRecording = recState === "recording";
  const isBusy = recState === "stopping" || recState === "uploading";

  return (
    <div className="flex items-center justify-center gap-2 md:gap-3 py-5 px-4 bg-gray-900/80 backdrop-blur-md border-t border-white/5">
      <IconToggle
        on={mic.enabled}
        onClick={() => mic.toggle()}
        onIcon={<MicIcon />}
        offIcon={<MicOffIcon />}
        label={mic.enabled ? "Mute microphone" : "Unmute microphone"}
      />
      <IconToggle
        on={cam.enabled}
        onClick={() => cam.toggle()}
        onIcon={<CamIcon />}
        offIcon={<CamOffIcon />}
        label={cam.enabled ? "Turn camera off" : "Turn camera on"}
      />

      <div className="w-px h-8 bg-white/10 mx-1 md:mx-2" />

      {isRecording ? (
        <button
          onClick={onStop}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-red-600 hover:bg-red-700 rounded-full text-white font-medium transition-colors shadow-lg shadow-red-600/20"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums">Stop · {fmt(elapsedMs)}</span>
        </button>
      ) : (
        <button
          onClick={onRecord}
          disabled={isBusy}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-white/15 disabled:opacity-50 disabled:cursor-not-allowed rounded-full text-white font-medium transition-colors"
        >
          <RecordIcon className="w-3 h-3 text-red-500" />
          <span className="text-sm">
            {isBusy
              ? recState === "uploading"
                ? "Uploading…"
                : "Finalizing…"
              : recState === "complete"
                ? "Record again"
                : "Record"}
          </span>
        </button>
      )}

      <div className="w-px h-8 bg-white/10 mx-1 md:mx-2" />

      <button
        onClick={onLeave}
        aria-label="Leave meeting"
        className="w-11 h-11 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition-colors shadow-lg shadow-red-600/20"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}

function IconToggle({
  on,
  onClick,
  onIcon,
  offIcon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={[
        "w-11 h-11 rounded-full flex items-center justify-center transition-colors",
        on
          ? "bg-white/10 hover:bg-white/15 text-white"
          : "bg-red-600 hover:bg-red-700 text-white",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}
