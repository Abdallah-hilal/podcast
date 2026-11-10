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
    <div className="flex items-center justify-center gap-2 md:gap-3 py-5 px-4 bg-black/40 backdrop-blur-xl border-t border-white/10">
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

      <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" />

      {isRecording ? (
        <button
          onClick={onStop}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-coral-600 hover:bg-coral-700 rounded-full text-white font-bold transition-all shadow-lg hover:shadow-xl"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums">Stop · {fmt(elapsedMs)}</span>
        </button>
      ) : (
        <button
          onClick={onRecord}
          disabled={isBusy}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-coral-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded-full text-white font-bold transition-all ring-1 ring-white/10"
        >
          <RecordIcon className="w-3 h-3 text-coral-500" />
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

      <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" />

      <button
        onClick={onLeave}
        aria-label="Leave meeting"
        className="w-11 h-11 rounded-full bg-coral-700 hover:bg-coral-700/80 text-white flex items-center justify-center transition-all shadow-lg"
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
        "w-11 h-11 rounded-full flex items-center justify-center transition-all",
        on
          ? "bg-white/10 hover:bg-white/20 text-white ring-1 ring-white/10"
          : "bg-coral-600 hover:bg-coral-700 text-white",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}
