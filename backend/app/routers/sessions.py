from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import create_client

from app.config import settings
from app.dependencies import get_current_user, get_host_user
from app.services import livekit
from app.services.sources import choose_sources, summarize_people
from app.services.storage import create_signed_download_url, remove_prefix

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


def _get_db():
    # All podcast tables live in a dedicated `podcast` schema, isolated from
    # the shared Supabase `public` schema. .schema() returns a sub-client
    # scoped to that schema; subsequent .table() calls hit podcast.<name>.
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key
    ).schema("podcast")


class CreateSessionRequest(BaseModel):
    title: str


class CreateSessionResponse(BaseModel):
    session_id: str
    title: str
    room_name: str
    livekit_url: str


@router.post("", response_model=CreateSessionResponse, status_code=201)
async def create_session(
    body: CreateSessionRequest,
    # Host-only: anonymous magic-link guests must not be able to spin up
    # their own sessions and hand out invites — the whole point of the
    # magic-link model is that only one account creates rooms.
    user_id: str = Depends(get_host_user),
):
    db = _get_db()

    session_id = str(uuid4())
    if livekit.is_configured():
        room_name = livekit.new_room_name()
        url = settings.livekit_url
    else:
        room_name, url = f"local-{session_id}", ""

    db.table("sessions").insert(
        {
            "id": session_id,
            "owner_id": user_id,
            "title": body.title,
            "room_name": room_name,
            "status": "created",
        }
    ).execute()

    participant_id = str(uuid4())
    db.table("participants").insert(
        {
            "id": participant_id,
            "session_id": session_id,
            "user_id": user_id,
            "display_name": "Host",
            "role": "host",
        }
    ).execute()

    return CreateSessionResponse(
        session_id=session_id,
        title=body.title,
        room_name=room_name,
        livekit_url=url,
    )


class JoinSessionResponse(BaseModel):
    participant_id: str
    livekit_token: str
    livekit_url: str
    room_name: str
    is_host: bool = False


@router.post("/{session_id}/join", response_model=JoinSessionResponse)
async def join_session(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    session = (
        db.table("sessions")
        .select("*")
        .eq("id", session_id)
        .single()
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")

    session_data = session.data
    if session_data["status"] == "ended":
        raise HTTPException(status_code=400, detail="Session has ended")

    # First successful join flips the session from "created" to "active" so
    # the home-page badge reflects reality.
    if session_data["status"] == "created":
        db.table("sessions").update(
            {
                "status": "active",
                "started_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", session_id).execute()

    # supabase-py returns None from `.maybe_single().execute()` when no row
    # matches (not an object with `.data = None`), so guard both.
    existing = (
        db.table("participants")
        .select("*")
        .eq("session_id", session_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    if existing and existing.data:
        participant_id = existing.data["id"]
        display_name = existing.data["display_name"]
        is_owner = existing.data["role"] == "host"
    else:
        participant_count = (
            db.table("participants")
            .select("id", count="exact")
            .eq("session_id", session_id)
            .execute()
        )
        if participant_count.count and participant_count.count >= 4:
            raise HTTPException(status_code=400, detail="Room is full (max 4)")

        participant_id = str(uuid4())
        display_name = "Guest"
        is_owner = False
        db.table("participants").insert(
            {
                "id": participant_id,
                "session_id": session_id,
                "user_id": user_id,
                "display_name": display_name,
                "role": "guest",
            }
        ).execute()

    room_name = session_data["room_name"]
    if livekit.is_configured() and not room_name.startswith("local-"):
        token = livekit.create_access_token(
            room_name=room_name,
            identity=participant_id,
            display_name=display_name,
            is_owner=is_owner,
        )
        url = settings.livekit_url
    else:
        token, url = "", ""

    return JoinSessionResponse(
        participant_id=participant_id,
        livekit_token=token,
        livekit_url=url,
        room_name=room_name,
        is_host=is_owner,
    )


class RoomRecordingRequest(BaseModel):
    recording: bool


class RoomRecordingResponse(BaseModel):
    recording: bool
    run: str | None = None


@router.post("/{session_id}/recording", response_model=RoomRecordingResponse)
async def set_room_recording(
    session_id: str,
    body: RoomRecordingRequest,
    user_id: str = Depends(get_current_user),
):
    """Host-only: turn recording on/off for everyone in the room. Each
    client watches the room metadata and starts/stops its own recorder."""
    db = _get_db()
    _owner_only(db, session_id, user_id)
    room = (
        db.table("sessions").select("room_name").eq("id", session_id).single().execute()
    )
    room_name = room.data["room_name"]
    if not livekit.is_configured() or room_name.startswith("local-"):
        raise HTTPException(status_code=409, detail="Live call isn't configured for this session")
    try:
        meta = await livekit.set_room_recording(room_name, body.recording)
    except Exception as e:  # LiveKit TwirpError when the room isn't live
        raise HTTPException(
            status_code=409, detail=f"Couldn't reach the call room: {e}"
        ) from e
    # The worker's reconcile loop follows this column to start and stop each
    # person's server recording copy (LiveKit egress).
    db.table("sessions").update({"recording_run": meta["run"]}).eq(
        "id", session_id
    ).execute()
    return RoomRecordingResponse(recording=meta["recording"], run=meta["run"])


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    """Owner-only. Removes all storage objects under the session, then the
    row — FKs cascade the recordings, participants and jobs."""
    db = _get_db()
    _owner_only(db, session_id, user_id)

    remove_prefix(f"sessions/{session_id}")
    db.table("sessions").delete().eq("id", session_id).execute()


class SessionStatusResponse(BaseModel):
    session_id: str
    title: str
    status: str
    room_name: str | None
    participants: list[dict]


@router.get("/{session_id}", response_model=SessionStatusResponse)
async def get_session(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    session = (
        db.table("sessions")
        .select("*")
        .eq("id", session_id)
        .single()
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")

    participants = (
        db.table("participants")
        .select("id, display_name, role, joined_at, left_at")
        .eq("session_id", session_id)
        .execute()
    )

    return SessionStatusResponse(
        session_id=session.data["id"],
        title=session.data["title"],
        status=session.data["status"],
        room_name=session.data["room_name"],
        participants=participants.data or [],
    )


class PersonSource(BaseModel):
    participant_id: str
    role: str
    source: str  # hq | server | none — what the composite will use
    hq_ready: int
    hq_total: int
    server_ready: int


class CompositeStatusResponse(BaseModel):
    session_id: str
    status: str  # one of: none | pending | processing | ready | error
    final_storage_path: str | None = None
    download_url: str | None = None
    total_bytes: int | None = None
    duration_seconds: float | None = None
    error: str | None = None
    ready_recordings: int = 0
    total_recordings: int = 0
    people: list[PersonSource] = []


def _owner_only(db, session_id: str, user_id: str) -> None:
    session = (
        db.table("sessions")
        .select("owner_id")
        .eq("id", session_id)
        .maybe_single()
        .execute()
    )
    # .single() raises PGRST116 (→ 500) on an unknown id; maybe_single()
    # returns None or an empty result instead.
    if not session or not session.data:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.data["owner_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the session owner can do this")


def _composite_row(db, session_id: str):
    r = (
        db.table("session_composites")
        .select("*")
        .eq("session_id", session_id)
        .maybe_single()
        .execute()
    )
    return r.data if r else None


def _session_sources(db, session_id: str) -> tuple[list[dict], list[dict], list[dict]]:
    """(takes, server copies, chosen) — chosen per person by sources.py: the
    HQ takes once all of a run's have arrived, else the server copy."""
    takes = (
        db.table("recordings")
        .select("id, participant_id, run, status, created_at, final_storage_path")
        .eq("session_id", session_id)
        .execute()
    ).data or []
    copies = (
        db.table("server_copies")
        .select("id, participant_id, run, status, started_at, created_at, storage_path")
        .eq("session_id", session_id)
        .execute()
    ).data or []
    return takes, copies, choose_sources(takes, copies)


def _count_recordings(db, session_id: str) -> tuple[int, int]:
    """(files the composite would use, HQ takes in the session)."""
    takes, _copies, chosen = _session_sources(db, session_id)
    return len(chosen), len(takes)


def _people(db, session_id: str) -> list[PersonSource]:
    takes, copies, _chosen = _session_sources(db, session_id)
    roles = {
        p["id"]: p["role"]
        for p in (
            db.table("participants").select("id, role").eq("session_id", session_id).execute()
        ).data or []
    }
    summary = summarize_people(takes, copies)
    return [
        PersonSource(participant_id=pid, role=roles.get(pid, "guest"), **info)
        for pid, info in sorted(summary.items(), key=lambda kv: roles.get(kv[0]) != "host")
    ]


@router.get("/{session_id}/composite", response_model=CompositeStatusResponse)
async def get_composite(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()
    _owner_only(db, session_id, user_id)

    row = _composite_row(db, session_id)
    ready, total = _count_recordings(db, session_id)
    people = _people(db, session_id)

    if not row:
        return CompositeStatusResponse(
            session_id=session_id,
            status="none",
            ready_recordings=ready,
            total_recordings=total,
            people=people,
        )

    download_url = None
    if row["status"] == "ready" and row.get("final_storage_path"):
        download_url = create_signed_download_url(row["final_storage_path"])

    return CompositeStatusResponse(
        session_id=session_id,
        status=row["status"],
        final_storage_path=row.get("final_storage_path"),
        download_url=download_url,
        total_bytes=row.get("total_bytes"),
        duration_seconds=row.get("duration_seconds"),
        error=row.get("error_message"),
        ready_recordings=ready,
        total_recordings=total,
        people=people,
    )


class RenderCompositeResponse(BaseModel):
    status: str
    session_id: str


@router.post(
    "/{session_id}/composite",
    response_model=RenderCompositeResponse,
    status_code=202,
)
async def render_composite(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()
    _owner_only(db, session_id, user_id)

    ready, total = _count_recordings(db, session_id)
    if ready < 1:
        raise HTTPException(
            status_code=400,
            detail=f"Session has no ready recordings yet ({ready}/{total}).",
        )

    existing = _composite_row(db, session_id)
    if existing and existing["status"] == "processing":
        raise HTTPException(status_code=409, detail="Composite already in progress")

    now = {"updated_at": None}  # placeholder, Postgres default on insert
    if existing:
        db.table("session_composites").update(
            {
                "status": "pending",
                "error_message": None,
                "final_storage_path": None,
                "total_bytes": None,
            }
        ).eq("session_id", session_id).execute()
    else:
        db.table("session_composites").insert(
            {
                "id": str(uuid4()),
                "session_id": session_id,
                "status": "pending",
                "layout": "hstack",
            }
        ).execute()

    db.table("processing_jobs").insert(
        {
            "id": str(uuid4()),
            "session_id": session_id,
            "job_type": "composite",
            "status": "pending",
            "attempts": 0,
        }
    ).execute()

    return RenderCompositeResponse(status="queued", session_id=session_id)
