"""
Processing worker for podcast recordings.

Polls the `processing_jobs` table and dispatches on `job_type`:
  * `reconstruct` — concatenate uploaded batches into a single WebM.
  * `transcribe`  — run faster-whisper on the reconstructed file, store
                    transcript_text + segments on podcast.recordings.
  * `composite`   — ffmpeg side-by-side of all ready recordings in a session,
                    store under podcast.session_composites.

The byte-wise WebM concat is safe because every batch comes from one browser
`MediaRecorder` session using timeslice: the recorder emits one WebM header
in the first chunk and raw Matroska clusters afterwards. Pause/resume or
multi-session recordings would break this assumption — out of scope.

Run: `python worker/main.py` from the repo root with SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in the environment.
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from supabase import Client, create_client

from sweep import final_path, plan_sweep

BUCKET = "podcast-recordings"
POLL_INTERVAL_SEC = float(os.environ.get("WORKER_POLL_INTERVAL_SEC", "5"))
SWEEP_INTERVAL_SEC = float(os.environ.get("WORKER_SWEEP_INTERVAL_SEC", "60"))
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))

# Transcription knobs
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None  # None = auto-detect
WHISPER_EXPECTED_LANGUAGES = tuple(
    x.strip() for x in os.environ.get("WHISPER_EXPECTED_LANGUAGES", "ar,en").split(",") if x.strip()
)

# Composite knobs — tunable via env
COMPOSITE_WIDTH = int(os.environ.get("COMPOSITE_WIDTH", "1920"))
COMPOSITE_HEIGHT = int(os.environ.get("COMPOSITE_HEIGHT", "1080"))

JOB_TYPES = ("reconstruct", "transcribe", "composite")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("worker")

_stop = False
_whisper_model = None  # lazy-loaded


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
            "transcript_status": "pending",
        }
    ).eq("id", recording_id).execute()
    db.schema("podcast").table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()

    # Auto-enqueue transcription for this recording.
    db.schema("podcast").table("processing_jobs").insert(
        {
            "id": str(uuid4()),
            "recording_id": recording_id,
            "job_type": "transcribe",
            "status": "pending",
            "attempts": 0,
        }
    ).execute()

    log.info(
        "job %s: done — recording %s ready (%d bytes, %ss), transcribe enqueued",
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
# transcribe
# ---------------------------------------------------------------------------

def _load_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel  # heavy import, lazy
        log.info(
            "loading faster-whisper model=%s device=%s compute=%s",
            WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
        )
        _whisper_model = WhisperModel(
            WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE
        )
    return _whisper_model


def _decode_audio_to_f32_mono(path: str, sampling_rate: int = 16000) -> np.ndarray:
    """Decode any media file to float32 mono PCM at `sampling_rate` using ffmpeg.

    Pipes 16-bit little-endian signed PCM to stdout, then rescales to float32
    in [-1.0, 1.0]. Avoids PyAV entirely (the version faster-whisper bundles
    uses a kwarg that av 19 removed)."""
    cmd = [
        _ffmpeg_bin(), "-nostdin", "-threads", "0",
        "-i", path,
        "-f", "s16le",
        "-ac", "1",
        "-ar", str(sampling_rate),
        "-acodec", "pcm_s16le",
        "-loglevel", "error",
        "-",
    ]
    r = subprocess.run(cmd, capture_output=True, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg audio decode failed: {r.stderr.decode(errors='replace')[-500:]}")
    arr = np.frombuffer(r.stdout, dtype=np.int16)
    return arr.astype(np.float32) / 32768.0


def process_transcribe(db: Client, job: dict) -> None:
    recording_id = job["recording_id"]
    log.info("job %s: transcribing recording %s", job["id"], recording_id)

    recording = (
        db.schema("podcast").table("recordings")
        .select("final_storage_path, transcript_status")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    final_path = recording.data.get("final_storage_path")
    if not final_path:
        raise RuntimeError(f"recording {recording_id} has no final_storage_path")

    db.schema("podcast").table("recordings").update(
        {"transcript_status": "processing", "transcript_error": None}
    ).eq("id", recording_id).execute()

    # Download the reconstructed file to a temp path.
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as out:
        tmp_path = out.name
        data = db.storage.from_(BUCKET).download(final_path)
        out.write(data)

    try:
        # faster-whisper 1.2.1 relies on PyAV with a kwarg that av 19 removed,
        # so we decode to 16 kHz mono PCM via ffmpeg ourselves and feed the
        # numpy array directly — bypasses faster-whisper.audio.decode_audio.
        audio = _decode_audio_to_f32_mono(tmp_path, sampling_rate=16000)
        model = _load_whisper()

        def run(language: str | None):
            return model.transcribe(
                audio,
                language=language,
                vad_filter=True,
                beam_size=1,
                word_timestamps=True,
            )

        segments_iter, info = run(WHISPER_LANGUAGE)
        # Auto-detect misfires on short or quiet clips (a 10s Arabic take came
        # back as Kannada). Outside the expected languages, redo in the first.
        if not WHISPER_LANGUAGE and info.language not in WHISPER_EXPECTED_LANGUAGES:
            log.info("job %s: detected %s (p=%.2f), retrying as %s", job["id"],
                     info.language, info.language_probability, WHISPER_EXPECTED_LANGUAGES[0])
            segments_iter, info = run(WHISPER_EXPECTED_LANGUAGES[0])
        segments = []
        parts: list[str] = []
        for seg in segments_iter:
            segments.append(
                {
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text,
                    # Short keys: one entry per word adds up over an hour.
                    "words": [
                        {"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word}
                        for w in (seg.words or [])
                    ],
                }
            )
            parts.append(seg.text)
        full_text = "".join(parts).strip()

        db.schema("podcast").table("recordings").update(
            {
                "transcript_status": "ready",
                "transcript_language": info.language,
                "transcript_text": full_text,
                "transcript_segments": segments,
                "transcript_error": None,
                "updated_at": _now_iso(),
            }
        ).eq("id", recording_id).execute()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    db.schema("podcast").table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()
    log.info(
        "job %s: transcription done — recording %s lang=%s chars=%d",
        job["id"], recording_id, info.language, len(full_text),
    )


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

    # Collect ready recordings for this session, oldest first — stable ordering.
    recordings = (
        db.schema("podcast").table("recordings")
        .select("id, participant_id, final_storage_path, created_at")
        .eq("session_id", session_id)
        .eq("status", "ready")
        .order("created_at")
        .execute()
    )
    if not recordings.data:
        raise RuntimeError(f"no ready recordings for session {session_id}")

    tmpdir = Path(tempfile.mkdtemp(prefix="composite-"))
    takes: list[Take] = []
    try:
        t0 = min(_parse_ts(r["created_at"]) for r in recordings.data)
        for i, r in enumerate(recordings.data):
            fp = r.get("final_storage_path")
            if not fp:
                continue
            raw = tmpdir / f"input-{i:02d}.webm"
            raw.write_bytes(db.storage.from_(BUCKET).download(fp))
            path, duration = _remux_with_index(raw, tmpdir / f"input-{i:02d}-indexed.webm")
            if not duration:
                log.warning("skipping recording %s: unreadable duration", r["id"])
                continue
            takes.append(Take(
                path=path,
                participant_id=r["participant_id"],
                offset=(_parse_ts(r["created_at"]) - t0).total_seconds(),
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
# Failure handling + main loop
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# sweeper — close takes whose browser vanished (see sweep.py)
# ---------------------------------------------------------------------------

def sweep_abandoned(db: Client) -> None:
    pg = db.schema("podcast")
    open_takes = (
        pg.table("recordings")
        .select("id, session_id, participant_id, status, created_at")
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
    elif jt == "transcribe" and job.get("recording_id"):
        db.schema("podcast").table("recordings").update(
            {"transcript_status": "error", "transcript_error": message}
        ).eq("id", job["recording_id"]).execute()
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
            elif jt == "transcribe":
                process_transcribe(db, job)
            elif jt == "composite":
                process_composite(db, job)
            else:
                raise RuntimeError(f"unknown job_type: {jt}")
        except Exception as e:
            fail_job(db, job, e)

    log.info("worker stopped")


if __name__ == "__main__":
    main()
