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
import { InCallDeviceSwitcher } from "./InCallDeviceSwitcher";

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
  /** Disables the Record button when the recording source isn't ready. */
  canRecord?: boolean;
  /** Locks the mic/camera toggles while a recording is live — toggling off
   *  mid-recording ends the underlying track and silently cuts the file. */
  lockDeviceToggles?: boolean;
  /** Opens a Save-As picker; on pick the pipeline swaps its local-save file.
   *  Omit on browsers without File System Access API support — the button
   *  is hidden entirely. */
  onChangeLocalSave?: () => void;
  /** Filename currently teed to; null when no local copy is being written. */
  localSaveFilename?: string | null;
}

export function ControlBar({
  recState,
  elapsedMs,
  onRecord,
  onStop,
  onLeave,
  canRecord = true,
  lockDeviceToggles = false,
  onChangeLocalSave,
  localSaveFilename,
}: Props) {
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const cam = useTrackToggle({ source: Track.Source.Camera });

  const isRecording = recState === "recording";
  const isBusy = recState === "stopping" || recState === "uploading";

  return (
    // material-dark: translucent chrome floating over the VideoGrid instead
    // of a solid bar that eats a fixed strip of the canvas. The inset top
    // highlight reads as light catching the glass.
    <div className="relative flex items-center justify-center gap-2 md:gap-3 py-5 px-4 material-dark border-t border-white/5">
      <IconToggle
        on={mic.enabled}
        onClick={() => mic.toggle()}
        disabled={lockDeviceToggles}
        onIcon={<MicIcon />}
        offIcon={<MicOffIcon />}
        label={mic.enabled ? "Mute microphone" : "Unmute microphone"}
      />
      <IconToggle
        on={cam.enabled}
        onClick={() => cam.toggle()}
        disabled={lockDeviceToggles}
        onIcon={<CamIcon />}
        offIcon={<CamOffIcon />}
        label={cam.enabled ? "Turn camera off" : "Turn camera on"}
      />

      <InCallDeviceSwitcher locked={lockDeviceToggles} />

      <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" aria-hidden />

      {isRecording ? (
        <button
          onClick={onStop}
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-coral-600 hover:bg-coral-700 rounded-full text-white font-bold shadow-lg hover:shadow-xl"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums tracking-tight">
            Stop · {fmt(elapsedMs)}
          </span>
        </button>
      ) : (
        <button
          onClick={onRecord}
          disabled={isBusy || !canRecord}
          title={!canRecord ? "Turn on mic or camera first" : undefined}
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-coral-600/80 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white/10 rounded-full text-white font-bold ring-1 ring-white/10"
        >
          <RecordIcon className="w-3 h-3 text-coral-500" />
          <span className="text-sm tracking-tight">
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

      {onChangeLocalSave && (
        <>
          <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" aria-hidden />
          <LocalSaveButton
            onClick={onChangeLocalSave}
            filename={localSaveFilename ?? null}
          />
        </>
      )}

      <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" aria-hidden />

      <button
        onClick={onLeave}
        aria-label="Leave meeting"
        className="press w-11 h-11 rounded-full bg-coral-700 hover:bg-coral-700/80 text-white flex items-center justify-center shadow-lg"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}

function LocalSaveButton({
  onClick,
  filename,
}: {
  onClick: () => void;
  filename: string | null;
}) {
  // Truncate long names so the control bar stays legible. Keep the extension
  // visible — people recognise their own file by its ".webm" tail.
  const display = filename
    ? filename.length > 24
      ? filename.slice(0, 10) + "…" + filename.slice(-10)
      : filename
    : "Save locally";
  return (
    <button
      onClick={onClick}
      title={
        filename
          ? `Saving locally to "${filename}". Click to pick a different file.`
          : "Pick a file to save a local copy of this recording."
      }
      className="press flex items-center gap-2 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold ring-1 ring-white/10 max-w-[200px]"
    >
      <svg aria-hidden className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
      <span className="truncate tracking-tight">{display}</span>
    </button>
  );
}

function IconToggle({
  on,
  onClick,
  disabled,
  onIcon,
  offIcon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      title={disabled ? "Locked while recording" : label}
      className={[
        "press w-11 h-11 rounded-full flex items-center justify-center",
        disabled ? "cursor-not-allowed opacity-50" : "",
        on
          ? "bg-white/10 hover:bg-white/20 text-white ring-1 ring-white/10"
          : "bg-coral-600 hover:bg-coral-700 text-white",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}
