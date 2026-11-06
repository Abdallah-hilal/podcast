"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { DailyProvider } from "@daily-co/daily-react";
import DailyIframe from "@daily-co/daily-js";
import { createClient } from "@/lib/supabase/client";
import * as api from "@/lib/api";
import { VideoGrid } from "@/components/daily/VideoGrid";
import { RecordingControls } from "@/components/recording/RecordingControls";
import { RecordingPipeline } from "@/lib/recording/pipeline";
import type { PipelineState, PipelineProgress } from "@/types";

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const supabase = createClient();

  const [callObject, setCallObject] = useState<ReturnType<
    typeof DailyIframe.createCallObject
  > | null>(null);
  const [joined, setJoined] = useState(false);
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

  // Progress polling
  useEffect(() => {
    if (pipelineState === "idle" || pipelineState === "complete") return;
    const interval = setInterval(() => {
      setProgress(pipelineRef.current.getProgress());
    }, 500);
    return () => clearInterval(interval);
  }, [pipelineState]);

  // Pipeline state change callback
  useEffect(() => {
    pipelineRef.current.setOnStateChange((state) => {
      setPipelineState(state);
      setProgress(pipelineRef.current.getProgress());
    });
  }, []);

  // Join the Daily room on mount
  useEffect(() => {
    let mounted = true;

    async function join() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      setToken(session.access_token);

      try {
        const sessionData = await api.getSession(
          session.access_token,
          sessionId
        );
        setSessionTitle(sessionData.title);

        const joinData = await api.joinSession(
          session.access_token,
          sessionId
        );

        if (!mounted) return;

        const daily = DailyIframe.createCallObject({
          audioSource: true,
          videoSource: true,
        });

        daily.on("joined-meeting", () => setJoined(true));
        daily.on("left-meeting", () => {
          setJoined(false);
          if (pipelineRef.current.state === "recording") {
            pipelineRef.current.stop();
          }
        });
        daily.on("error", (ev) => {
          setError(ev?.error?.msg || "Daily error");
        });

        await daily.join({
          url: joinData.daily_room_url,
          token: joinData.daily_token,
        });

        if (mounted) setCallObject(daily);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Join failed");
      }
    }

    join();
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
    callObject?.leave();
    router.push("/");
  }, [callObject, router]);

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

  return (
    <DailyProvider callObject={callObject}>
      <div className="min-h-screen bg-gray-950 text-white flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h1 className="text-xl font-semibold">
            {sessionTitle || "Loading..."}
          </h1>
          <button
            onClick={handleLeave}
            className="px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg text-sm transition-colors"
          >
            Leave
          </button>
        </div>

        {/* Video Grid */}
        <div className="flex-1 flex items-center justify-center p-6">
          {joined ? (
            <VideoGrid />
          ) : (
            <p className="text-gray-500">Connecting to room...</p>
          )}
        </div>

        {/* Recording Controls */}
        {joined && (
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
        )}
      </div>
    </DailyProvider>
  );
}
