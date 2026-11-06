from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from supabase import create_client

from app.config import settings
from app.dependencies import get_current_user
from app.services import daily

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


def _get_db():
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


class CreateSessionRequest(BaseModel):
    title: str


class CreateSessionResponse(BaseModel):
    session_id: str
    title: str
    daily_room_name: str
    daily_room_url: str


@router.post("", response_model=CreateSessionResponse, status_code=201)
async def create_session(
    body: CreateSessionRequest,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    room = await daily.create_room(body.title)

    session_id = str(uuid4())
    db.table("podcast_sessions").insert(
        {
            "id": session_id,
            "owner_id": user_id,
            "title": body.title,
            "daily_room_name": room["name"],
            "status": "created",
        }
    ).execute()

    participant_id = str(uuid4())
    db.table("podcast_participants").insert(
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
        daily_room_name=room["name"],
        daily_room_url=room["url"],
    )


class JoinSessionResponse(BaseModel):
    participant_id: str
    daily_token: str
    daily_room_url: str
    daily_room_name: str


@router.post("/{session_id}/join", response_model=JoinSessionResponse)
async def join_session(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    session = (
        db.table("podcast_sessions")
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

    existing = (
        db.table("podcast_participants")
        .select("*")
        .eq("session_id", session_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    if existing.data:
        participant_id = existing.data["id"]
        display_name = existing.data["display_name"]
        is_owner = existing.data["role"] == "host"
    else:
        participant_count = (
            db.table("podcast_participants")
            .select("id", count="exact")
            .eq("session_id", session_id)
            .execute()
        )
        if participant_count.count and participant_count.count >= 4:
            raise HTTPException(status_code=400, detail="Room is full (max 4)")

        participant_id = str(uuid4())
        display_name = "Guest"
        is_owner = False
        db.table("podcast_participants").insert(
            {
                "id": participant_id,
                "session_id": session_id,
                "user_id": user_id,
                "display_name": display_name,
                "role": "guest",
            }
        ).execute()

    room_name = session_data["daily_room_name"]
    token = await daily.create_meeting_token(room_name, display_name, is_owner)

    daily_domain = settings.daily_api_url.replace("api.", "").replace("/v1", "")
    room_url = f"https://{room_name}.daily.co" if "daily.co" not in room_name else ""
    # Daily room URL format from create_room response
    room_url = f"https://your-domain.daily.co/{room_name}"

    return JoinSessionResponse(
        participant_id=participant_id,
        daily_token=token,
        daily_room_url=room_url,
        daily_room_name=room_name,
    )


class SessionStatusResponse(BaseModel):
    session_id: str
    title: str
    status: str
    daily_room_name: str | None
    participants: list[dict]


@router.get("/{session_id}", response_model=SessionStatusResponse)
async def get_session(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    db = _get_db()

    session = (
        db.table("podcast_sessions")
        .select("*")
        .eq("id", session_id)
        .single()
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")

    participants = (
        db.table("podcast_participants")
        .select("id, display_name, role, joined_at, left_at")
        .eq("session_id", session_id)
        .execute()
    )

    return SessionStatusResponse(
        session_id=session.data["id"],
        title=session.data["title"],
        status=session.data["status"],
        daily_room_name=session.data["daily_room_name"],
        participants=participants.data or [],
    )
