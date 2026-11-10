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
import { ParticipantsBadge } from "@/components/meeting/ParticipantsBadge";
import {
  RecordIcon,
  StopIcon,
  PhoneOffIcon,
} from "@/components/meeting/icons";
import { useRecordingStream } from "@/components/meeting/useRecordingStream";
import { RecordingPipeline } from "@/lib/recording/pipeline";
import { getRecordingStream } from "@/lib/recording/mediaRecorder";
import { loginUrlWithNext } from "@/lib/auth-redirect";
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
  const [authed, setAuthed] = useState(false);
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
        router.push(loginUrlWithNext());
        return;
      }
      setAuthed(true);

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

  const getFreshToken = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("Session expired, please sign in again");
    return session.access_token;
  }, [supabase]);

  const handleStartRecording = useCallback(
    async (stream: MediaStream, ownsStream: boolean) => {
      if (!authed) return;
      try {
        await pipelineRef.current.start(sessionId, getFreshToken, stream, {
          ownsStream,
        });
      } catch (err) {
        console.error("Failed to start recording:", err);
        setError(err instanceof Error ? err.message : "Recording failed");
        if (ownsStream) {
          stream.getTracks().forEach((t) => t.stop());
        }
      }
    },
    [sessionId, authed, getFreshToken]
  );

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
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4 bg-surface border border-border rounded-2xl p-6" style={{ boxShadow: "var(--shadow-photo)" }}>
          <p className="text-coral-700 font-bold text-lg">{error}</p>
          <button
            onClick={() => router.push("/")}
            className="inline-block px-5 py-2 bg-brand hover:bg-brand-hover text-white rounded-xl font-bold transition-colors shadow-md"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (!localOnly && !joinInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--gradient-teal)" }}>
        <div className="text-teal-100 text-sm animate-pulse">Connecting…</div>
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

  // `withBadge` is for the in-room header (inside LiveKitRoom); the local-only
  // header omits it since there's no room context to count participants.
  const renderHeader = (withBadge: boolean) => (
    <header className="flex items-center justify-between px-4 sm:px-5 py-4 bg-black/30 backdrop-blur-xl border-b border-white/10">
      <div className="min-w-0 flex-1 mr-4 flex items-center gap-3">
        <div
          aria-hidden
          className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-full text-[10px] font-black text-white shadow-md"
          style={{ background: "var(--gradient-sunset)" }}
        >
          PS
        </div>
        <h1 className="text-base md:text-lg font-bold text-white truncate">
          {sessionTitle}
        </h1>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {withBadge && <ParticipantsBadge />}
        <InviteButton sessionId={sessionId} />
      </div>
    </header>
  );

  const roomBgStyle = { background: "var(--gradient-teal)" };

  if (localOnly) {
    return (
      <div className="min-h-screen text-white flex flex-col" style={roomBgStyle}>
        {renderHeader(false)}
        <div className="flex-1 relative flex items-center justify-center p-6">
          <div className="max-w-md text-center text-teal-100/80">
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
          preChoice={preChoice}
          onStartRecording={handleStartRecording}
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
      <div className="min-h-screen text-white flex flex-col" style={roomBgStyle}>
        {renderHeader(true)}
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
        <RoomRecordingControls
          recState={pipelineState}
          elapsedMs={progress.elapsedMs}
          onStartRecording={handleStartRecording}
          onStop={handleStopRecording}
          onLeave={handleLeave}
        />
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

/**
 * Wrapper that lives INSIDE LiveKitRoom so it can read the local participant's
 * tracks via `useRecordingStream()` and feed them into the recording pipeline.
 * This is what makes the recording honor the user's PreJoin device choice and
 * share the same mic/camera the video call is using (no second getUserMedia).
 */
function RoomRecordingControls({
  recState,
  elapsedMs,
  onStartRecording,
  onStop,
  onLeave,
}: {
  recState: PipelineState;
  elapsedMs: number;
  onStartRecording: (stream: MediaStream, ownsStream: boolean) => Promise<void>;
  onStop: () => void;
  onLeave: () => void;
}) {
  const { buildStream, isReady } = useRecordingStream();
  const handleRecord = useCallback(() => {
    const stream = buildStream();
    void onStartRecording(stream, false);
  }, [buildStream, onStartRecording]);

  return (
    <ControlBar
      recState={recState}
      elapsedMs={elapsedMs}
      onRecord={handleRecord}
      onStop={onStop}
      onLeave={onLeave}
      canRecord={isReady}
      lockDeviceToggles={recState === "recording"}
    />
  );
}

// Minimal control bar for local-only mode (no LiveKit context, so no mic/cam
// toggles). This bar OWNS its stream: it opens one via getRecordingStream()
// using the device the user picked in PreJoin, hands it to the pipeline, and
// lets the pipeline stop its tracks on recording end.
function LocalControlBar({
  recState,
  elapsedMs,
  preChoice,
  onStartRecording,
  onStop,
  onLeave,
}: {
  recState: PipelineState;
  elapsedMs: number;
  preChoice: PreJoinChoice | null;
  onStartRecording: (stream: MediaStream, ownsStream: boolean) => Promise<void>;
  onStop: () => void;
  onLeave: () => void;
}) {
  const isRecording = recState === "recording";
  const isBusy = recState === "stopping" || recState === "uploading";

  const s = Math.floor(elapsedMs / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const timeStr = `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;

  const handleRecord = async () => {
    try {
      const stream = await getRecordingStream({
        cameraId: preChoice?.cameraId,
        micId: preChoice?.micId,
        camOn: preChoice?.camOn ?? true,
        micOn: preChoice?.micOn ?? true,
      });
      await onStartRecording(stream, true);
    } catch (err) {
      console.error("Local recording start failed:", err);
    }
  };

  return (
    <div className="flex items-center justify-center gap-3 py-5 px-4 bg-black/40 backdrop-blur-xl border-t border-white/10">
      {isRecording ? (
        <button
          onClick={onStop}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-coral-600 hover:bg-coral-700 rounded-full text-white font-bold shadow-lg"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums">Stop · {timeStr}</span>
        </button>
      ) : (
        <button
          onClick={handleRecord}
          disabled={isBusy}
          className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded-full text-white font-bold ring-1 ring-white/10"
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
      <button
        onClick={onLeave}
        aria-label="Leave"
        className="w-11 h-11 rounded-full bg-coral-700 hover:bg-coral-700/80 text-white flex items-center justify-center shadow-lg"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}
