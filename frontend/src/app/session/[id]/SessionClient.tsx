"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import "@livekit/components-styles";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { VideoGrid } from "@/components/livekit/VideoGrid";
import { RecordingControls } from "@/components/recording/RecordingControls";
import { RecordingPipeline } from "@/lib/recording/pipeline";
import type { PipelineState, PipelineProgress, JoinSessionResponse } from "@/types";

export default function SessionClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const supabase = createClient();

  const [joinInfo, setJoinInfo] = useState<JoinSessionResponse | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [error, setError] = useState("");

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

  // Progress polling while the pipeline is doing something
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

  // Fetch session + join info on mount
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

        // Local-only mode: no LiveKit configured on the backend. Skip the live
        // video call and go straight to recording.
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
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-4">
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

  const header = (
    <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
      <h1 className="text-xl font-semibold">{sessionTitle || "Loading..."}</h1>
      <button
        onClick={handleLeave}
        className="px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg text-sm transition-colors"
      >
        Leave
      </button>
    </div>
  );

  const controls = (
    <div className="p-4 border-t border-gray-800">
      <RecordingControls
        state={pipelineState}
        onStart={handleStartRecording}
        onStop={handleStopRecording}
        elapsedMs={progress.elapsedMs}
        batchesUploaded={progress.batchesUploaded}
        batchesTotal={progress.batchesSealed}
      />
    </div>
  );

  // Local-only mode (no LiveKit): just show the recording controls.
  if (localOnly) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-gray-500">
            Local recording mode — no live video call. Use Start Recording below.
          </p>
        </div>
        {controls}
      </div>
    );
  }

  // Waiting for /join response.
  if (!joinInfo) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-gray-500">Connecting to room...</p>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={joinInfo.livekit_url}
      token={joinInfo.livekit_token}
      connect
      video
      audio
      data-lk-theme="default"
      onError={(e) => setError(e.message)}
    >
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <VideoGrid />
        </div>
        {controls}
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
