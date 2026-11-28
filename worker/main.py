"""
Processing worker for podcast recordings.

Polls the `processing_jobs` table and dispatches on `job_type`:
  * `reconstruct` — concatenate uploaded batches into a single WebM.
  * `composite`   — ffmpeg side-by-side of all ready recordings in a session,
                    store under podcast.session_composites.

Two background threads run the server recording copy (LiveKit participant
egress, see server_copy.py): `reconcile_loop` keeps one egress per person in
every room whose host switch is on and notices finished ones; `import_loop`
moves finished files from /egress into storage.

The byte-wise WebM concat is safe because every batch comes from one browser
`MediaRecorder` session using timeslice: the recorder emits one WebM header
in the first chunk and raw Matroska clusters afterwards. Pause/resume or
multi-session recordings would break this assumption — out of scope.

Run: `python worker/main.py` from the repo root with SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in the environment.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from livekit import api as lkapi
from livekit.api.twirp_client import TwirpError
from postgrest.exceptions import APIError
from supabase import Client, create_client

from server_copy import (
    egress_done, egress_filepath, local_to_worker, plan_reconcile, storage_path,
)
from sources import choose_sources
from sweep import final_path, plan_sweep

BUCKET = "podcast-recordings"
POLL_INTERVAL_SEC = float(os.environ.get("WORKER_POLL_INTERVAL_SEC", "5"))
SWEEP_INTERVAL_SEC = float(os.environ.get("WORKER_SWEEP_INTERVAL_SEC", "60"))
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))

# Composite knobs — tunable via env
COMPOSITE_WIDTH = int(os.environ.get("COMPOSITE_WIDTH", "1920"))
COMPOSITE_HEIGHT = int(os.environ.get("COMPOSITE_HEIGHT", "1080"))

JOB_TYPES = ("reconstruct", "composite")

# Server recording copy (LiveKit participant egress).
EGRESS_DIR = Path(os.environ.get("EGRESS_DIR", "/egress"))
RECONCILE_INTERVAL_SEC = float(os.environ.get("SERVER_COPY_RECONCILE_SEC", "2"))
IMPORT_INTERVAL_SEC = float(os.environ.get("SERVER_COPY_IMPORT_SEC", "5"))
IMPORT_RETRY_SEC = 60
# An egress LiveKit no longer knows about is given this long before the copy
# is written off (it normally reports COMPLETE within seconds).
EGRESS_LOST_SEC = 600

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("worker")

_stop = False


def _handle_signal(signum: int, _frame: Any) -> None:
    global _stop
    log.info("received signal %s, draining…", signum)
    _stop = True


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        sys.exit(1)
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Claim loop
# ---------------------------------------------------------------------------

def claim_next_job(db: Client) -> dict | None:
    """Find and claim the oldest pending job across all known types."""
    candidates = (
        db.schema("podcast").table("processing_jobs")
        .select("*")
        .eq("status", "pending")
        .in_("job_type", list(JOB_TYPES))
        .order("created_at")
        .limit(1)
        .execute()
    )
    if not candidates.data:
        return None

    job = candidates.data[0]
    claimed = (
        db.schema("podcast").table("processing_jobs")
        .update({"status": "processing", "attempts": job["attempts"] + 1})
        .eq("id", job["id"])
        .eq("status", "pending")
        .execute()
    )
    if not claimed.data:
        return None
    return claimed.data[0]


# ---------------------------------------------------------------------------
# reconstruct
# ---------------------------------------------------------------------------

def process_reconstruct(db: Client, job: dict) -> None:
    recording_id = job["recording_id"]
    log.info("job %s: reconstructing recording %s", job["id"], recording_id)

    recording = (
        db.schema("podcast").table("recordings")
        .select("final_storage_path")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    final_path = recording.data.get("final_storage_path")
    if not final_path:
        raise RuntimeError(
            f"recording {recording_id} has no final_storage_path (was /finalize called?)"
        )

    batches = (
        db.schema("podcast").table("recording_batches")
        .select("sequence_number, storage_path, byte_size")
        .eq("recording_id", recording_id)
        # Normal finalize requires every batch uploaded; a sweeper-closed
        # take may carry "error" batches past its uploaded prefix.
        .eq("upload_status", "uploaded")
        .order("sequence_number")
        .execute()
    )
    if not batches.data:
        raise RuntimeError(f"recording {recording_id} has no batches to reconstruct")

    log.info("job %s: concatenating %d batches", job["id"], len(batches.data))
    tmpdir = Path(tempfile.mkdtemp(prefix="reconstruct-"))
    raw_path = tmpdir / "raw.webm"
    try:
        with open(raw_path, "wb") as out:
            for batch in batches.data:
                out.write(db.storage.from_(BUCKET).download(batch["storage_path"]))

        upload_path, duration = _remux_with_index(raw_path, tmpdir / "indexed.webm")
        total = upload_path.stat().st_size
        with open(upload_path, "rb") as f:
            db.storage.from_(BUCKET).upload(
                final_path,
                f,
                {"content-type": "video/webm", "upsert": "true"},
            )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    db.schema("podcast").table("recordings").update(
        {
            "status": "ready",
            "total_bytes": total,
            "duration_seconds": duration,
            "updated_at": _now_iso(),
        }
    ).eq("id", recording_id).execute()
    db.schema("podcast").table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()

    log.info(
        "job %s: done — recording %s ready (%d bytes, %ss)",
        job["id"], recording_id, total, duration,
    )


def _probe_duration(path: Path) -> float | None:
    ffprobe = str(Path(_ffmpeg_bin()).with_name("ffprobe"))
    if not Path(ffprobe).exists():
        ffprobe = shutil.which("ffprobe") or "ffprobe"
    r = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(r.stdout.strip()), 3)
    except ValueError:
        return None


def _video_codec(path: Path) -> str | None:
    ffprobe = str(Path(_ffmpeg_bin()).with_name("ffprobe"))
    if not Path(ffprobe).exists():
        ffprobe = shutil.which("ffprobe") or "ffprobe"
    r = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return r.stdout.strip() or None


def _remux_with_index(src: Path, dst: Path) -> tuple[Path, float | None]:
    """MediaRecorder WebM has no duration and no cues, so players can't seek
    and most editors refuse to import it, and its audio can have timestamp
    gaps (mic muted) that desync anything ignoring timestamps. Copy the video,
    re-encode the audio with gaps filled by silence, and write a proper index.
    Falls back to a plain copy, then to the raw file."""
    if _video_codec(src) not in ("vp8", "vp9", "av1"):
        return src, _probe_duration(src)
    base = [_ffmpeg_bin(), "-nostdin", "-y", "-loglevel", "error", "-fflags", "+genpts", "-i", str(src)]
    attempts = [
        ["-map", "0:v?", "-map", "0:a?", "-c:v", "copy",
         "-af", "aresample=async=1:first_pts=0", "-c:a", "libopus", "-b:a", "192k"],
        ["-map", "0", "-c", "copy"],
    ]
    for extra in attempts:
        r = subprocess.run(base + extra + [str(dst)], capture_output=True, text=True)
        if r.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return dst, _probe_duration(dst)
        log.warning("remux attempt failed (rc=%s): %s", r.returncode, r.stderr[-500:])
    return src, _probe_duration(src)


# ---------------------------------------------------------------------------
# composite
# ---------------------------------------------------------------------------

def _ffmpeg_bin() -> str:
    env = os.environ.get("FFMPEG_BIN")
    if env:
        return env
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError("ffmpeg not found on PATH — set FFMPEG_BIN or install ffmpeg")
    return found


def process_composite(db: Client, job: dict) -> None:
    session_id = job.get("session_id")
    if not session_id:
        raise RuntimeError("composite job has no session_id")
    log.info("job %s: compositing session %s", job["id"], session_id)

    db.schema("podcast").table("session_composites").update(
        {"status": "processing", "error_message": None, "updated_at": _now_iso()}
    ).eq("session_id", session_id).execute()

    # Per person: the HQ takes once they've all arrived, else the server copy
    # (sources.py). Oldest first — stable ordering.
    chosen = _session_sources(db, session_id)
    if not chosen:
        raise RuntimeError(f"no ready recordings for session {session_id}")

    tmpdir = Path(tempfile.mkdtemp(prefix="composite-"))
    takes: list[Take] = []
    try:
        t0 = min(_parse_ts(r["start"]) for r in chosen)
        for i, r in enumerate(chosen):
            fp = r.get("path")
            if not fp:
                continue
            ext = ".mp4" if r["kind"] == "server" else ".webm"
            raw = tmpdir / f"input-{i:02d}{ext}"
            raw.write_bytes(db.storage.from_(BUCKET).download(fp))
            path, duration = _remux_with_index(raw, tmpdir / f"input-{i:02d}-indexed.webm")
            if not duration:
                log.warning("skipping %s %s: unreadable duration", r["kind"], r["id"])
                continue
            takes.append(Take(
                path=path,
                participant_id=r["participant_id"],
                offset=(_parse_ts(r["start"]) - t0).total_seconds(),
                duration=duration,
            ))

        if not takes:
            raise RuntimeError(f"session {session_id} has no downloadable recordings")

        out_path = tmpdir / "composite.webm"
        _render_composite(takes, out_path)
        total_bytes = out_path.stat().st_size

        final_path = f"sessions/{session_id}/composite/final.webm"
        with open(out_path, "rb") as f:
            db.storage.from_(BUCKET).upload(
                final_path,
                f,
                {"content-type": "video/webm", "upsert": "true"},
            )

        db.schema("podcast").table("session_composites").update(
            {
                "status": "ready",
                "final_storage_path": final_path,
                "total_bytes": total_bytes,
                "updated_at": _now_iso(),
                "error_message": None,
            }
        ).eq("session_id", session_id).execute()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    db.schema("podcast").table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()
    log.info("job %s: composite ready for session %s (%d takes)", job["id"], session_id, len(takes))


def _session_sources(db: Client, session_id: str) -> list[dict]:
    pg = db.schema("podcast")
    takes = (
        pg.table("recordings")
        .select("id, participant_id, run, status, created_at, final_storage_path")
        .eq("session_id", session_id)
        .execute()
    ).data or []
    copies = (
        pg.table("server_copies")
        .select("id, participant_id, run, status, started_at, created_at, storage_path")
        .eq("session_id", session_id)
        .execute()
    ).data or []
    return choose_sources(takes, copies)


@dataclass
class Take:
    path: Path
    participant_id: str
    offset: float  # seconds after the session's first Record press
    duration: float


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _render_composite(takes: list[Take], out: Path) -> None:
    """One tile per participant, every take placed on a shared timeline.

    Each side presses Record on its own, so recordings start at different
    moments; `offset` (from the server-side created_at) lines them up. A
    participant with several takes ("Record again", rejoin) keeps one tile.
    """
    w, h = COMPOSITE_WIDTH, COMPOSITE_HEIGHT
    participants = list(dict.fromkeys(t.participant_id for t in takes))
    n = len(participants)
    total = max(t.offset + t.duration for t in takes)
    if n == 1:
        tile_w, tile_h = w, h
    elif n == 2:
        tile_w, tile_h = w // 2, h
    else:
        tile_w, tile_h = w // 2, h // 2

    cmd = [_ffmpeg_bin(), "-nostdin", "-y"]
    for t in takes:
        cmd += ["-i", str(t.path)]

    parts: list[str] = []
    tiles: list[str] = []
    for pi, pid in enumerate(participants):
        parts.append(f"color=c=black:s={tile_w}x{tile_h}:r=30:d={total:.3f}[base{pi}]")
        cur = f"base{pi}"
        for k, t in enumerate(takes):
            if t.participant_id != pid:
                continue
            parts.append(
                f"[{k}:v]scale={tile_w}:{tile_h}:force_original_aspect_ratio=increase,"
                f"crop={tile_w}:{tile_h},setsar=1,fps=30,"
                f"setpts=PTS-STARTPTS+{t.offset:.3f}/TB[tv{k}]"
            )
            parts.append(f"[{cur}][tv{k}]overlay=eof_action=pass:repeatlast=0[o{pi}_{k}]")
            cur = f"o{pi}_{k}"
        tiles.append(f"[{cur}]")

    if n == 1:
        parts.append(f"{tiles[0]}null[v]")
    elif n == 2:
        parts.append(f"{''.join(tiles)}hstack=inputs=2[v]")
    else:
        if n == 3:
            parts.append(f"color=c=black:s={tile_w}x{tile_h}:r=30:d={total:.3f}[pad]")
            tiles.append("[pad]")
        parts.append(f"{''.join(tiles)}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]")

    for k, t in enumerate(takes):
        ms = int(round(t.offset * 1000))
        parts.append(f"[{k}:a]aresample=48000:async=1:first_pts=0,adelay={ms}:all=1[a{k}]")
    amix_in = "".join(f"[a{k}]" for k in range(len(takes)))
    parts.append(
        f"{amix_in}amix=inputs={len(takes)}:duration=longest:dropout_transition=0:normalize=0,"
        f"alimiter=limit=0.95[a]"
    )

    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", "[v]", "-map", "[a]",
        "-t", f"{total:.3f}",
        "-c:v", "libvpx-vp9", "-b:v", "3M", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1",
        "-c:a", "libopus", "-b:a", "128k",
        str(out),
    ]
    log.info("ffmpeg: %s", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed (rc={r.returncode}): {r.stderr[-2000:]}")


# ---------------------------------------------------------------------------
# server recording copy — reconcile + import threads (see server_copy.py)
# ---------------------------------------------------------------------------

def _livekit_env() -> tuple[str, str, str] | None:
    url = os.environ.get("LIVEKIT_URL", "")
    key = os.environ.get("LIVEKIT_API_KEY", "")
    secret = os.environ.get("LIVEKIT_API_SECRET", "")
    return (url, key, secret) if url and key and secret else None


def _ns_to_iso(ns: int) -> str | None:
    return datetime.fromtimestamp(ns / 1e9, timezone.utc).isoformat() if ns else None


async def _room_identities(lk: lkapi.LiveKitAPI, room: str, members: set[str]) -> set[str] | None:
    try:
        res = await lk.room.list_participants(lkapi.ListParticipantsRequest(room=room))
    except TwirpError as e:
        if e.code == "not_found":
            return None
        raise
    return {
        p.identity for p in res.participants
        if p.kind != lkapi.ParticipantInfo.Kind.EGRESS and p.identity in members
    }


async def _start_copy(pg, lk: lkapi.LiveKitAPI, session: dict, pid: str) -> None:
    run = session["recording_run"]
    cid = str(uuid4())
    try:
        pg.table("server_copies").insert({
            "id": cid, "session_id": session["id"], "participant_id": pid,
            "run": run, "status": "starting",
        }).execute()
    except APIError as e:
        if getattr(e, "code", None) == "23505":  # someone else claimed it
            return
        raise
    filepath = egress_filepath(session["id"], pid, cid)
    try:
        info = await lk.egress.start_participant_egress(lkapi.ParticipantEgressRequest(
            room_name=session["room_name"],
            identity=pid,
            preset=lkapi.EncodingOptionsPreset.H264_720P_30,
            file_outputs=[lkapi.EncodedFileOutput(
                file_type=lkapi.EncodedFileType.MP4, filepath=filepath,
            )],
        ))
    except Exception as e:
        pg.table("server_copies").update({
            "status": "error", "error_message": f"start: {e}"[:500], "updated_at": _now_iso(),
        }).eq("id", cid).execute()
        log.warning("server copy: couldn't start egress for %s in %s: %s", pid, session["room_name"], e)
        return
    pg.table("server_copies").update({
        "egress_id": info.egress_id, "status": "recording",
        "local_path": filepath, "updated_at": _now_iso(),
    }).eq("id", cid).execute()
    log.info("server copy %s: egress %s recording %s (run %s)", cid, info.egress_id, pid, run)


async def _stop_copy(pg, lk: lkapi.LiveKitAPI, row: dict) -> None:
    if not row.get("egress_id"):
        pg.table("server_copies").update({
            "status": "error", "error_message": "stopped before the egress started",
            "updated_at": _now_iso(),
        }).eq("id", row["id"]).execute()
        return
    try:
        await lk.egress.stop_egress(lkapi.StopEgressRequest(egress_id=row["egress_id"]))
    except TwirpError as e:
        # Already ended (participant left, room closed): the finish check
        # picks up its final state either way.
        log.info("server copy %s: stop_egress: %s", row["id"], e.message)
    pg.table("server_copies").update(
        {"status": "stopping", "updated_at": _now_iso()}
    ).eq("id", row["id"]).in_("status", ["starting", "recording"]).execute()
    log.info("server copy %s: stopping egress %s", row["id"], row["egress_id"])


async def _check_finished(pg, lk: lkapi.LiveKitAPI, row: dict) -> None:
    res = await lk.egress.list_egress(lkapi.ListEgressRequest(egress_id=row["egress_id"]))
    if not res.items:
        age = (datetime.now(timezone.utc) - _parse_ts(row["updated_at"])).total_seconds()
        if age > EGRESS_LOST_SEC:
            pg.table("server_copies").update({
                "status": "error", "error_message": "LiveKit lost track of the egress",
                "updated_at": _now_iso(),
            }).eq("id", row["id"]).execute()
        return
    info = res.items[0]
    if not egress_done(info.status):
        return
    files = list(info.file_results) or ([info.file] if info.HasField("file") else [])
    f = files[0] if files else None
    complete = info.status in (lkapi.EgressStatus.EGRESS_COMPLETE, lkapi.EgressStatus.EGRESS_LIMIT_REACHED)
    if complete and f is not None and f.size > 0:
        pg.table("server_copies").update({
            "status": "importing",
            "local_path": f.filename or row.get("local_path"),
            "started_at": _ns_to_iso(f.started_at),
            "ended_at": _ns_to_iso(f.ended_at),
            "duration_seconds": round(f.duration / 1e9, 3) if f.duration else None,
            "total_bytes": f.size,
            "error_message": None,
            "updated_at": _now_iso(),
        }).eq("id", row["id"]).execute()
        log.info("server copy %s: egress done (%d bytes) — importing", row["id"], f.size)
    else:
        status = lkapi.EgressStatus.Name(info.status)
        pg.table("server_copies").update({
            "status": "error", "error_message": f"{status}: {info.error}"[:500],
            "updated_at": _now_iso(),
        }).eq("id", row["id"]).execute()
        log.warning("server copy %s: egress ended %s: %s", row["id"], status, info.error)


async def _reconcile_tick(db: Client, lk: lkapi.LiveKitAPI) -> None:
    pg = db.schema("podcast")
    on = (
        pg.table("sessions").select("id, room_name, recording_run")
        .not_.is_("recording_run", "null").execute()
    ).data or []
    busy = (
        pg.table("server_copies").select("session_id")
        .in_("status", ["starting", "recording", "stopping"]).execute()
    ).data or []
    sessions = {s["id"]: s for s in on}
    missing = {c["session_id"] for c in busy} - set(sessions)
    if missing:
        for s in (
            pg.table("sessions").select("id, room_name, recording_run")
            .in_("id", list(missing)).execute()
        ).data or []:
            sessions[s["id"]] = s

    for s in sessions.values():
        copies = (pg.table("server_copies").select("*").eq("session_id", s["id"]).execute()).data or []
        identities = None
        if s.get("recording_run"):
            members = {
                p["id"] for p in (
                    pg.table("participants").select("id").eq("session_id", s["id"]).execute()
                ).data or []
            }
            identities = await _room_identities(lk, s["room_name"], members)
        plan = plan_reconcile(s, identities, copies, datetime.now(timezone.utc))

        if plan.clear_run:
            pg.table("sessions").update({"recording_run": None}).eq("id", s["id"]).eq(
                "recording_run", s["recording_run"]).execute()
            log.info("server copy: room %s is gone — switch cleared", s["room_name"])
        for row in plan.retire:
            pg.table("server_copies").update({
                "status": "error", "error_message": "start never completed",
                "updated_at": _now_iso(),
            }).eq("id", row["id"]).eq("status", "starting").execute()
        for row in plan.stop:
            await _stop_copy(pg, lk, row)
        for pid in plan.start:
            await _start_copy(pg, lk, s, pid)

        stopped = {r["id"] for r in plan.stop}
        for row in copies:
            if row["status"] in ("recording", "stopping") and row.get("egress_id") and row["id"] not in stopped:
                await _check_finished(pg, lk, row)


async def _reconcile_main(creds: tuple[str, str, str]) -> None:
    db = _get_client()
    async with lkapi.LiveKitAPI(*creds) as lk:
        while not _stop:
            try:
                await _reconcile_tick(db, lk)
            except Exception:
                log.exception("server copy: reconcile tick failed")
            await asyncio.sleep(RECONCILE_INTERVAL_SEC)


def reconcile_loop(creds: tuple[str, str, str]) -> None:
    asyncio.run(_reconcile_main(creds))


def _upload_file(dest: str, src: Path, content_type: str) -> None:
    """Stream a big local file into storage. Uses its own client with long
    timeouts: the shared storage3 client times out after 20 s."""
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    size = src.stat().st_size
    with open(src, "rb") as f:
        r = httpx.post(
            f"{base}/storage/v1/object/{BUCKET}/{dest}",
            headers={
                "Authorization": f"Bearer {key}", "apikey": key,
                "Content-Type": content_type, "Content-Length": str(size),
                "x-upsert": "true",
            },
            content=f,
            timeout=httpx.Timeout(900.0, connect=30.0),
        )
    if r.status_code >= 300:
        raise RuntimeError(f"storage upload {r.status_code}: {r.text[:300]}")


def _import_one(pg, row: dict) -> None:
    src = Path(local_to_worker(row["local_path"] or ""))
    if not src.is_file():
        pg.table("server_copies").update({
            "status": "error", "error_message": f"file missing: {src}", "updated_at": _now_iso(),
        }).eq("id", row["id"]).execute()
        log.warning("server copy %s: %s is missing", row["id"], src)
        return
    dest = storage_path(row["session_id"], row["participant_id"], row["id"])
    try:
        _upload_file(dest, src, "video/mp4")
    except Exception as e:
        pg.table("server_copies").update(
            {"error_message": f"import: {e}"[:500], "updated_at": _now_iso()}
        ).eq("id", row["id"]).execute()
        log.warning("server copy %s: import failed, retrying in %ds: %s", row["id"], IMPORT_RETRY_SEC, e)
        return
    pg.table("server_copies").update({
        "status": "ready", "storage_path": dest, "total_bytes": src.stat().st_size,
        "duration_seconds": row.get("duration_seconds") or _probe_duration(src),
        "error_message": None, "updated_at": _now_iso(),
    }).eq("id", row["id"]).execute()
    log.info("server copy %s: ready at %s", row["id"], dest)
    for p in (src, src.with_suffix(".json"), src.with_name(src.name + ".json")):
        p.unlink(missing_ok=True)


def import_loop() -> None:
    db = _get_client()
    pg = db.schema("podcast")
    while not _stop:
        try:
            rows = (
                pg.table("server_copies").select("*").eq("status", "importing")
                .order("created_at").execute()
            ).data or []
            now = datetime.now(timezone.utc)
            for row in rows:
                if row.get("error_message") and (
                    now - _parse_ts(row["updated_at"])
                ).total_seconds() < IMPORT_RETRY_SEC:
                    continue
                _import_one(pg, row)
        except Exception:
            log.exception("server copy: import pass failed")
        time.sleep(IMPORT_INTERVAL_SEC)


def start_server_copy_threads() -> None:
    creds = _livekit_env()
    if not creds or not EGRESS_DIR.is_dir():
        log.info("server copy: off (LiveKit env or %s missing)", EGRESS_DIR)
        return
    threading.Thread(target=reconcile_loop, args=(creds,), name="reconcile", daemon=True).start()
    threading.Thread(target=import_loop, name="import", daemon=True).start()
    log.info("server copy: reconcile every %.0fs, import every %.0fs", RECONCILE_INTERVAL_SEC, IMPORT_INTERVAL_SEC)


# ---------------------------------------------------------------------------
# Failure handling + main loop
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# sweeper — close takes whose browser vanished (see sweep.py)
# ---------------------------------------------------------------------------

def sweep_abandoned(db: Client) -> None:
    pg = db.schema("podcast")
    open_takes = (
        pg.table("recordings")
        .select("id, session_id, participant_id, status, created_at, updated_at")
        .eq("status", "recording")
        .execute()
    ).data or []
    now = datetime.now(timezone.utc)
    for rec in open_takes:
        try:
            batches = (
                pg.table("recording_batches")
                .select("id, sequence_number, upload_status, created_at, updated_at")
                .eq("recording_id", rec["id"])
                .execute()
            ).data or []
            decision = plan_sweep(rec, batches, now)
            if decision is None:
                continue
            if decision.action == "fail":
                pg.table("recordings").update(
                    {"status": "error", "updated_at": _now_iso()}
                ).eq("id", rec["id"]).eq("status", "recording").execute()
                log.info("sweep: take %s never uploaded anything — marked error", rec["id"])
                continue

            # Claim by flipping status while it's still `recording`; from here
            # the backend 409s any late batch or finalize from the browser.
            claimed = (
                pg.table("recordings")
                .update({
                    "status": "uploaded",
                    "final_storage_path": final_path(
                        rec["session_id"], rec["participant_id"], rec["id"]
                    ),
                    "updated_at": _now_iso(),
                })
                .eq("id", rec["id"])
                .eq("status", "recording")
                .execute()
            )
            if not claimed.data:
                continue
            # Re-read after the claim so a batch registered in between is
            # excluded too; only the contiguous uploaded prefix is stitched.
            # Mark the rest "error" (the schema's only non-uploaded terminal
            # value) rather than deleting rows or files — nothing that might
            # hold data is ever destroyed here.
            extra = (
                pg.table("recording_batches")
                .select("id")
                .eq("recording_id", rec["id"])
                .not_.in_("sequence_number", decision.keep_seqs)
                .execute()
            ).data or []
            if extra:
                pg.table("recording_batches").update(
                    {"upload_status": "error"}
                ).in_("id", [b["id"] for b in extra]).execute()
            pg.table("processing_jobs").insert({
                "id": str(uuid4()),
                "recording_id": rec["id"],
                "job_type": "reconstruct",
                "status": "pending",
                "attempts": 0,
            }).execute()
            log.info(
                "sweep: take %s went silent — closing with batches %s (%d excluded)",
                rec["id"], decision.keep_seqs, len(extra),
            )
        except Exception:
            log.exception("sweep: take %s failed, will retry next sweep", rec["id"])


def fail_job(db: Client, job: dict, err: Exception) -> None:
    attempts = job["attempts"]
    message = f"{type(err).__name__}: {err}"
    log.exception("job %s failed on attempt %d: %s", job["id"], attempts, message)

    final = attempts >= MAX_ATTEMPTS
    db.schema("podcast").table("processing_jobs").update(
        {
            "status": "failed" if final else "pending",
            "error_message": message,
            "completed_at": _now_iso() if final else None,
        }
    ).eq("id", job["id"]).execute()

    if not final:
        return

    # Terminal failure — mark the owning entity errored.
    jt = job["job_type"]
    if jt == "reconstruct" and job.get("recording_id"):
        db.schema("podcast").table("recordings").update({"status": "error"}).eq(
            "id", job["recording_id"]
        ).execute()
    elif jt == "composite" and job.get("session_id"):
        db.schema("podcast").table("session_composites").update(
            {"status": "error", "error_message": message, "updated_at": _now_iso()}
        ).eq("session_id", job["session_id"]).execute()


def main() -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db = _get_client()
    log.info(
        "worker started (poll=%.1fs, max_attempts=%d, types=%s)",
        POLL_INTERVAL_SEC, MAX_ATTEMPTS, JOB_TYPES,
    )
    start_server_copy_threads()

    last_sweep = 0.0
    while not _stop:
        if time.monotonic() - last_sweep >= SWEEP_INTERVAL_SEC:
            last_sweep = time.monotonic()
            try:
                sweep_abandoned(db)
            except Exception:
                log.exception("sweep failed, retrying next interval")

        try:
            job = claim_next_job(db)
        except Exception:
            log.exception("claim failed, retrying after poll interval")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if job is None:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        try:
            jt = job["job_type"]
            if jt == "reconstruct":
                process_reconstruct(db, job)
            elif jt == "composite":
                process_composite(db, job)
            else:
                raise RuntimeError(f"unknown job_type: {jt}")
        except Exception as e:
            fail_job(db, job, e)

    log.info("worker stopped")


if __name__ == "__main__":
    main()
