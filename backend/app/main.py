import logging
import traceback

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import recordings, sessions
from app.services import livekit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Podcast Studio API", version="0.1.0")


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Keep the full traceback + exception type in logs, but never send it to
    # the client — `str(exc)` can carry DB column names, file paths, service
    # keys echoed in error messages, etc. The client only needs to know the
    # request failed and give the user a clean message.
    logger.error("Unhandled error on %s %s: %s\n%s",
                 request.method, request.url.path, exc, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(recordings.router)


@app.get("/health")
async def health():
    """Liveness probe — always fast, never touches external services."""
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    """Readiness probe — checks the external dependencies this app needs.
    Returns 200 with per-check details; a failed check sets ok=False and
    status=503 so a load balancer can keep the pod out of rotation."""

    checks: dict[str, dict[str, object]] = {}

    # Supabase REST endpoint should answer anything that touches the service
    # role key. A HEAD against any table is cheap and auth-gated.
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.head(
                f"{settings.supabase_url}/rest/v1/podcast_sessions",
                headers={
                    "apikey": settings.supabase_service_role_key,
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                    "Range": "0-0",
                },
            )
        checks["supabase"] = {
            "ok": r.status_code < 500,
            "status_code": r.status_code,
        }
    except Exception as e:
        checks["supabase"] = {"ok": False, "error": str(e)}

    # LiveKit is optional (local-only mode). Report whether it's configured —
    # a missing LIVEKIT_URL is OK, not broken.
    checks["livekit"] = {
        "ok": True,
        "configured": livekit.is_configured(),
        "url": settings.livekit_url or None,
    }

    cors_origins = [o for o in settings.cors_origins.split(",") if o]
    checks["cors"] = {"ok": bool(cors_origins), "origins": cors_origins}

    all_ok = all(c["ok"] for c in checks.values())
    body = {"ok": all_ok, "checks": checks}
    return JSONResponse(status_code=200 if all_ok else 503, content=body)
