"""Decisions for the server recording copy (LiveKit participant egress).

The backend only writes `sessions.recording_run` next to the room metadata
when the host flips the switch. The worker's reconcile thread calls
`plan_reconcile` for each session every couple of seconds and makes LiveKit
match it: one open egress per person in the room for the current run, none
for any other run. Stdlib only; the LiveKit and DB calls live in main.py.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

OPEN = ("starting", "recording")
# A failed start (egress refused, not connected) waits this long before the
# next try: long enough not to hammer a broken egress every 2 s tick, short
# enough that a refusal while the previous run's encoders are still finishing
# (quick Stop → Record) costs seconds, not a minute.
RETRY_AFTER_ERROR_SEC = 10
# A `starting` row with no egress after this long means the worker died
# between claiming and starting; it blocks the unique index, so retire it.
STUCK_STARTING_SEC = 60

# livekit EgressStatus: STARTING 0, ACTIVE 1, ENDING 2, COMPLETE 3, FAILED 4,
# ABORTED 5, LIMIT_REACHED 6.
_DONE_FROM = 3


@dataclass
class Plan:
    start: list[str] = field(default_factory=list)   # participant ids
    stop: list[dict] = field(default_factory=list)   # open copy rows
    retire: list[dict] = field(default_factory=list)  # stuck `starting` rows
    clear_run: bool = False


def _age(row: dict, now: datetime) -> float:
    ts = row.get("updated_at") or row.get("created_at")
    return (now - datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds()


def plan_reconcile(session: dict, room_identities: set[str] | None,
                   copies: list[dict], now: datetime) -> Plan:
    """`room_identities`: podcast participants in the LiveKit room right now
    (egress participants excluded), or None when the room doesn't exist."""
    run = session.get("recording_run")
    plan = Plan()
    open_rows = [c for c in copies if c["status"] in OPEN]

    if run and room_identities is None:
        # The room closed with the switch still on (host's browser vanished).
        plan.clear_run = True
        run = None

    plan.stop = [c for c in open_rows if c["run"] != run]
    if not run:
        return plan

    for c in open_rows:
        if c["status"] == "starting" and not c.get("egress_id") and _age(c, now) > STUCK_STARTING_SEC:
            plan.retire.append(c)

    for pid in sorted(room_identities or ()):
        mine = [c for c in copies if c["participant_id"] == pid and c["run"] == run]
        if any(c["status"] in OPEN for c in mine):
            continue
        if any(c["status"] == "error" and _age(c, now) < RETRY_AFTER_ERROR_SEC for c in mine):
            continue
        plan.start.append(pid)
    return plan


def room_run(metadata: str | None) -> str | None:
    """The run the room's switch is on, from LiveKit room metadata (written by
    the backend's set_room_recording), or None when it's off or not ours.

    The reconcile loop only records a room whose metadata agrees with
    `sessions.recording_run`: a room that closed with the switch on comes
    back with empty metadata, and must not start recording people again."""
    try:
        m = json.loads(metadata or "")
    except ValueError:
        return None
    if isinstance(m, dict) and m.get("recording") is True and isinstance(m.get("run"), str) and m["run"]:
        return m["run"]
    return None


def egress_done(status: int) -> bool:
    return status >= _DONE_FROM


def egress_filepath(session_id: str, participant_id: str, copy_id: str) -> str:
    """Where the egress container writes the file (/opt/podcast-egress on the host)."""
    return f"/out/{session_id}/{participant_id}/{copy_id}.mp4"


def local_to_worker(path: str) -> str:
    """The same file as the worker container sees it."""
    return "/egress/" + path.removeprefix("/out/")


def storage_path(session_id: str, participant_id: str, copy_id: str) -> str:
    return f"sessions/{session_id}/participants/{participant_id}/server-{copy_id}/call.mp4"
