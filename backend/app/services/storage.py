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


def get_composite_path(session_id: str) -> str:
    """Compute the storage path for a session's composite render."""
    return f"sessions/{session_id}/composite/final.webm"


def create_signed_download_url(path: str, expires_in: int = 3600) -> str:
    """Create a signed download URL for the given storage path."""
    result = _get_supabase().storage.from_(BUCKET).create_signed_url(
        path, expires_in
    )
    return result["signedURL"]


def _is_folder(entry: dict) -> bool:
    # Supabase storage3 marks folders by returning id=None (they're not real
    # DB rows, just path prefixes synthesized from object keys).
    return entry.get("id") is None


def _list_all_under(prefix: str) -> list[str]:
    """Recursively walk every file under `prefix` and return their full paths."""
    storage = _get_supabase().storage.from_(BUCKET)
    out: list[str] = []
    stack = [prefix.rstrip("/")]
    while stack:
        current = stack.pop()
        entries = storage.list(path=current) or []
        for entry in entries:
            name = entry.get("name")
            if not name:
                continue
            full = f"{current}/{name}" if current else name
            if _is_folder(entry):
                stack.append(full)
            else:
                out.append(full)
    return out


def remove_prefix(prefix: str) -> int:
    """Delete every object under `prefix`. Returns the count removed."""
    paths = _list_all_under(prefix)
    if not paths:
        return 0
    # Supabase storage caps a single remove call at ~1000 keys; chunk for
    # safety even though our recordings won't typically hit that.
    chunk = 500
    for i in range(0, len(paths), chunk):
        _get_supabase().storage.from_(BUCKET).remove(paths[i : i + chunk])
    return len(paths)
