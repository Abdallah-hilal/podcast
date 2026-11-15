import type { PipelineState } from "@/types";

/**
 * The room-wide recording switch the host controls. The backend writes it
 * into LiveKit room metadata (POST /sessions/{id}/recording); every client,
 * host included, reads it and drives its own RecordingPipeline from it.
 * `run` changes on every start so a client can tell a new run from the
 * one it is already recording.
 */
export type RoomSwitch = { recording: boolean; run: string | null };

const OFF: RoomSwitch = { recording: false, run: null };

export function parseRoomSwitch(metadata: string | undefined | null): RoomSwitch {
  if (!metadata) return OFF;
  try {
    const m = JSON.parse(metadata) as { recording?: unknown; run?: unknown };
    if (m && m.recording === true && typeof m.run === "string" && m.run) {
      return { recording: true, run: m.run };
    }
  } catch {
    /* not ours / corrupt → treat as off */
  }
  return OFF;
}

export type SwitchAction = "start" | "stop" | "none";

/**
 * What this client's recorder should do right now. `lastStartedRun` is the
 * run this tab last started (set before start() is awaited, so a slow start
 * can't be doubled); it's in-memory, so a refreshed tab rejoining a live
 * run records a fresh take — which is what we want.
 */
export function decideSwitchAction(i: {
  sw: RoomSwitch;
  state: PipelineState;
  lastStartedRun: string | null;
  ready: boolean;
}): SwitchAction {
  const { sw, state, lastStartedRun, ready } = i;
  if (!sw.recording) return state === "recording" ? "stop" : "none";
  if (state === "recording") return lastStartedRun === sw.run ? "none" : "stop";
  // Let a previous take finish uploading before starting the next one.
  if (state === "stopping" || state === "uploading") return "none";
  if (lastStartedRun === sw.run) return "none";
  return ready ? "start" : "none";
}

export type RecStatus = "idle" | "recording" | "uploading" | "done" | "error";

/** Pipeline state → the `rec` participant attribute shown on every tile. */
export function recStatusAttr(state: PipelineState): RecStatus {
  switch (state) {
    case "recording":
      return "recording";
    case "stopping":
    case "uploading":
      return "uploading";
    case "complete":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Share of this take that has reached the server, 0–100. */
export function uploadPercent(bytesUploaded: number, bytesRecorded: number): number {
  if (bytesRecorded <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((bytesUploaded / bytesRecorded) * 100)));
}

export type PublishedStatus = { rec: RecStatus; up: number };

/** Throttle for setAttributes: publish on a status change, a ≥5-point
 *  upload move, or reaching 100 — not on every 500 ms progress tick. */
export function shouldPublishStatus(prev: PublishedStatus | null, next: PublishedStatus): boolean {
  if (!prev || prev.rec !== next.rec) return true;
  if (next.up === prev.up) return false;
  return Math.abs(next.up - prev.up) >= 5 || next.up === 100;
}
