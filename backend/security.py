from __future__ import annotations

import os
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Header, HTTPException, Request


_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR.parent / ".env", override=False)
load_dotenv(_BACKEND_DIR / ".env", override=False)

_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)


def _setting(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _is_production() -> bool:
    return _setting("APP_ENV", "local").lower() == "production"


def _rate_limit_per_hour() -> int:
    try:
        return max(0, min(int(_setting("APP_RATE_LIMIT_PER_HOUR", "60")), 1000))
    except ValueError:
        return 60


def get_access_status() -> dict[str, bool | int]:
    access_code = _setting("APP_ACCESS_CODE")
    return {
        "access_required": bool(access_code) or _is_production(),
        "access_configured": bool(access_code),
        "rate_limit_per_hour": _rate_limit_per_hour(),
    }


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


async def require_model_access(
    request: Request,
    access_code_header: str | None = Header(default=None, alias="X-App-Access-Code"),
) -> None:
    expected = _setting("APP_ACCESS_CODE")
    if not expected:
        if _is_production():
            raise HTTPException(status_code=503, detail="线上服务尚未配置访问码。")
    elif not access_code_header or not secrets.compare_digest(access_code_header, expected):
        raise HTTPException(status_code=401, detail="访问码不正确，请联系网站管理员。")

    limit = _rate_limit_per_hour()
    if limit <= 0:
        return
    now = time.monotonic()
    bucket = _RATE_BUCKETS[_client_key(request)]
    while bucket and now - bucket[0] >= 3600:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="本小时生成次数已用完，请稍后再试。")
    bucket.append(now)
