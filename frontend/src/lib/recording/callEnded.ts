import type { PipelineState } from "@/types";

/**
 * After Leave: does this tab still have recording work to finish? If so it
 * stays open on the "Call ended" screen instead of navigating away, so the
 * person can see the upload and the close-tab guard stays up.
 */
export function workLeftAfterLeave(state: PipelineState, recoveryActive: boolean): boolean {
  return recoveryActive || (state !== "idle" && state !== "complete");
}

export type CallEndedPhase = "uploading" | "saved" | "paused";

export function callEndedPhase(state: PipelineState, recoveryActive: boolean): CallEndedPhase {
  if (state === "error") return "paused";
  if (state === "idle" || state === "complete") return recoveryActive ? "uploading" : "saved";
  return "uploading";
}

/**
 * "About 2 h 10 min left" from the upload speed seen since Leave. Null
 * until there's enough to go on (a short window over-reads a burst).
 */
export function timeLeftText(remainingBytes: number, bytesPerSecond: number | null): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0 || remainingBytes <= 0) return null;
  const mins = Math.ceil(remainingBytes / bytesPerSecond / 60);
  if (mins <= 1) return "Less than a minute left";
  if (mins < 60) return `About ${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `About ${h} h left` : `About ${h} h ${m} min left`;
}
