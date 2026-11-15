"""
LiveKit integration — self-hosted WebRTC SFU replacing Daily.co.

The LiveKit server runs in docker-compose on the shared Contabo VPS and
auto-creates rooms when a participant joins with a valid access token, so
this module only needs to mint JWTs. Room naming, token identity and grants
are the only decisions here.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from livekit import api

from app.config import settings

TOKEN_TTL = timedelta(hours=6)


def is_configured() -> bool:
    return bool(
        settings.livekit_url
        and settings.livekit_api_key
        and settings.livekit_api_secret
    )


def new_room_name() -> str:
    return f"podcast-{uuid4().hex[:12]}"


def create_access_token(
    room_name: str,
    identity: str,
    display_name: str,
    is_owner: bool,
) -> str:
    """Mint a JWT a browser client uses to join `room_name` on LiveKit."""
    grants = api.VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
        # Lets each client publish its own recording/upload status as
        # participant attributes, which every tile in the room displays.
        can_update_own_metadata=True,
        room_admin=is_owner,
    )
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(display_name)
        .with_grants(grants)
        .with_ttl(TOKEN_TTL)
        .to_jwt()
    )


async def set_room_recording(room_name: str, recording: bool) -> dict:
    """Flip the room-wide recording switch every client follows.

    The switch lives in LiveKit room metadata so it reaches everyone in the
    room instantly and late joiners receive it on connect. A fresh `run` id
    on each start lets a client tell a new run from the one it is already
    recording. Raises if the room isn't live (nobody connected).
    """
    meta = {
        "recording": recording,
        "run": uuid4().hex if recording else None,
        "changed_at": datetime.now(timezone.utc).isoformat(),
    }
    async with api.LiveKitAPI(
        settings.livekit_url, settings.livekit_api_key, settings.livekit_api_secret
    ) as lk:
        await lk.room.update_room_metadata(
            api.UpdateRoomMetadataRequest(room=room_name, metadata=json.dumps(meta))
        )
    return meta
