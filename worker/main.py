"""
Processing worker for podcast recordings.

Polls the `processing_jobs` table and dispatches on `job_type`:
  * `reconstruct` — concatenate uploaded batches into a single WebM.
  * `transcribe`  — run faster-whisper on the reconstructed file, store
                    transcript_text + segments on podcast_recordings.
  * `composite`   — ffmpeg side-by-side of all ready recordings in a session,
                    store under podcast_session_composites.

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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from supabase import Client, create_client

BUCKET = "podcast-recordings"
POLL_INTERVAL_SEC = float(os.environ.get("WORKER_POLL_INTERVAL_SEC", "5"))
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))

# Transcription knobs
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None  # None = auto-detect

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
        db.table("processing_jobs")
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
        db.table("processing_jobs")
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
        db.table("podcast_recordings")
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
        db.table("recording_batches")
        .select("sequence_number, storage_path, byte_size")
        .eq("recording_id", recording_id)
        .order("sequence_number")
        .execute()
    )
    if not batches.data:
        raise RuntimeError(f"recording {recording_id} has no batches to reconstruct")

    log.info("job %s: concatenating %d batches", job["id"], len(batches.data))
    total = 0
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as out:
        tmp_path = out.name
        for batch in batches.data:
            data = db.storage.from_(BUCKET).download(batch["storage_path"])
            out.write(data)
            total += len(data)

    try:
        with open(tmp_path, "rb") as f:
            db.storage.from_(BUCKET).upload(
                final_path,
                f,
                {"content-type": "video/webm", "upsert": "true"},
            )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    db.table("podcast_recordings").update(
        {
            "status": "ready",
            "total_bytes": total,
            "updated_at": _now_iso(),
            "transcript_status": "pending",
        }
    ).eq("id", recording_id).execute()
    db.table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()

    # Auto-enqueue transcription for this recording.
    db.table("processing_jobs").insert(
        {
            "id": str(uuid4()),
            "recording_id": recording_id,
            "job_type": "transcribe",
            "status": "pending",
            "attempts": 0,
        }
    ).execute()

    log.info(
        "job %s: done — recording %s ready (%d bytes), transcribe enqueued",
        job["id"], recording_id, total,
    )


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
        db.table("podcast_recordings")
        .select("final_storage_path, transcript_status")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    final_path = recording.data.get("final_storage_path")
    if not final_path:
        raise RuntimeError(f"recording {recording_id} has no final_storage_path")

    db.table("podcast_recordings").update(
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
        segments_iter, info = model.transcribe(
            audio,
            language=WHISPER_LANGUAGE,
            vad_filter=True,
            beam_size=1,
        )
        segments = []
        parts: list[str] = []
        for seg in segments_iter:
            segments.append(
                {
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text,
                }
            )
            parts.append(seg.text)
        full_text = "".join(parts).strip()

        db.table("podcast_recordings").update(
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

    db.table("processing_jobs").update(
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

    db.table("podcast_session_composites").update(
        {"status": "processing", "error_message": None, "updated_at": _now_iso()}
    ).eq("session_id", session_id).execute()

    # Collect ready recordings for this session, oldest first — stable ordering.
    recordings = (
        db.table("podcast_recordings")
        .select("id, final_storage_path, created_at")
        .eq("session_id", session_id)
        .eq("status", "ready")
        .order("created_at")
        .execute()
    )
    if not recordings.data:
        raise RuntimeError(f"no ready recordings for session {session_id}")

    tmpdir = Path(tempfile.mkdtemp(prefix="composite-"))
    local_inputs: list[Path] = []
    try:
        for i, r in enumerate(recordings.data):
            fp = r.get("final_storage_path")
            if not fp:
                continue
            data = db.storage.from_(BUCKET).download(fp)
            path = tmpdir / f"input-{i:02d}.webm"
            path.write_bytes(data)
            local_inputs.append(path)

        if not local_inputs:
            raise RuntimeError(f"session {session_id} has no downloadable recordings")

        out_path = tmpdir / "composite.webm"
        _render_composite(local_inputs, out_path)
        total_bytes = out_path.stat().st_size

        final_path = f"sessions/{session_id}/composite/final.webm"
        with open(out_path, "rb") as f:
            db.storage.from_(BUCKET).upload(
                final_path,
                f,
                {"content-type": "video/webm", "upsert": "true"},
            )

        db.table("podcast_session_composites").update(
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

    db.table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()
    log.info("job %s: composite ready for session %s (%d inputs)", job["id"], session_id, len(local_inputs))


def _render_composite(inputs: list[Path], out: Path) -> None:
    """Render N input WebMs side-by-side at COMPOSITE_WIDTH x COMPOSITE_HEIGHT."""
    n = len(inputs)
    w = COMPOSITE_WIDTH
    h = COMPOSITE_HEIGHT
    if n == 1:
        # Single input — scale and pad to the target size, keeping aspect.
        cmd = [
            _ffmpeg_bin(), "-y",
            "-i", str(inputs[0]),
            "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black",
            "-c:v", "libvpx-vp9", "-b:v", "2M",
            "-c:a", "libopus", "-b:a", "128k",
            str(out),
        ]
    else:
        # Horizontal stack. Each tile gets w/n and the full h.
        tile_w = w // n
        cmd = [_ffmpeg_bin(), "-y"]
        for p in inputs:
            cmd += ["-i", str(p)]
        filter_parts = []
        for i in range(n):
            filter_parts.append(
                f"[{i}:v]scale={tile_w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={tile_w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v{i}]"
            )
        stack_inputs = "".join(f"[v{i}]" for i in range(n))
        filter_parts.append(f"{stack_inputs}hstack=inputs={n}[v]")
        # Mix all audio tracks.
        amix_inputs = "".join(f"[{i}:a]" for i in range(n))
        filter_parts.append(f"{amix_inputs}amix=inputs={n}:duration=longest:dropout_transition=0[a]")
        filter_complex = ";".join(filter_parts)
        cmd += [
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libvpx-vp9", "-b:v", "3M",
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

def fail_job(db: Client, job: dict, err: Exception) -> None:
    attempts = job["attempts"]
    message = f"{type(err).__name__}: {err}"
    log.exception("job %s failed on attempt %d: %s", job["id"], attempts, message)

    final = attempts >= MAX_ATTEMPTS
    db.table("processing_jobs").update(
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
        db.table("podcast_recordings").update({"status": "error"}).eq(
            "id", job["recording_id"]
        ).execute()
    elif jt == "transcribe" and job.get("recording_id"):
        db.table("podcast_recordings").update(
            {"transcript_status": "error", "transcript_error": message}
        ).eq("id", job["recording_id"]).execute()
    elif jt == "composite" and job.get("session_id"):
        db.table("podcast_session_composites").update(
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

    while not _stop:
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
