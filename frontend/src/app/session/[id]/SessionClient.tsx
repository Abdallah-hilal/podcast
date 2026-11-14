"use client";

import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from "react";
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
import {
  getRecordingStream,
  checkRecordingSupport,
  type RecordingSupport,
} from "@/lib/recording/mediaRecorder";
import type {
  PipelineState,
  PipelineProgress,
  JoinSessionResponse,
} from "@/types";

const SUBSCRIBE_NOOP = () => () => {};
// Cache the probe result for the lifetime of the tab. useSyncExternalStore
// uses === identity to detect changes, so returning a fresh object on every
// call looks like a continuous state change and loops the component.
// RecordingSupport is a function of the browser build; it never changes
// once the page is loaded.
let cachedRecordingSupport: RecordingSupport | null = null;
const getRecordingSupportClient = (): RecordingSupport => {
  if (!cachedRecordingSupport) cachedRecordingSupport = checkRecordingSupport();
  return cachedRecordingSupport;
};
const getRecordingSupportServer = (): null => null;

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
  // Probe MediaRecorder on client mount so the Join button can say "sorry,
  // your browser can't record" BEFORE the user tries. `useSyncExternalStore`
  // keeps SSR rendering with `null` (server snapshot) and the client first
  // paint rendering with the actual result — no setState-in-effect hazard,
  // no hydration mismatch.
  const support = useSyncExternalStore<RecordingSupport | null>(
    SUBSCRIBE_NOOP,
    getRecordingSupportClient,
    getRecordingSupportServer,
  );

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
    batchesFailed: 0,
  });

  useEffect(() => {
    // Live polling only while something is actually moving — dynamic
    // elapsedMs / batch counters. Terminal states (idle, complete, error)
    // don't need a 2 Hz re-render tax on the whole LiveKit tree.
    if (
      pipelineState === "idle" ||
      pipelineState === "complete" ||
      pipelineState === "error"
    )
      return;
    const interval = setInterval(() => {
      setProgress(pipelineRef.current.getProgress());
    }, 500);
    return () => clearInterval(interval);
  }, [pipelineState]);

  // Make sure the final progress snapshot (including any error details)
  // reaches state when the pipeline transitions out of a running state —
  // otherwise the UI shows stale pre-stop numbers.
  useEffect(() => {
    if (
      pipelineState === "complete" ||
      pipelineState === "error" ||
      pipelineState === "idle"
    ) {
      setProgress(pipelineRef.current.getProgress());
    }
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
        // Guest flow: an invite link is the credential. Hand the viewer off
        // to /join/:id, which signs them in as an anonymous Supabase user
        // and bounces back. Host signs in with email+password via /login.
        router.replace(`/join/${sessionId}`);
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
  }, [sessionId, supabase, router]);

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
          // PreJoin captured the file handle (null if the user declined or
          // their browser lacks the File System Access API); the pipeline
          // tees every chunk to it in parallel with OPFS + cloud upload.
          localFileHandle: preChoice?.localFileHandle ?? null,
        });
      } catch (err) {
        console.error("Failed to start recording:", err);
        setError(err instanceof Error ? err.message : "Recording failed");
        if (ownsStream) {
          stream.getTracks().forEach((t) => t.stop());
        }
      }
    },
    [sessionId, authed, getFreshToken, preChoice]
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

  // Local-save filename the UI shows + the handler for "Change save location".
  // Seed from PreJoin's choice, keep in sync with pipeline.swapLocalFile().
  const [localSaveFilename, setLocalSaveFilename] = useState<string | null>(
    preChoice?.localFileHandle?.name ?? null,
  );
  // Kept in sync in case the PreJoin choice changes (shouldn't after mount, but
  // this covers remount scenarios).
  useEffect(() => {
    setLocalSaveFilename(
      pipelineRef.current.localSaveFilename ??
        preChoice?.localFileHandle?.name ??
        null,
    );
  }, [preChoice]);

  const handleChangeLocalSave = useCallback(async () => {
    type FsWin = Window & {
      showSaveFilePicker?: (opts?: {
        suggestedName?: string;
        types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      }) => Promise<FileSystemFileHandle>;
    };
    const fsWin = window as FsWin;
    if (!fsWin.showSaveFilePicker) {
      setError(
        "This browser can't let you pick a local file. Use Chrome or Edge for Save-locally.",
      );
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const mime =
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "video/mp4";
    const ext = mime === "video/webm" ? "webm" : "mp4";
    const safeTitle = (sessionTitle || "recording")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 40) || "recording";
    let handle: FileSystemFileHandle;
    try {
      handle = await fsWin.showSaveFilePicker({
        suggestedName: `${safeTitle}-${stamp}.${ext}`,
        types: [
          mime === "video/webm"
            ? { description: "WebM video", accept: { "video/webm": [".webm"] } }
            : { description: "MP4 video", accept: { "video/mp4": [".mp4"] } },
        ],
      });
    } catch (e) {
      // User-cancelled: no change.
      if ((e as { name?: string })?.name === "AbortError") return;
      console.warn("Change-location picker failed:", e);
      return;
    }
    try {
      await pipelineRef.current.swapLocalFile(handle);
      setLocalSaveFilename(handle.name);
    } catch (e) {
      console.error("swapLocalFile failed:", e);
      setError(
        e instanceof Error
          ? `Couldn't open ${handle.name}: ${e.message}`
          : "Couldn't open the file you picked",
      );
    }
  }, [sessionTitle]);

  // Warn the user if they try to close the tab while the pipeline hasn't
  // settled — OPFS still has the chunks, but closing mid-upload means the
  // final file never finalizes until they revisit (and we don't have a
  // "resume" UI yet). beforeunload only shows the browser's generic prompt;
  // the message string is ignored by modern browsers but setting returnValue
  // is what triggers the dialog.
  useEffect(() => {
    const dangerous =
      pipelineState === "recording" ||
      pipelineState === "stopping" ||
      pipelineState === "uploading";
    if (!dangerous) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pipelineState]);

  if (error) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4 bg-surface border border-border rounded-2xl p-6" style={{ boxShadow: "var(--shadow-photo)" }}>
          <p className="text-coral-700 font-bold text-lg">{error}</p>
          <button
            onClick={() => router.push("/")}
            className="press inline-block px-5 py-2 bg-brand hover:bg-brand-hover text-white rounded-xl font-bold shadow-md"
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
    const unsupported = support && !support.supported;
    return (
      <PreJoin
        title={sessionTitle || "Meeting"}
        roleLabel={localOnly ? "Local recording" : "Ready to join"}
        onJoin={(choice) => {
          setPreChoice(choice);
          setPrejoined(true);
        }}
        disabled={!!unsupported}
        disabledReason={unsupported ? support?.message : undefined}
        supportWarning={
          support && support.quality === "limited" ? support.message ?? null : null
        }
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
            batchesFailed={progress.batchesFailed}
            lastError={progress.lastError}
          />
        </div>
        <LocalControlBar
          recState={pipelineState}
          elapsedMs={progress.elapsedMs}
          preChoice={preChoice}
          onStartRecording={handleStartRecording}
          onStop={handleStopRecording}
          onLeave={handleLeave}
          onChangeLocalSave={handleChangeLocalSave}
          localSaveFilename={localSaveFilename}
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
            batchesFailed={progress.batchesFailed}
            lastError={progress.lastError}
          />
        </div>
        <RoomRecordingControls
          recState={pipelineState}
          elapsedMs={progress.elapsedMs}
          onStartRecording={handleStartRecording}
          onStop={handleStopRecording}
          onLeave={handleLeave}
          onChangeLocalSave={handleChangeLocalSave}
          localSaveFilename={localSaveFilename}
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
  onChangeLocalSave,
  localSaveFilename,
}: {
  recState: PipelineState;
  elapsedMs: number;
  onStartRecording: (stream: MediaStream, ownsStream: boolean) => Promise<void>;
  onStop: () => void;
  onLeave: () => void;
  onChangeLocalSave?: () => void;
  localSaveFilename?: string | null;
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
      onChangeLocalSave={onChangeLocalSave}
      localSaveFilename={localSaveFilename}
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
  onChangeLocalSave,
  localSaveFilename,
}: {
  recState: PipelineState;
  elapsedMs: number;
  preChoice: PreJoinChoice | null;
  onStartRecording: (stream: MediaStream, ownsStream: boolean) => Promise<void>;
  onStop: () => void;
  onLeave: () => void;
  onChangeLocalSave?: () => void;
  localSaveFilename?: string | null;
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
    <div className="flex items-center justify-center gap-3 py-5 px-4 material-dark border-t border-white/5">
      {isRecording ? (
        <button
          onClick={onStop}
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-coral-600 hover:bg-coral-700 rounded-full text-white font-bold shadow-lg"
        >
          <StopIcon className="w-3 h-3" />
          <span className="text-sm tabular-nums tracking-tight">Stop · {timeStr}</span>
        </button>
      ) : (
        <button
          onClick={handleRecord}
          disabled={isBusy}
          className="press flex items-center gap-2 pl-4 pr-5 py-2.5 bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:hover:bg-white/10 rounded-full text-white font-bold ring-1 ring-white/10"
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
        <button
          onClick={onChangeLocalSave}
          title={
            localSaveFilename
              ? `Saving locally to "${localSaveFilename}". Click to pick a different file.`
              : "Pick a file to save a local copy."
          }
          className="press flex items-center gap-2 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold ring-1 ring-white/10 max-w-[200px]"
        >
          <svg aria-hidden className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span className="truncate tracking-tight">
            {localSaveFilename
              ? localSaveFilename.length > 24
                ? localSaveFilename.slice(0, 10) + "…" + localSaveFilename.slice(-10)
                : localSaveFilename
              : "Save locally"}
          </span>
        </button>
      )}
      <button
        onClick={onLeave}
        aria-label="Leave"
        className="press w-11 h-11 rounded-full bg-coral-700 hover:bg-coral-700/80 text-white flex items-center justify-center shadow-lg"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}
