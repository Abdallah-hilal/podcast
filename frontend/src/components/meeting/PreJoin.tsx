"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, CamIcon, CamOffIcon } from "./icons";
import { AudioLevelMeter } from "./AudioLevelMeter";
import { Logo } from "@/components/common/Logo";

export type QualityChoice = "auto" | "720p" | "1080p" | "1440p" | "4k";

export interface PreJoinChoice {
  cameraId: string | undefined;
  micId: string | undefined;
  camOn: boolean;
  micOn: boolean;
  /** Capture resolution target. "auto" = 1080p (see SessionClient). */
  quality: QualityChoice;
  /**
   * If set, the pipeline tees every MediaRecorder chunk to this file in
   * parallel with OPFS + cloud upload — a hedge against a failed cloud
   * upload and a way to hand the user a file they chose the location of.
   * Only possible in browsers that implement the File System Access API
   * (Chrome / Edge today; not Safari / Firefox).
   */
  localFileHandle: FileSystemFileHandle | null;
}

// `window.showSaveFilePicker` is in lib.dom.d.ts but not every TS config
// picks it up. Narrow it ourselves so the call sites stay typed.
type SaveFilePickerOptions = {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
};
type FileSystemAccessWindow = Window & {
  showSaveFilePicker?: (
    opts?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>;
};

function canSaveLocally(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as FileSystemAccessWindow).showSaveFilePicker === "function"
  );
}

function suggestedLocalFilename(title: string, mimeType: string): string {
  const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const safeTitle = title
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 40) || "recording";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${safeTitle}-${stamp}.${ext}`;
}

interface Props {
  title: string;
  roleLabel: string;
  onJoin: (choice: PreJoinChoice) => void;
  joining?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Non-blocking warning ("Safari recording is limited"), rendered above
   * the preview. Pass only when the warning is still actionable here — once
   * the user is in the room a persistent banner is noise. */
  supportWarning?: string | null;
}

type Devices = { cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] };

export function PreJoin({ title, roleLabel, onJoin, joining, disabled, disabledReason, supportWarning }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] });
  const [cameraId, setCameraId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [err, setErr] = useState<string>("");
  const [ready, setReady] = useState(false);
  // Default on when the browser supports it — the user has to opt out, not
  // opt in. An extra local copy is cheap insurance against cloud failures.
  const saveLocalSupported = canSaveLocally();
  // The ahead-of-time "pick a file" save was retired: people didn't know
  // where their recording went. Everyone now gets an automatic download to
  // their Downloads folder the moment recording stops (see SessionClient).
  const saveLocal = false;
  const [pickerPending, setPickerPending] = useState(false);
  const [quality, setQuality] = useState<QualityChoice>("auto");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const warmup = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        warmup.getTracks().forEach((t) => t.stop());
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!mounted) return;
        const cameras = all.filter((d) => d.kind === "videoinput");
        const mics = all.filter((d) => d.kind === "audioinput");
        setDevices({ cameras, mics });
        setCameraId(cameras[0]?.deviceId ?? "");
        setMicId(mics[0]?.deviceId ?? "");
        setReady(true);
      } catch (e) {
        if (!mounted) return;
        setErr(e instanceof Error ? e.message : "Microphone / camera access denied");
        setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stopCurrent = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };

    async function start() {
      stopCurrent();
      if (!camOn || !cameraId) {
        if (videoRef.current) videoRef.current.srcObject = null;
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cameraId } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Camera unavailable");
      }
    }
    start();
    return () => {
      cancelled = true;
      stopCurrent();
    };
  }, [cameraId, camOn]);

  async function handleJoin() {
    let localFileHandle: FileSystemFileHandle | null = null;

    // Prompt for the local-save location BEFORE tearing down the warmup
    // stream so an accidental Cancel on the picker leaves the preview alive.
    if (saveLocal && saveLocalSupported) {
      setPickerPending(true);
      try {
        const fsWin = window as FileSystemAccessWindow;
        if (fsWin.showSaveFilePicker) {
          // MediaRecorder on Safari emits MP4; everywhere else WebM. The
          // extension matches the first container the recorder will land in.
          const mime =
            typeof MediaRecorder !== "undefined" &&
            MediaRecorder.isTypeSupported("video/webm")
              ? "video/webm"
              : "video/mp4";
          localFileHandle = await fsWin.showSaveFilePicker({
            suggestedName: suggestedLocalFilename(title, mime),
            types: [
              mime === "video/webm"
                ? { description: "WebM video", accept: { "video/webm": [".webm"] } }
                : { description: "MP4 video", accept: { "video/mp4": [".mp4"] } },
            ],
          });
        }
      } catch (e) {
        // User-cancelled picker is an AbortError — not a real failure.
        const name = (e as { name?: string })?.name;
        if (name !== "AbortError") {
          console.warn("Local save picker failed:", e);
        }
        // Either way, continue without a local file. The toggle stays on so
        // the next join still asks, in case this was a slip.
      } finally {
        setPickerPending(false);
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const blocked = !!err;
    onJoin({
      cameraId: cameraId || undefined,
      micId: micId || undefined,
      camOn: !blocked && camOn,
      micOn: !blocked && micOn,
      quality,
      localFileHandle,
    });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 sm:p-6 relative overflow-hidden bg-cream"
    >

      <div className="relative w-full max-w-2xl space-y-5">
        <div className="flex justify-center">
          <Logo size="md" linkTo="" />
        </div>

        <div className="text-center space-y-1 appear">
          <p className="text-sm font-medium text-ink-muted">
            {roleLabel}
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-ink truncate tracking-tight">
            {title}
          </h1>
        </div>

        {supportWarning && (
          <div
            role="status"
            className="text-center text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2"
          >
            {supportWarning}
          </div>
        )}

        <div
          className="relative aspect-video bg-studio-tile rounded-[22px] overflow-hidden"
          style={{ boxShadow: "0 10px 30px rgba(24, 24, 27, 0.12)" }}
        >
          {camOn && ready && !err ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
              style={{ transform: "scaleX(-1)" }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/60">
              {!ready ? (
                <span className="text-sm animate-pulse">Checking devices…</span>
              ) : camOn ? (
                <span className="text-sm">No camera</span>
              ) : (
                <div
                  className="w-20 h-20 rounded-full flex items-center justify-center bg-studio-btn-hover"
                >
                  <CamOffIcon className="w-8 h-8 text-white" />
                </div>
              )}
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 flex items-center justify-center gap-3">
            <button
              onClick={() => setMicOn((x) => !x)}
              aria-label={micOn ? "Turn off microphone" : "Turn on microphone"}
              aria-pressed={micOn}
              className={[
                "press w-11 h-11 rounded-full flex items-center justify-center",
                micOn
                  ? "bg-studio-dock/80 hover:bg-studio-dock text-white"
                  : "bg-white text-coral-700 hover:bg-zinc-100",
              ].join(" ")}
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
            </button>
            <button
              onClick={() => setCamOn((x) => !x)}
              aria-label={camOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={camOn}
              className={[
                "press w-11 h-11 rounded-full flex items-center justify-center",
                camOn
                  ? "bg-studio-dock/80 hover:bg-studio-dock text-white"
                  : "bg-white text-coral-700 hover:bg-zinc-100",
              ].join(" ")}
            >
              {camOn ? <CamIcon /> : <CamOffIcon />}
            </button>
          </div>
        </div>

        {err && (
          <p className="text-center text-sm text-coral-700 bg-white border border-coral-600/30 rounded-xl px-3 py-2">
            {err}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs font-semibold text-ink-muted">
              Camera
            </span>
            <select
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              disabled={!devices.cameras.length}
              className="w-full px-3 py-2.5 bg-white border border-border rounded-xl text-ink text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/15 disabled:opacity-50"
            >
              {devices.cameras.length === 0 && <option value="">— No cameras —</option>}
              {devices.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${c.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs font-semibold text-ink-muted">
              Microphone
            </span>
            <select
              value={micId}
              onChange={(e) => setMicId(e.target.value)}
              disabled={!devices.mics.length}
              className="w-full px-3 py-2.5 bg-white border border-border rounded-xl text-ink text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/15 disabled:opacity-50"
            >
              {devices.mics.length === 0 && <option value="">— No mics —</option>}
              {devices.mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Microphone ${m.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-1.5">
          <label className="block">
            <span className="block text-xs font-semibold text-ink-muted mb-1.5">
              Recording quality
            </span>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as QualityChoice)}
              className="w-full px-3 py-2.5 bg-white border border-border rounded-xl text-ink text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/15"
            >
              <option value="auto">Auto — 1080p (recommended)</option>
              <option value="4k">4K · 3840 × 2160 (25 Mbps)</option>
              <option value="1440p">1440p · 2560 × 1440 (15 Mbps)</option>
              <option value="1080p">1080p · 1920 × 1080 (6 Mbps)</option>
              <option value="720p">720p · 1280 × 720 (3.5 Mbps)</option>
            </select>
            <p className="mt-1 text-xs text-ink-muted">
              Auto records 1080p — plenty for a podcast. Higher qualities make much bigger files that take far longer to upload on a home connection.
            </p>
          </label>
        </div>

        {!err && (
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-ink-muted">
              Mic level
            </span>
            <AudioLevelMeter micId={micId || undefined} enabled={micOn && !!micId} />
            <p className="text-xs text-ink-muted">
              Say something — the bar should move. If it stays flat, pick a
              different mic above.
            </p>
          </div>
        )}

        <div className="flex items-start gap-3 p-4 bg-white border border-border rounded-2xl">
          <svg aria-hidden className="mt-0.5 w-5 h-5 shrink-0 text-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-bold text-ink">
              Your recording is saved on this device
            </span>
            <span className="block text-xs text-ink-muted mt-0.5 leading-relaxed">
              {saveLocalSupported
                ? "When the host stops recording, your file downloads automatically to your Downloads folder. It also uploads to the studio — keep this tab open until your tile says Saved."
                : "When the host stops recording you'll get a Save prompt for your file. It also uploads to the studio — keep this page open until your tile says Saved."}
            </span>
          </span>
        </div>

        <button
          onClick={handleJoin}
          disabled={joining || disabled || pickerPending || (!ready && !err)}
          className="press w-full py-3.5 bg-zinc-900 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-zinc-900 rounded-full font-bold text-white text-base tracking-tight"
        >
          {pickerPending
            ? "Pick a file…"
            : joining
            ? "Joining…"
            : disabled
            ? (disabledReason ?? "Unavailable")
            : "Join meeting →"}
        </button>
      </div>
    </div>
  );
}
