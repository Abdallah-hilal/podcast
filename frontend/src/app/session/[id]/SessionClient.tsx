"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { PreJoin, type PreJoinChoice } from "@/components/meeting/PreJoin";
import { VideoGrid } from "@/components/meeting/VideoGrid";
import { ControlBar } from "@/components/meeting/ControlBar";
import { RecBadge, UploadBadge } from "@/components/meeting/Overlays";
import { InviteButton } from "@/components/meeting/InviteButton";
import {
  RecordIcon,
  StopIcon,
  PhoneOffIcon,
} from "@/components/meeting/icons";
import { RecordingPipeline } from "@/lib/recording/pipeline";
import type {
  PipelineState,
  PipelineProgress,
  JoinSessionResponse,
} from "@/types";

export default function SessionClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const supabase = createClient();

  const [joinInfo, setJoinInfo] = useState<JoinSessionResponse | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [error, setError] = useState("");
  const [prejoined, setPrejoined] = useState(false);
  const [preChoice, setPreChoice] = useState<PreJoinChoice | null>(null);

  const pipelineRef = useRef<RecordingPipeline>(new RecordingPipeline());
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [progress, setProgress] = useState<PipelineProgress>({
    state: "idle",
    elapsedMs: 0,
    bytesRecorded: 0,
    bytesUploaded: 0,
    chunksRecorded: 0,
    batchesSealed: 0,
    batchesUploaded: 0,
  });

  useEffect(() => {
    if (pipelineState === "idle" || pipelineState === "complete") return;
    const interval = setInterval(() => {
      setProgress(pipelineRef.current.getProgress());
    }, 500);
    return () => clearInterval(interval);
  }, [pipelineState]);

  useEffect(() => {
    pipelineRef.current.setOnStateChange((state) => {
      setPipelineState(state);
      setProgress(pipelineRef.current.getProgress());
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }
      setToken(session.access_token);

      try {
        const sessionData = await api.getSession(session.access_token, sessionId);
        if (!mounted) return;
        setSessionTitle(sessionData.title);

        const joinData = await api.joinSession(session.access_token, sessionId);
        if (!mounted) return;

        if (!joinData.livekit_url || !joinData.livekit_token) {
          setLocalOnly(true);
          return;
        }

        setJoinInfo(joinData);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Join failed");
      }
    }

    init();
    return () => {
      mounted = false;
    };
  }, [sessionId, router, supabase]);

  const handleStartRecording = useCallback(async () => {
    if (!token) return;
    try {
      await pipelineRef.current.start(sessionId, token);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError(err instanceof Error ? err.message : "Recording failed");
    }
  }, [sessionId, token]);

  const handleStopRecording = useCallback(async () => {
    try {
      await pipelineRef.current.stop();
    } catch (err) {
      console.error("Failed to stop recording:", err);
    }
  }, []);

  const handleLeave = useCallback(async () => {
    if (pipelineRef.current.state === "recording") {
      await pipelineRef.current.stop();
    }
    router.push("/");
  }, [router]);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <p className="text-red-400 text-lg">{error}</p>
          <button
            onClick={() => router.push("/")}
            className="text-blue-400 hover:underline"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (!localOnly && !joinInfo) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 text-sm animate-pulse">Connecting…</div>
      </div>
    );
  }

  if (!prejoined) {
    return (
      <PreJoin
        title={sessionTitle || "Meeting"}
        roleLabel={localOnly ? "Local recording" : "Ready to join"}
        onJoin={(choice) => {
          setPreChoice(choice);
          setPrejoined(true);
        }}
      />
    );
  }

  const header = (
    <header className="flex items-center justify-between px-5 py-4 bg-gray-900/60 backdrop-blur-md border-b border-white/5">
      <div className="min-w-0 flex-1 mr-4">
        <h1 className="text-base md:text-lg font-semibold text-white truncate">
          {sessionTitle}
        </h1>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <InviteButton sessionId={sessionId} />
      </div>
    </header>
  );

  if (localOnly) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {header}
        <div className="flex-1 relative flex items-center justify-center p-6">
          <div className="max-w-md text-center text-gray-500">
            Live video call is not configured for this server. You can still
            record locally — your webm will be uploaded to Supabase.
          </div>
          {pipelineState === "recording" && (
            <RecBadge elapsedMs={progress.elapsedMs} />
          )}
          <UploadBadge
            state={pipelineState}
            batchesUploaded={progress.batchesUploaded}
            batchesTotal={progress.batchesSealed}
            bytesUploaded={progress.bytesUploaded}
          />
        </div>
        <LocalControlBar
          recState={pipelineState}
          elapsedMs={progress.elapsedMs}
          onRecord={handleStartRecording}
          onStop={handleStopRecording}
          onLeave={handleLeave}
        />
      </div>
    );
  }

  const videoOpt: boolean | { deviceId: { exact: string } } = preChoice?.camOn
    ? preChoice.cameraId
      ? { deviceId: { exact: preChoice.cameraId } }
      : true
    : false;

  const audioOpt: boolean | { deviceId: { exact: string } } = preChoice?.micOn
    ? preChoice.micId
      ? { deviceId: { exact: preChoice.micId } }
      : true
    : false;

  return (
    <LiveKitRoom
      serverUrl={joinInfo!.livekit_url}
      token={joinInfo!.livekit_token}
      connect
      video={videoOpt}
      audio={audioOpt}
      onError={(e) => {
        // Transient disconnects and device-permission errors shouldn't blow
        // the whole UI away. Only fatal connection errors do.
        console.warn("LiveKit error:", e);
        if (/connect|signal|token/i.test(e.message)) {
          setError(e.message);
        }
      }}
    >
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {header}
        <div className="flex-1 relative flex items-center justify-center p-4 md:p-6">
          <VideoGrid />
          {pipelineState === "recording" && (
            <RecBadge elapsedMs={progress.elapsedMs} />
          )}
          <UploadBadge
            state={pipelineState}
            batchesUploaded={progress.batchesUploaded}
            batchesTotal={progress.batchesSealed}
            bytesUploaded={progress.bytesUploaded}
          />
        </div>
        <ControlBar
          recState={pipelineState}
          elapsedMs={progress.elapsedMs}
          onRecord={handleStartRecording}
          onStop={handleStopRecording}
          onLeave={handleLeave}
        />
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

// Minimal control bar for local-only mode (no LiveKit context, so no mic/cam toggles).
function LocalControlBar({
  recState,
  elapsedMs,
  onRecord,
  onStop,
  onLeave,
}: {
  recState: PipelineState;
  elapsedMs: number;
  onRecord: () => void;
  onStop: () => void;
  onLeave: () => void;
}) {
  const isRecording = recState === "recording";
  const isBusy = recState === "stopping" || recState === "uploading";

  const s = Math.floor(elapsedMs / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const timeStr = `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;

  return (
    <div className="flex items-center justify-center gap-3 py-5 px-4 bg-gray-900/80 backdrop-blur-md border-t border-white/5">
      {isRecording ? (
        <button
          onClick={onStop}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-red-600 hover:bg-red-700 rounded-full text-white font-medium shadow-lg shadow-red-600/20"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums">Stop · {timeStr}</span>
        </button>
      ) : (
        <button
          onClick={onRecord}
          disabled={isBusy}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-white/15 disabled:opacity-50 rounded-full text-white font-medium"
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
      <button
        onClick={onLeave}
        aria-label="Leave"
        className="w-11 h-11 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center shadow-lg shadow-red-600/20"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}
