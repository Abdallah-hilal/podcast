"""Which recording of each person editing should use.

Each person can have two kinds of file for the same run of the host's room
switch: their HQ takes (recorded in the browser, uploaded in the background)
and their server copies (LiveKit egress at call quality, on the server the
moment the call ends). The HQ take replaces the server copy once it has fully
arrived.

The rule, per (participant, run):
  * every HQ take of that run is ready, and together they're about as long
    as the run's server copies              -> the HQ takes
  * else any server copy of that run ready  -> the ready server copies
  * else                                    -> whatever HQ takes are ready
"About as long" catches a take the worker's sweeper closed with only its
uploaded prefix (laptop closed with a backlog, never reopened): it's `ready`
but missing the end. HQ normally runs a few seconds longer than the server
copy (it starts before the egress does).
Takes without a run (older sessions, local-only mode) are HQ as always.
A run is all HQ or all server copy for one person, never a mix.

worker/sources.py is the original; backend/app/services/sources.py must stay a
byte-identical copy (test_sources.py checks). Stdlib only.
"""

from __future__ import annotations

from collections import defaultdict


def _hq_item(t: dict) -> dict:
    return {"kind": "hq", "id": t["id"], "participant_id": t["participant_id"],
            "start": t["created_at"], "path": t.get("final_storage_path")}


def _server_item(c: dict) -> dict:
    return {"kind": "server", "id": c["id"], "participant_id": c["participant_id"],
            "start": c["started_at"] or c.get("created_at"), "path": c.get("storage_path")}


def _groups(takes: list[dict], copies: list[dict]) -> dict:
    groups: dict = defaultdict(lambda: {"hq": [], "server": []})
    for t in takes:
        groups[(t["participant_id"], t.get("run"))]["hq"].append(t)
    for c in copies:
        groups[(c["participant_id"], c.get("run"))]["server"].append(c)
    return groups


def _total(rows: list[dict]) -> float | None:
    durs = [r.get("duration_seconds") for r in rows]
    return None if not durs or any(d is None for d in durs) else float(sum(durs))


def _hq_shorter(ready_hq: list[dict], ready_server: list[dict]) -> bool:
    hq, server = _total(ready_hq), _total(ready_server)
    if hq is None or server is None:
        return False  # can't tell; trust the status
    return hq < server - max(10.0, 0.005 * server)


def _pick(hq: list[dict], server: list[dict], run) -> tuple[str, list[dict]]:
    ready_hq = [t for t in hq if t["status"] == "ready"]
    ready_server = [c for c in server if c["status"] == "ready"]
    if run is None or (hq and len(ready_hq) == len(hq) and not _hq_shorter(ready_hq, ready_server)):
        return "hq", [_hq_item(t) for t in ready_hq]
    if ready_server:
        return "server", [_server_item(c) for c in ready_server]
    return "hq", [_hq_item(t) for t in ready_hq]


def choose_sources(takes: list[dict], copies: list[dict]) -> list[dict]:
    """Ready files to edit with, oldest first: {kind, id, participant_id,
    start, path}. `takes` are podcast.recordings rows, `copies`
    podcast.server_copies rows."""
    out: list[dict] = []
    for (_pid, run), g in _groups(takes, copies).items():
        out += _pick(g["hq"], g["server"], run)[1]
    return sorted(out, key=lambda i: i["start"] or "")


def summarize_people(takes: list[dict], copies: list[dict]) -> dict:
    """Per participant: which source editing will use ("hq", "server", or
    "none" when nothing is ready) and the HQ/server counts behind it."""
    people: dict = {}
    for (pid, run), g in _groups(takes, copies).items():
        kind, items = _pick(g["hq"], g["server"], run)
        p = people.setdefault(pid, {"source": "none", "hq_ready": 0, "hq_total": 0, "server_ready": 0})
        p["hq_total"] += len(g["hq"])
        p["hq_ready"] += sum(1 for t in g["hq"] if t["status"] == "ready")
        p["server_ready"] += sum(1 for c in g["server"] if c["status"] == "ready")
        if items and (p["source"] == "none" or kind == "server"):
            # Any run on a server copy makes this person's edit partly call
            # quality, so that's what the Mix page should say.
            p["source"] = kind
    return people
