from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import settings

security = HTTPBearer()


def _decode(token: str) -> dict:
    try:
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
        )


async def get_token_payload(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Decoded Supabase JWT payload. Used by the other deps below; most
    handlers don't need the full payload, just the user id."""
    payload = _decode(credentials.credentials)
    if not payload.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing sub claim",
        )
    return payload


async def get_current_user(
    payload: dict = Depends(get_token_payload),
) -> str:
    """Any authenticated user — host or anonymous guest. Use this for
    endpoints a magic-link guest legitimately needs (joining, recording
    their own side)."""
    return payload["sub"]


async def get_host_user(
    payload: dict = Depends(get_token_payload),
) -> str:
    """Admin / host-only: rejects anonymous guests. Supabase anon users have
    `is_anonymous: true` in their JWT (and provider == "anonymous" in
    app_metadata on older stacks). Blocking anonymous tokens keeps a guest
    who was handed a magic link from turning around and creating their own
    sessions, deleting the host's, or kicking off a composite render."""
    if _is_anonymous(payload):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the host account can do this. Sign in with the host's email.",
        )
    return payload["sub"]


def _is_anonymous(payload: dict) -> bool:
    if payload.get("is_anonymous") is True:
        return True
    app_meta = payload.get("app_metadata") or {}
    if app_meta.get("provider") == "anonymous":
        return True
    providers = app_meta.get("providers")
    if isinstance(providers, list) and providers == ["anonymous"]:
        return True
    return False
