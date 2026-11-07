"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onDelete: () => Promise<void>;
  label?: string;
  confirmLabel?: string;
  className?: string;
  size?: "sm" | "md";
}

/**
 * Two-click delete: first click arms, second (within 3s) fires. No modal, no
 * window.confirm — keeps the row compact and works for keyboard navigation.
 */
export function DeleteButton({
  onDelete,
  label = "Delete",
  confirmLabel = "Confirm?",
  className = "",
  size = "sm",
}: Props) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setBusy(true);
    try {
      await onDelete();
    } catch (err) {
      console.error("Delete failed:", err);
      alert(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
      setArmed(false);
    }
    // Component will unmount on success — no cleanup needed.
  }

  const sizeClass =
    size === "sm"
      ? "text-xs px-2 py-1"
      : "text-sm px-3 py-1.5";

  const stateClass = busy
    ? "bg-gray-700 text-gray-400 cursor-wait"
    : armed
      ? "bg-red-600 hover:bg-red-700 text-white"
      : "bg-transparent text-gray-500 hover:text-red-400 hover:bg-red-950/40";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={`rounded transition-colors ${sizeClass} ${stateClass} ${className}`}
    >
      {busy ? "Deleting…" : armed ? confirmLabel : label}
    </button>
  );
}
