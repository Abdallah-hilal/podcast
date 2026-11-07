"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, CamIcon, CamOffIcon } from "./icons";

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

  // Initial permission request + device enumeration
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

  // Live camera preview — restart when device or on/off changes
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
    // If devices are unavailable (permission denied, no hardware), join as
    // listener-only — LiveKit will blow up if we ask it to open a device it can't.
    const blocked = !!err;
    onJoin({
      cameraId: cameraId || undefined,
      micId: micId || undefined,
      camOn: !blocked && camOn,
      micOn: !blocked && micOn,
    });
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-1">
          <p className="text-xs uppercase tracking-widest text-gray-500">{roleLabel}</p>
          <h1 className="text-2xl md:text-3xl font-bold text-white truncate">{title}</h1>
        </div>

        <div className="relative aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10">
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
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              {!ready ? (
                <span className="text-sm">Checking devices…</span>
              ) : camOn ? (
                <span className="text-sm">No camera</span>
              ) : (
                <div className="w-20 h-20 rounded-full bg-gray-800 flex items-center justify-center">
                  <CamOffIcon className="w-8 h-8 text-gray-500" />
                </div>
              )}
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 flex items-center justify-center gap-3">
            <button
              onClick={() => setMicOn((x) => !x)}
              aria-label={micOn ? "Turn off microphone" : "Turn on microphone"}
              className={[
                "w-11 h-11 rounded-full flex items-center justify-center transition-colors shadow-lg",
                micOn ? "bg-white/15 hover:bg-white/25 text-white" : "bg-red-600 hover:bg-red-700 text-white",
              ].join(" ")}
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
            </button>
            <button
              onClick={() => setCamOn((x) => !x)}
              aria-label={camOn ? "Turn off camera" : "Turn on camera"}
              className={[
                "w-11 h-11 rounded-full flex items-center justify-center transition-colors shadow-lg",
                camOn ? "bg-white/15 hover:bg-white/25 text-white" : "bg-red-600 hover:bg-red-700 text-white",
              ].join(" ")}
            >
              {camOn ? <CamIcon /> : <CamOffIcon />}
            </button>
          </div>
        </div>

        {err && (
          <p className="text-red-400 text-sm text-center">{err}</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs uppercase tracking-wider text-gray-500">Camera</span>
            <select
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              disabled={!devices.cameras.length}
              className="w-full px-3 py-2.5 bg-gray-900/80 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
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
            <span className="block text-xs uppercase tracking-wider text-gray-500">Microphone</span>
            <select
              value={micId}
              onChange={(e) => setMicId(e.target.value)}
              disabled={!devices.mics.length}
              className="w-full px-3 py-2.5 bg-gray-900/80 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
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

        <button
          onClick={handleJoin}
          disabled={joining || disabled || (!ready && !err)}
          className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-semibold text-white text-base transition-colors shadow-lg shadow-blue-600/20"
        >
          {joining ? "Joining…" : disabled ? (disabledReason ?? "Unavailable") : "Join meeting"}
        </button>
      </div>
    </div>
  );
}
