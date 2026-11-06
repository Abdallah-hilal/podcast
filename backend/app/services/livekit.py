"""
LiveKit integration — self-hosted WebRTC SFU replacing Daily.co.

The LiveKit server runs in docker-compose on the shared Contabo VPS and
auto-creates rooms when a participant joins with a valid access token, so
this module only needs to mint JWTs. Room naming, token identity and grants
are the only decisions here.
"""

from __future__ import annotations

from datetime import timedelta
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
