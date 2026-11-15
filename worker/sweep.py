"""Decide what to do with takes whose browser stopped sending data.

Pure (stdlib only) so it can be unit-tested without the worker's heavy
dependencies. A live take registers a new batch at least every ~60 s, so a
take with no activity for SILENT_AFTER has lost its browser (tab closed,
crash, laptop died). If its uploads form a prefix from sequence 0 we close
the take with that prefix — the person keeps everything up to roughly the
last minute. A take that never uploaded anything is marked failed after
FAIL_AFTER so it stops showing "recording" forever.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

SILENT_AFTER = timedelta(minutes=5)
FAIL_AFTER = timedelta(minutes=60)


@dataclass
class SweepDecision:
    action: str  # "finalize" | "fail"
    keep_seqs: list[int] = field(default_factory=list)
    drop_ids: list[str] = field(default_factory=list)


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def final_path(session_id: str, participant_id: str, recording_id: str) -> str:
    """Same layout as backend app.services.storage.get_final_path."""
    return (
        f"sessions/{session_id}/participants/{participant_id}"
        f"/recording-{recording_id}/original.webm"
    )


def plan_sweep(rec: dict, batches: list[dict], now: datetime) -> SweepDecision | None:
    if rec.get("status") != "recording":
        return None

    stamps = [_ts(rec["created_at"])]
    for b in batches:
        for key in ("created_at", "updated_at"):
            if b.get(key):
                stamps.append(_ts(b[key]))
    silent_for = now - max(stamps)

    if silent_for < SILENT_AFTER:
        return None

    ordered = sorted(batches, key=lambda b: b["sequence_number"])
    keep: list[int] = []
    for b in ordered:
        if b["sequence_number"] == len(keep) and b.get("upload_status") == "uploaded":
            keep.append(b["sequence_number"])
        else:
            break

    if keep:
        drop = [b["id"] for b in ordered if b["sequence_number"] not in keep]
        return SweepDecision("finalize", keep_seqs=keep, drop_ids=drop)

    if silent_for >= FAIL_AFTER:
        return SweepDecision("fail")
    return None
