import logging
import traceback

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.ratelimit import rate_limit_middleware
from app.routers import recordings, sessions
from app.services import livekit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Sentry — gated on SENTRY_DSN. When the env var is empty we skip init
# entirely; the SDK then has no handler installed and `capture_exception`
# calls become no-ops, so leaving it off in dev costs nothing.
if settings.sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        sentry_sdk.init(
            dsn=settings.sentry_dsn,
            environment=settings.sentry_environment,
            # Errors only — perf traces inflate the event bill and we have no
            # tracing UI set up yet. Flip on when we need it.
            traces_sample_rate=0.0,
            # Don't send request bodies / query params / cookies — they can
            # carry JWTs and user ids we treat as PII.
            send_default_pii=False,
            integrations=[FastApiIntegration(), StarletteIntegration()],
        )
        logger.info("Sentry initialized (env=%s)", settings.sentry_environment)
    except Exception as e:  # pragma: no cover
        # A bad DSN or a packaging mismatch shouldn't take down the API.
        logger.warning("Sentry init failed, continuing without it: %s", e)

app = FastAPI(title="Podcast Studio API", version="0.1.0")

# Per-IP sliding-window rate limiter. Keep ahead of every other middleware
# so an abusive client doesn't get past the budget by cooking a CORS probe.
app.middleware("http")(rate_limit_middleware)


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
    # role key. A HEAD against any table in the podcast schema is cheap and
    # also confirms PGRST_DB_SCHEMAS exposes the schema correctly.
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.head(
                f"{settings.supabase_url}/rest/v1/sessions",
                headers={
                    "apikey": settings.supabase_service_role_key,
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                    "Accept-Profile": "podcast",
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
