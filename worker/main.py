"""
Processing worker for podcast recordings.

Polls the `processing_jobs` table for pending `reconstruct` jobs. For each
claimed job it downloads every batch for the recording (in sequence order),
concatenates them byte-wise into a single WebM file, uploads the result to
the recording's `final_storage_path`, and flips the recording to `ready`.

The byte-wise concat is safe because every batch comes from one browser
`MediaRecorder` session using timeslice: the recorder emits one WebM header
in the first chunk and raw Matroska clusters afterwards. Concatenating all
bytes in sequence yields a valid playable WebM. Pause/resume or multi-session
recordings would break this assumption — out of scope for this phase.

Run: `python worker/main.py` from the repo root with SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in the environment.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

from supabase import Client, create_client

BUCKET = "podcast-recordings"
POLL_INTERVAL_SEC = float(os.environ.get("WORKER_POLL_INTERVAL_SEC", "5"))
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))

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


def claim_next_job(db: Client) -> dict | None:
    """Find and claim one pending reconstruct job. Returns None if none available."""
    candidates = (
        db.table("processing_jobs")
        .select("*")
        .eq("status", "pending")
        .eq("job_type", "reconstruct")
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
        # Someone else grabbed it between our select and update
        return None
    return claimed.data[0]


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
        {"status": "ready", "total_bytes": total, "updated_at": _now_iso()}
    ).eq("id", recording_id).execute()
    db.table("processing_jobs").update(
        {"status": "completed", "completed_at": _now_iso(), "error_message": None}
    ).eq("id", job["id"]).execute()
    log.info(
        "job %s: done — recording %s is ready (%d bytes)",
        job["id"], recording_id, total,
    )


def fail_job(db: Client, job: dict, err: Exception) -> None:
    attempts = job["attempts"]
    message = f"{type(err).__name__}: {err}"
    log.exception("job %s failed on attempt %d: %s", job["id"], attempts, message)

    if attempts >= MAX_ATTEMPTS:
        db.table("processing_jobs").update(
            {"status": "failed", "error_message": message, "completed_at": _now_iso()}
        ).eq("id", job["id"]).execute()
        db.table("podcast_recordings").update({"status": "error"}).eq(
            "id", job["recording_id"]
        ).execute()
    else:
        db.table("processing_jobs").update(
            {"status": "pending", "error_message": message}
        ).eq("id", job["id"]).execute()


def main() -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db = _get_client()
    log.info(
        "worker started (poll=%.1fs, max_attempts=%d)", POLL_INTERVAL_SEC, MAX_ATTEMPTS
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
            if job["job_type"] == "reconstruct":
                process_reconstruct(db, job)
            else:
                raise RuntimeError(f"unknown job_type: {job['job_type']}")
        except Exception as e:
            fail_job(db, job, e)

    log.info("worker stopped")


if __name__ == "__main__":
    main()
