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
  /** Opens a Save-As picker; on pick the pipeline swaps its local-save file.
   *  Omit on browsers without File System Access API support — the button
   *  is hidden entirely. */
  onChangeLocalSave?: () => void;
  /** Filename currently teed to; null when no local copy is being written. */
  localSaveFilename?: string | null;
  /** Host gets the Record/Stop button that drives everyone; guests get a
   *  read-only status pill. */
  isHost: boolean;
  /** The room-wide recording switch (LiveKit room metadata) is on. */
  switchOn: boolean;
  /** Host's Record/Stop request is in flight. */
  switchPending?: boolean;
  /** Last Record/Stop request failure, shown above the bar. */
  switchError?: string | null;
}

export function ControlBar({
  recState,
  elapsedMs,
  onRecord,
  onStop,
  onLeave,
  canRecord = true,
  onChangeLocalSave,
  localSaveFilename,
  isHost,
  switchOn,
  switchPending = false,
  switchError = null,
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
      {/* Mic + cam are safe to toggle during a recording: LiveKit's
          useTrackToggle does a soft mute (track.enabled = false), it does NOT
          end the MediaStreamTrack — the MediaRecorder stream stays live and
          captures silence / black frames for the muted window. Only the
          device SWITCHER needs locking, because switchActiveDevice rebuilds
          the track underneath us. */}
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

      <InCallDeviceSwitcher />

      <div className="w-px h-8 bg-white/15 mx-1 md:mx-2" aria-hidden />

      {switchError && (
        <div
          role="alert"
          className="appear absolute -top-11 left-1/2 -translate-x-1/2 max-w-[90vw] truncate bg-coral-700 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg"
        >
          {switchError}
        </div>
      )}

      {!isHost ? (
        <GuestRecordStatus
          recState={recState}
          elapsedMs={elapsedMs}
          switchOn={switchOn}
          canRecord={canRecord}
        />
      ) : switchOn ? (
        // Host: Stop turns the room switch off; everyone's recorder follows.
        <button
          onClick={onStop}
          disabled={switchPending}
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-coral-600 hover:bg-coral-700 disabled:opacity-70 rounded-full text-white font-bold shadow-lg hover:shadow-xl"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums tracking-tight">
            {switchPending
              ? "Stopping…"
              : isRecording
                ? `Stop · ${fmt(elapsedMs)}`
                : "Stop recording"}
          </span>
        </button>
      ) : (
        <button
          onClick={onRecord}
          disabled={isBusy || switchPending}
          title={
            !canRecord
              ? "Your mic and camera are off — guests will still record"
              : "Starts recording for everyone in the room"
          }
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-coral-600/80 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white/10 rounded-full text-white font-bold ring-1 ring-white/10"
        >
          <RecordIcon className="w-3 h-3 text-coral-500" />
          <span className="text-sm tracking-tight">
            {switchPending
              ? "Starting…"
              : isBusy
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

/** Guests don't control recording — the host does. This pill tells them
 *  whether they're being recorded right now. */
function GuestRecordStatus({
  recState,
  elapsedMs,
  switchOn,
  canRecord,
}: {
  recState: PipelineState;
  elapsedMs: number;
  switchOn: boolean;
  canRecord: boolean;
}) {
  if (recState === "recording") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 pl-3.5 pr-4 py-2.5 bg-coral-600 rounded-full text-white font-bold shadow-lg"
      >
        <span className="relative flex w-2.5 h-2.5" aria-hidden>
          <span className="absolute inset-0 rounded-full bg-white opacity-75 animate-ping" />
          <span className="relative rounded-full bg-white w-2.5 h-2.5" />
        </span>
        <span className="text-sm tabular-nums tracking-tight">
          Recording · {fmt(elapsedMs)}
        </span>
        <span className="hidden sm:inline text-xs font-semibold text-white/80">
          started by the host
        </span>
      </div>
    );
  }
  const text =
    recState === "stopping"
      ? "Finalizing…"
      : recState === "uploading"
        ? "Uploading your recording…"
        : switchOn && !canRecord
          ? "Turn on your mic or camera to record"
          : switchOn
            ? "Starting recording…"
            : recState === "complete"
              ? "Saved · waiting for the host"
              : "Waiting for the host to start recording";
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2.5 bg-white/10 rounded-full text-white/85 text-sm font-semibold tracking-tight ring-1 ring-white/10"
    >
      <RecordIcon className="w-3 h-3 text-coral-500" />
      {text}
    </div>
  );
}
