"""Decide what to do with takes whose browser stopped sending data.

Pure (stdlib only) so it can be unit-tested without the worker's heavy
dependencies. An open page pings once a minute (heartbeat) and registers a
batch every ~60 s while recording, so a take silent for SILENT_AFTER has
lost its browser for good (tab closed and never reopened, laptop died). If
its uploads form a prefix from sequence 0 we close the take with that
prefix. A take that never uploaded anything is marked failed after
FAIL_AFTER so it stops showing "recording" forever.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

# A day, not minutes: on a slow home uplink the browser can hold hours of
# not-yet-uploaded recording when the person closes the laptop. Recovery
# finishes it when they reopen the link; closing earlier would throw that
# backlog away. The heartbeat (recordings.updated_at) keeps open pages alive.
SILENT_AFTER = timedelta(hours=24)
FAIL_AFTER = timedelta(hours=24)


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

    # recordings.updated_at is the browser's once-a-minute heartbeat while it
    # records or uploads; a slow uplink can take far longer than 5 min to
    # drain its backlog after Stop without registering any new batch.
    stamps = [_ts(rec["created_at"])]
    if rec.get("updated_at"):
        stamps.append(_ts(rec["updated_at"]))
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
