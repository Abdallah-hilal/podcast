import logging

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])

logger = logging.getLogger(__name__)


@router.post("/daily")
async def daily_webhook(request: Request):
    """Stub: receives Daily webhooks. Full implementation in Phase 1."""
    body = await request.json()
    logger.info("Daily webhook received: %s", body.get("type", "unknown"))
    return {"status": "ok"}
