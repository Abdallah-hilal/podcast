"""Tiny in-memory sliding-window rate limiter.

Keyed on the client IP (behind nginx, we honor `X-Forwarded-For`'s left-most
hop). State lives in a dict in the running process — fine for the single
backend container we deploy today; if you ever run >1 instance, swap this
for Redis before the per-process counters diverge.

Excluded paths: `/health` and `/ready` so a liveness/readiness probe
doesn't eat the budget.
"""

import time
from collections import defaultdict, deque
from typing import Awaitable, Callable

from fastapi import Request
from fastapi.responses import JSONResponse, Response

_WINDOW_SEC = 60
_MAX_REQUESTS = 120  # per IP per window
_EXEMPT_PATHS = {"/health", "/ready"}


class _SlidingWindow:
    def __init__(self, window_sec: int, max_requests: int):
        self.window = window_sec
        self.limit = max_requests
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self.hits[key]
        cutoff = now - self.window
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


_limiter = _SlidingWindow(_WINDOW_SEC, _MAX_REQUESTS)


def _client_ip(request: Request) -> str:
    # nginx sets X-Forwarded-For; take the left-most hop which is the real
    # client. Fall back to the direct peer if the header's missing.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        first = fwd.split(",", 1)[0].strip()
        if first:
            return first
    if request.client:
        return request.client.host
    return "unknown"


async def rate_limit_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    if request.url.path in _EXEMPT_PATHS:
        return await call_next(request)
    ip = _client_ip(request)
    if not _limiter.allow(ip):
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests, slow down."},
            headers={"Retry-After": str(_WINDOW_SEC)},
        )
    return await call_next(request)
