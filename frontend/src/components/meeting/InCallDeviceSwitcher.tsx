"use client";

// Mid-call camera / microphone switcher. Lives INSIDE LiveKitRoom so it can
// call room.switchActiveDevice via @livekit/components-react.
//
// Safe while recording: the recorder reads from RecordingComposer, which
// follows whatever camera/mic track LiveKit currently has, so a switch
// just changes the picture/sound in the same take.

import { useEffect, useRef, useState } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";

export function InCallDeviceSwitcher() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click / Escape — people expect dismissal here.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((x) => !x)}
        aria-label="Switch camera or microphone"
        aria-expanded={open}
        title="Choose which camera and microphone to use"
        className="press flex h-11 items-center gap-2 rounded-full bg-studio-btn px-4 text-xs font-bold tracking-tight text-white hover:bg-studio-btn-hover"
      >
        <GearIcon />
        <span className="hidden sm:inline">Camera &amp; mic</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Device settings"
          className="absolute bottom-full left-1/2 z-30 mb-4 w-72 -translate-x-1/2 rounded-2xl border border-black/5 bg-white p-4 text-ink shadow-[0_18px_44px_rgba(24,24,27,0.18)]"
        >
          <DevicePicker kind="videoinput" label="Camera" />
          <div className="my-3 h-px bg-border" />
          <DevicePicker kind="audioinput" label="Microphone" />
        </div>
      )}
    </div>
  );
}

// Must be a stable reference: useMediaDeviceSelect memoizes its device
// observer on onError, so an inline arrow rebuilt the observer on every
// render and the list never filled in ("— No devices —").
function logDeviceError(err: Error) {
  console.warn("device enumeration failed:", err);
}

function DevicePicker({
  kind,
  label,
}: {
  kind: "videoinput" | "audioinput";
  label: string;
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: true,
    onError: logDeviceError,
  });

  const safeActive = activeDeviceId || devices[0]?.deviceId || "";

  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-semibold text-ink-muted">
        {label}
      </span>
      <select
        value={safeActive}
        disabled={devices.length === 0}
        onChange={(e) => {
          // setActiveMediaDevice internally calls room.switchActiveDevice(kind, id)
          // which re-publishes with the new source.
          void setActiveMediaDevice(e.target.value);
        }}
        className="w-full rounded-xl border border-border bg-cream px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-zinc-900/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {devices.length === 0 && <option value="">— No devices —</option>}
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
