from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import create_client

from app.config import settings
from app.dependencies import get_current_user
from app.services.storage import (
    create_signed_download_url,
    get_final_path,
    get_upload_path,
    remove_prefix,
)

router = APIRouter(prefix="/api/v1", tags=["recordings"])


def _get_db():
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


class StartRecordingRequest(BaseModel):
    mime_type: str
    actual_width: int
    actual_height: int
    fps: float


class StartRecordingResponse(BaseModel):
    recording_id: str
    session_id: str
    participant_id: str
    status: str


@router.post(
    "/sessions/{session_id}/recordings",
    response_model=StartRecordingResponse,
    status_code=201,
)
async def start_recording(
    session_id: str,
    body: StartRecordingRequest,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    # An ended session shouldn't accept new recordings — if the client raced
    # a stop against a late start() call, we'd otherwise orphan a recording
    # row with no way to hit /finalize.
    session = (
        db.table("podcast_sessions")
        .select("status")
        .eq("id", session_id)
        .single()
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.data["status"] == "ended":
        raise HTTPException(status_code=400, detail="Session has ended")

    participant = (
        db.table("podcast_participants")
        .select("id")
        .eq("session_id", session_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not participant.data:
        raise HTTPException(status_code=403, detail="Not a participant of this session")

    participant_id = participant.data["id"]
    recording_id = str(uuid4())

    db.table("podcast_recordings").insert(
        {
            "id": recording_id,
            "session_id": session_id,
            "participant_id": participant_id,
            "mime_type": body.mime_type,
            "actual_width": body.actual_width,
            "actual_height": body.actual_height,
            "fps": body.fps,
            "status": "recording",
        }
    ).execute()

    return StartRecordingResponse(
        recording_id=recording_id,
        session_id=session_id,
        participant_id=participant_id,
        status="recording",
    )


class RegisterBatchRequest(BaseModel):
    sequence_number: int
    byte_size: int
    checksum: str | None = None


class RegisterBatchResponse(BaseModel):
    batch_id: str
    storage_path: str


@router.post(
    "/recordings/{recording_id}/batches",
    response_model=RegisterBatchResponse,
    status_code=201,
)
async def register_batch(
    recording_id: str,
    body: RegisterBatchRequest,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select("*, podcast_participants!inner(user_id, session_id)")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")

    if recording.data["podcast_participants"]["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Not your recording")

    session_id = recording.data["session_id"]
    participant_id = recording.data["participant_id"]

    storage_path = get_upload_path(
        session_id, participant_id, recording_id, body.sequence_number
    )

    # Idempotent register: the frontend retries whole-batch registration on
    # transient failures (TUS network blip, etc.), so a second POST for the
    # same (recording_id, sequence_number) must return the existing row
    # instead of hitting the unique-key violation (500).
    existing = (
        db.table("recording_batches")
        .select("id, storage_path")
        .eq("recording_id", recording_id)
        .eq("sequence_number", body.sequence_number)
        .maybe_single()
        .execute()
    )
    if existing and existing.data:
        return RegisterBatchResponse(
            batch_id=existing.data["id"],
            storage_path=existing.data["storage_path"],
        )

    batch_id = str(uuid4())
    db.table("recording_batches").insert(
        {
            "id": batch_id,
            "recording_id": recording_id,
            "sequence_number": body.sequence_number,
            "storage_path": storage_path,
            "byte_size": body.byte_size,
            "checksum": body.checksum,
            "upload_status": "pending",
        }
    ).execute()

    return RegisterBatchResponse(batch_id=batch_id, storage_path=storage_path)


@router.post("/recordings/{recording_id}/batches/{batch_id}/complete")
async def complete_batch(
    recording_id: str,
    batch_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    db.table("recording_batches").update({"upload_status": "uploaded"}).eq(
        "id", batch_id
    ).eq("recording_id", recording_id).execute()

    return {"status": "ok"}


@router.post("/recordings/{recording_id}/finalize")
async def finalize_recording(
    recording_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select("*, podcast_participants!inner(user_id, session_id)")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")
    if recording.data["podcast_participants"]["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Not your recording")

    pending = (
        db.table("recording_batches")
        .select("id", count="exact")
        .eq("recording_id", recording_id)
        .neq("upload_status", "uploaded")
        .execute()
    )
    if pending.count and pending.count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"{pending.count} batch(es) not yet uploaded",
        )

    session_id = recording.data["session_id"]
    participant_id = recording.data["participant_id"]
    final_path = get_final_path(session_id, participant_id, recording_id)

    db.table("podcast_recordings").update(
        {"status": "uploaded", "final_storage_path": final_path}
    ).eq("id", recording_id).execute()

    db.table("processing_jobs").insert(
        {
            "id": str(uuid4()),
            "recording_id": recording_id,
            "job_type": "reconstruct",
            "status": "pending",
            "attempts": 0,
        }
    ).execute()

    return {"status": "queued", "recording_id": recording_id}


@router.delete("/recordings/{recording_id}", status_code=204)
async def delete_recording(
    recording_id: str,
    user_id: str = Depends(get_current_user),
):
    """Owner or the recording's own participant can delete. Removes every
    storage object under the recording's prefix, cascades-deletes
    recording_batches / processing_jobs via FK, then drops the row."""
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select("session_id, participant_id, podcast_participants!inner(user_id)")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")

    session_owner = (
        db.table("podcast_sessions")
        .select("owner_id")
        .eq("id", recording.data["session_id"])
        .single()
        .execute()
    )
    is_owner = session_owner.data and session_owner.data["owner_id"] == user_id
    is_participant = recording.data["podcast_participants"]["user_id"] == user_id
    if not is_owner and not is_participant:
        raise HTTPException(status_code=403, detail="Access denied")

    session_id = recording.data["session_id"]
    participant_id = recording.data["participant_id"]
    prefix = (
        f"sessions/{session_id}/participants/{participant_id}"
        f"/recording-{recording_id}"
    )
    remove_prefix(prefix)

    db.table("podcast_recordings").delete().eq("id", recording_id).execute()


@router.get("/recordings/{recording_id}/download")
async def download_recording(
    recording_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select("*, podcast_participants!inner(user_id, session_id)")
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")

    session_owner = (
        db.table("podcast_sessions")
        .select("owner_id")
        .eq("id", recording.data["session_id"])
        .single()
        .execute()
    )

    is_owner = session_owner.data and session_owner.data["owner_id"] == user_id
    is_participant = recording.data["podcast_participants"]["user_id"] == user_id

    if not is_owner and not is_participant:
        raise HTTPException(status_code=403, detail="Access denied")

    if not recording.data.get("final_storage_path"):
        raise HTTPException(status_code=400, detail="Recording not yet processed")

    url = create_signed_download_url(recording.data["final_storage_path"])
    return {"download_url": url}


class TranscriptResponse(BaseModel):
    recording_id: str
    status: str
    language: str | None = None
    text: str | None = None
    segments: list[dict] | None = None
    error: str | None = None


@router.get("/recordings/{recording_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(
    recording_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select(
            "transcript_status, transcript_language, transcript_text, "
            "transcript_segments, transcript_error, session_id, "
            "podcast_participants!inner(user_id)"
        )
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")

    session_owner = (
        db.table("podcast_sessions")
        .select("owner_id")
        .eq("id", recording.data["session_id"])
        .single()
        .execute()
    )
    is_owner = session_owner.data and session_owner.data["owner_id"] == user_id
    is_participant = recording.data["podcast_participants"]["user_id"] == user_id
    if not is_owner and not is_participant:
        raise HTTPException(status_code=403, detail="Access denied")

    return TranscriptResponse(
        recording_id=recording_id,
        status=recording.data.get("transcript_status") or "none",
        language=recording.data.get("transcript_language"),
        text=recording.data.get("transcript_text"),
        segments=recording.data.get("transcript_segments"),
        error=recording.data.get("transcript_error"),
    )


class RetryTranscribeResponse(BaseModel):
    status: str
    recording_id: str


@router.post(
    "/recordings/{recording_id}/transcribe",
    response_model=RetryTranscribeResponse,
)
async def retry_transcribe(
    recording_id: str,
    user_id: str = Depends(get_current_user),
):
    """Owner or participant can re-enqueue transcription (after an error, or to redo)."""
    db = _get_db()

    recording = (
        db.table("podcast_recordings")
        .select(
            "final_storage_path, session_id, "
            "podcast_participants!inner(user_id)"
        )
        .eq("id", recording_id)
        .single()
        .execute()
    )
    if not recording.data:
        raise HTTPException(status_code=404, detail="Recording not found")

    session_owner = (
        db.table("podcast_sessions")
        .select("owner_id")
        .eq("id", recording.data["session_id"])
        .single()
        .execute()
    )
    is_owner = session_owner.data and session_owner.data["owner_id"] == user_id
    is_participant = recording.data["podcast_participants"]["user_id"] == user_id
    if not is_owner and not is_participant:
        raise HTTPException(status_code=403, detail="Access denied")

    if not recording.data.get("final_storage_path"):
        raise HTTPException(status_code=400, detail="Recording not yet processed")

    db.table("podcast_recordings").update(
        {"transcript_status": "pending", "transcript_error": None}
    ).eq("id", recording_id).execute()

    db.table("processing_jobs").insert(
        {
            "id": str(uuid4()),
            "recording_id": recording_id,
            "job_type": "transcribe",
            "status": "pending",
            "attempts": 0,
        }
    ).execute()

    return RetryTranscribeResponse(status="queued", recording_id=recording_id)
