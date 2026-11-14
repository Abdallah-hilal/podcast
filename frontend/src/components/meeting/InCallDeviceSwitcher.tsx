"use client";

// Mid-call camera / microphone switcher. Lives INSIDE LiveKitRoom so it can
// call room.switchActiveDevice via @livekit/components-react.
//
// Locked while recording — MediaRecorder tears down when the source track it
// was reading ends, and switchActiveDevice ends the old track before adopting
// the new one. Stop the recording before switching devices.

import { useEffect, useRef, useState } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";

export function InCallDeviceSwitcher({ locked }: { locked: boolean }) {
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
        title={
          locked
            ? "Stop recording to switch devices"
            : "Switch camera / microphone"
        }
        className="press w-11 h-11 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white ring-1 ring-white/10"
      >
        <GearIcon />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Device settings"
          className="absolute bottom-full mb-3 right-0 w-72 material-dark border border-white/15 rounded-2xl p-4 shadow-xl z-30"
        >
          {locked && (
            <p className="mb-3 text-[11px] text-orange-200 bg-orange-400/10 border border-orange-400/30 rounded-lg px-2 py-1.5">
              Switching mid-recording ends the current take. Stop first.
            </p>
          )}
          <DevicePicker kind="videoinput" label="Camera" disabled={locked} />
          <div className="h-px bg-white/10 my-3" />
          <DevicePicker kind="audioinput" label="Microphone" disabled={locked} />
        </div>
      )}
    </div>
  );
}

function DevicePicker({
  kind,
  label,
  disabled,
}: {
  kind: "videoinput" | "audioinput";
  label: string;
  disabled: boolean;
}) {
  // onError: the first time LiveKit enumerates devices it may need to prompt
  // for permission; a user who declined gets an error here. Log and move on —
  // the <select> renders empty and shows "— No devices —".
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    onError: (err) => console.warn(`device enumeration (${kind}) failed:`, err),
  });

  const safeActive = activeDeviceId || devices[0]?.deviceId || "";

  return (
    <label className="block space-y-1.5">
      <span className="block text-[10px] font-bold uppercase tracking-widest text-teal-300">
        {label}
      </span>
      <select
        value={safeActive}
        disabled={disabled || devices.length === 0}
        onChange={(e) => {
          // setActiveMediaDevice internally calls room.switchActiveDevice(kind, id)
          // which re-publishes with the new source.
          void setActiveMediaDevice(e.target.value);
        }}
        className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-coral-600/60 disabled:opacity-50 disabled:cursor-not-allowed"
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
