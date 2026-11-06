from supabase import create_client

from app.config import settings

_supabase = None


def _get_supabase():
    global _supabase
    if _supabase is None:
        _supabase = create_client(
            settings.supabase_url, settings.supabase_service_role_key
        )
    return _supabase


BUCKET = "podcast-recordings"


def get_upload_path(
    session_id: str,
    participant_id: str,
    recording_id: str,
    sequence_number: int,
) -> str:
    """Compute the storage path for a recording batch."""
    return (
        f"sessions/{session_id}/participants/{participant_id}"
        f"/recording-{recording_id}/chunks/batch-{sequence_number:04d}.bin"
    )


def get_final_path(
    session_id: str, participant_id: str, recording_id: str
) -> str:
    """Compute the storage path for the final assembled recording."""
    return (
        f"sessions/{session_id}/participants/{participant_id}"
        f"/recording-{recording_id}/original.webm"
    )


def create_signed_upload_url(path: str) -> str:
    """Create a signed upload URL for the given storage path."""
    result = _get_supabase().storage.from_(BUCKET).create_signed_upload_url(path)
    return result["signed_url"]


def create_signed_download_url(path: str, expires_in: int = 3600) -> str:
    """Create a signed download URL for the given storage path."""
    result = _get_supabase().storage.from_(BUCKET).create_signed_url(
        path, expires_in
    )
    return result["signedURL"]
