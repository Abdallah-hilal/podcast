"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  micId: string | undefined;
  enabled: boolean;
}

/**
 * Opens an audio-only stream on the chosen mic and renders a live RMS level
 * bar. Independent of the camera preview stream so toggling the camera
 * doesn't interrupt the meter.
 */
export function AudioLevelMeter({ micId, enabled }: Props) {
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    function cleanup() {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
      setLevel(0);
    }

    async function start() {
      if (!enabled || !micId) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: micId } },
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const CtxCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new CtxCtor();
        ctxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(data);
          // RMS across the frequency bins, normalized to 0..1.
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
          }
          const rms = Math.sqrt(sum / data.length) / 255;
          setLevel(rms);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        console.warn("AudioLevelMeter failed:", e);
      }
    }

    start();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [micId, enabled]);

  // Scale ×2 so talking quietly still lights it up noticeably.
  const pct = Math.min(100, Math.round(level * 200));

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 shrink-0 min-w-[2ch] tabular-nums">
        {enabled ? `${Math.round(pct)}%` : "—"}
      </span>
      <div className="relative flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
          style={{
            width: `${pct}%`,
            background:
              pct > 85
                ? "linear-gradient(to right, #22c55e 0%, #22c55e 60%, #f59e0b 75%, #ef4444 100%)"
                : pct > 60
                  ? "linear-gradient(to right, #22c55e 0%, #22c55e 80%, #f59e0b 100%)"
                  : "#22c55e",
          }}
        />
      </div>
    </div>
  );
}
