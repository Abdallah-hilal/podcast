"use client";

import type { PipelineState } from "@/types";

interface Props {
  state: PipelineState;
  onStart: () => void;
  onStop: () => void;
  elapsedMs: number;
  batchesUploaded: number;
  batchesTotal: number;
}

function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function RecordingControls({
  state,
  onStart,
  onStop,
  elapsedMs,
  batchesUploaded,
  batchesTotal,
}: Props) {
  const isRecording = state === "recording";
  const isBusy = state === "stopping" || state === "uploading";
  const isIdle = state === "idle";
  const isDone = state === "complete";

  return (
    <div className="flex items-center gap-4 p-4 bg-gray-800 rounded-lg">
      {isIdle && (
        <button
          onClick={onStart}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
        >
          <span className="w-3 h-3 bg-white rounded-full" />
          Record
        </button>
      )}

      {isRecording && (
        <button
          onClick={onStop}
          className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
        >
          <span className="w-3 h-3 bg-white rounded-sm" />
          Stop
        </button>
      )}

      {isBusy && (
        <span className="px-4 py-2 text-yellow-400 font-medium">
          {state === "stopping" ? "Stopping..." : "Uploading..."}
        </span>
      )}

      {isDone && (
        <span className="px-4 py-2 text-green-400 font-medium">
          Recording complete
        </span>
      )}

      {state === "error" && (
        <span className="px-4 py-2 text-red-400 font-medium">
          Error occurred
        </span>
      )}

      {!isIdle && (
        <>
          <span className="text-white font-mono">{formatTime(elapsedMs)}</span>
          {batchesTotal > 0 && (
            <span className="text-gray-400 text-sm">
              {batchesUploaded}/{batchesTotal} batches uploaded
            </span>
          )}
        </>
      )}
    </div>
  );
}
