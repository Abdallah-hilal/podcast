import time
from uuid import uuid4

import httpx

from app.config import settings

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.daily_api_url,
            headers={"Authorization": f"Bearer {settings.daily_api_key}"},
            timeout=15.0,
        )
    return _client


async def create_room(session_title: str) -> dict:
    """Create a private Daily room and return {name, url}."""
    room_name = f"podcast-{uuid4().hex[:12]}"
    exp = int(time.time()) + 7200  # 2 hours

    resp = await _get_client().post(
        "/rooms",
        json={
            "name": room_name,
            "privacy": "private",
            "properties": {
                "max_participants": 4,
                "enable_recording": "local",
                "exp": exp,
                "start_video_off": False,
                "start_audio_off": False,
            },
        },
    )
    resp.raise_for_status()
    data = resp.json()
    return {"name": data["name"], "url": data["url"]}


async def create_meeting_token(
    room_name: str, user_name: str, is_owner: bool = False
) -> str:
    """Create a meeting token scoped to a room."""
    exp = int(time.time()) + 7200

    resp = await _get_client().post(
        "/meeting-tokens",
        json={
            "properties": {
                "room_name": room_name,
                "user_name": user_name,
                "is_owner": is_owner,
                "exp": exp,
            }
        },
    )
    resp.raise_for_status()
    return resp.json()["token"]


async def delete_room(room_name: str) -> None:
    """Delete a Daily room."""
    resp = await _get_client().delete(f"/rooms/{room_name}")
    if resp.status_code != 404:
        resp.raise_for_status()
