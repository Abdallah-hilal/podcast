"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, CamIcon, CamOffIcon } from "./icons";
import { AudioLevelMeter } from "./AudioLevelMeter";
import { Logo } from "@/components/common/Logo";

export interface PreJoinChoice {
  cameraId: string | undefined;
  micId: string | undefined;
  camOn: boolean;
  micOn: boolean;
}

interface Props {
  title: string;
  roleLabel: string;
  onJoin: (choice: PreJoinChoice) => void;
  joining?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

type Devices = { cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] };

export function PreJoin({ title, roleLabel, onJoin, joining, disabled, disabledReason }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] });
  const [cameraId, setCameraId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [err, setErr] = useState<string>("");
  const [ready, setReady] = useState(false);

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

  function handleJoin() {
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
    });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 sm:p-6 relative overflow-hidden"
      style={{ background: "var(--gradient-teal)" }}
    >
      {/* Sunset glow top-right — brand warmth over the teal canvas */}
      <div
        aria-hidden
        className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-25 blur-3xl"
        style={{ background: "var(--gradient-sunset)" }}
      />

      <div className="relative w-full max-w-2xl space-y-5">
        <div className="flex justify-center">
          <Logo size="md" linkTo="" />
        </div>

        <div className="text-center space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-teal-300">
            {roleLabel}
          </p>
          <h1 className="text-2xl md:text-3xl font-black text-white truncate">
            {title}
          </h1>
        </div>

        <div
          className="relative aspect-video bg-black rounded-2xl overflow-hidden ring-1 ring-white/10"
          style={{ boxShadow: "var(--shadow-photo)" }}
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
            <div className="w-full h-full flex items-center justify-center text-teal-300/70">
              {!ready ? (
                <span className="text-sm animate-pulse">Checking devices…</span>
              ) : camOn ? (
                <span className="text-sm">No camera</span>
              ) : (
                <div
                  className="w-20 h-20 rounded-full flex items-center justify-center shadow-xl"
                  style={{ background: "var(--gradient-sunset)" }}
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
              className={[
                "w-11 h-11 rounded-full flex items-center justify-center transition-all shadow-lg",
                micOn
                  ? "bg-white/15 hover:bg-white/25 text-white"
                  : "bg-coral-600 hover:bg-coral-700 text-white",
              ].join(" ")}
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
            </button>
            <button
              onClick={() => setCamOn((x) => !x)}
              aria-label={camOn ? "Turn off camera" : "Turn on camera"}
              className={[
                "w-11 h-11 rounded-full flex items-center justify-center transition-all shadow-lg",
                camOn
                  ? "bg-white/15 hover:bg-white/25 text-white"
                  : "bg-coral-600 hover:bg-coral-700 text-white",
              ].join(" ")}
            >
              {camOn ? <CamIcon /> : <CamOffIcon />}
            </button>
          </div>
        </div>

        {err && (
          <p className="text-center text-sm text-orange-400 bg-black/40 border border-orange-500/30 rounded-lg px-3 py-2 backdrop-blur-sm">
            {err}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="block text-[11px] font-bold uppercase tracking-widest text-teal-300">
              Camera
            </span>
            <select
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              disabled={!devices.cameras.length}
              className="w-full px-3 py-2.5 bg-black/30 border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-coral-600/60 disabled:opacity-50 backdrop-blur-sm"
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
            <span className="block text-[11px] font-bold uppercase tracking-widest text-teal-300">
              Microphone
            </span>
            <select
              value={micId}
              onChange={(e) => setMicId(e.target.value)}
              disabled={!devices.mics.length}
              className="w-full px-3 py-2.5 bg-black/30 border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-coral-600/60 disabled:opacity-50 backdrop-blur-sm"
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

        {!err && (
          <div className="space-y-1.5">
            <span className="block text-[11px] font-bold uppercase tracking-widest text-teal-300">
              Mic level
            </span>
            <AudioLevelMeter micId={micId || undefined} enabled={micOn && !!micId} />
            <p className="text-[11px] text-teal-300/70">
              Say something — the bar should move. If it stays flat, pick a
              different mic above.
            </p>
          </div>
        )}

        <button
          onClick={handleJoin}
          disabled={joining || disabled || (!ready && !err)}
          className="w-full py-3.5 bg-coral-600 hover:bg-coral-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-black text-white text-base transition-all shadow-lg hover:shadow-xl"
        >
          {joining ? "Joining…" : disabled ? (disabledReason ?? "Unavailable") : "Join meeting →"}
        </button>
      </div>
    </div>
  );
}
