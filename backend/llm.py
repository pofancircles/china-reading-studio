from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv


# Uvicorn is normally started from ``backend/`` while the project README also
# supports starting from the repository root. Load only local config files;
# process environment variables still take precedence and secrets are never
# logged or returned by an endpoint.
_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR.parent / ".env", override=False)
load_dotenv(_BACKEND_DIR / ".env", override=False)

SAFE_ERROR_CODES = frozenset({
    "not_configured", "invalid_config", "auth_failed", "provider_error", "invalid_response",
    "level_violation", "empty_rewrite", "internal_error",
})

# The configured compatible provider is the narrowest shared resource in this
# local app.  Component generation may arrive concurrently, but one in-flight
# upstream request is substantially more reliable than a burst of three plus
# synchronized retries.
_PROVIDER_SEMAPHORE: asyncio.Semaphore | None = None
_PROVIDER_SEMAPHORE_LOOP: asyncio.AbstractEventLoop | None = None
_PROVIDER_RETRY_DELAY_SECONDS = 1.0


def _provider_semaphore() -> asyncio.Semaphore:
    """Keep provider requests serial without reusing a lock across event loops."""
    global _PROVIDER_SEMAPHORE, _PROVIDER_SEMAPHORE_LOOP
    loop = asyncio.get_running_loop()
    if _PROVIDER_SEMAPHORE is None or _PROVIDER_SEMAPHORE_LOOP is not loop:
        _PROVIDER_SEMAPHORE = asyncio.Semaphore(1)
        _PROVIDER_SEMAPHORE_LOOP = loop
    return _PROVIDER_SEMAPHORE


def _setting(name: str, default: str = "") -> str:
    """Prefer a non-empty process value, then local env files, then default."""
    process_value = os.environ.get(name, "").strip()
    if process_value:
        return process_value
    for path in (_BACKEND_DIR / ".env", _BACKEND_DIR.parent / ".env"):
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                key, separator, value = line.partition("=")
                if separator and key.strip() == name and value.strip():
                    return value.strip().strip('"').strip("'")
    return default


class LLMError(RuntimeError):
    def __init__(self, message: str, code: str = "provider_error", details: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code if code in SAFE_ERROR_CODES else "provider_error"
        self.details = list(details or []) if self.code in {"invalid_response", "level_violation", "empty_rewrite"} else []


def _validated_base_url() -> str:
    base_url = _setting("LLM_BASE_URL", "https://api.openai-next.com/v1").rstrip("/")
    parsed = urlsplit(base_url)
    is_local = parsed.hostname in {"127.0.0.1", "localhost"}
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise LLMError("LLM_BASE_URL is invalid", "invalid_config")
    if parsed.scheme != "https" and not (is_local and parsed.scheme == "http"):
        raise LLMError("LLM_BASE_URL must use HTTPS", "invalid_config")
    return base_url


def _provider_metadata() -> tuple[str, str, bool]:
    base_url = _setting("LLM_BASE_URL", "https://api.openai-next.com/v1").rstrip("/")
    parsed = urlsplit(base_url)
    return parsed.netloc or parsed.path, _setting("LLM_MODEL", "gpt-4o-mini"), bool(_setting("LLM_API_KEY"))


def get_model_status() -> dict[str, str | bool]:
    """Return safe configuration metadata without exposing the API key."""
    provider, model, configured = _provider_metadata()
    return {"configured": configured, "provider": provider, "model": model, "mode": "ai" if configured else "demo"}


def _content_text(response_payload: object) -> str:
    """Extract text from string or OpenAI-compatible content-part responses."""
    if not isinstance(response_payload, dict):
        raise LLMError("LLM response was not an object", "invalid_response")
    choices = response_payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise LLMError("LLM response had no choices", "invalid_response")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise LLMError("LLM response had no message", "invalid_response")
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    raise LLMError("LLM response content was invalid", "invalid_response")


async def _post_completion(payload: dict, api_key: str, base_url: str, timeout: httpx.Timeout) -> httpx.Response:
    try:
        async with _provider_semaphore():
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json=payload,
                )
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    code = "auth_failed" if exc.response.status_code in {401, 403} else "provider_error"
                    raise LLMError("LLM provider rejected the request", code) from exc
                return response
    except LLMError:
        raise
    except httpx.HTTPError as exc:
        raise LLMError("LLM provider could not be reached", "provider_error") from exc


async def complete_json(system: str, user: str, max_completion_tokens: int | None = None) -> dict:
    api_key = _setting("LLM_API_KEY")
    if not api_key:
        raise LLMError("LLM_API_KEY is not configured", "not_configured")
    base_url = _validated_base_url()
    model = _setting("LLM_MODEL", "gpt-4o-mini")
    reasoning_effort = _setting("LLM_REASONING_EFFORT", "low").lower()
    if reasoning_effort not in {"low", "medium", "high"}:
        raise LLMError("LLM_REASONING_EFFORT is invalid", "invalid_config")
    try:
        configured_token_limit = max(
            512,
            min(int(_setting("LLM_MAX_COMPLETION_TOKENS", "2400")), 4096),
        )
    except ValueError as exc:
        raise LLMError("LLM_MAX_COMPLETION_TOKENS is invalid", "invalid_config") from exc
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.35,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": max(
            512,
            min(max_completion_tokens or configured_token_limit, configured_token_limit),
        ),
    }
    if model.lower().startswith(("gpt-5", "o1", "o3", "o4")):
        payload["reasoning_effort"] = reasoning_effort
    try:
        timeout_seconds = max(30.0, min(float(_setting("LLM_TIMEOUT_SECONDS", "60")), 240.0))
    except ValueError as exc:
        raise LLMError("LLM_TIMEOUT_SECONDS is invalid", "invalid_config") from exc
    timeout = httpx.Timeout(timeout_seconds, connect=15.0)
    response: httpx.Response | None = None
    for attempt in range(2):
        try:
            response = await _post_completion(payload, api_key, base_url, timeout)
            break
        except LLMError as exc:
            if exc.code != "provider_error" or attempt == 1:
                raise
            await asyncio.sleep(_PROVIDER_RETRY_DELAY_SECONDS)
    if response is None:
        raise LLMError("LLM provider did not return a response", "provider_error")
    try:
        content = _content_text(response.json())
        if not content.strip():
            raise LLMError("LLM response was empty", "invalid_response")
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise LLMError("LLM response must be a JSON object", "invalid_response")
        return parsed
    except LLMError:
        raise
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        # Repeating the same prompt is not a transport recovery strategy.
        # The service layer may issue one stricter repair prompt instead.
        raise LLMError("LLM response was not valid JSON", "invalid_response") from exc


async def probe_model(timeout_seconds: float = 30.0) -> dict[str, str | bool | int]:
    """Perform one tiny authenticated request and return only safe metadata."""
    provider, model, configured = _provider_metadata()
    base_result: dict[str, str | bool | int] = {
        "ok": False,
        "code": "not_configured" if not configured else "provider_error",
        "configured": configured,
        "provider": provider,
        "model": model,
    }
    if not configured:
        return base_result
    started = time.perf_counter()
    try:
        base_url = _validated_base_url()
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "Return only JSON."},
                {"role": "user", "content": "Return {\"ok\":true}."},
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        timeout = httpx.Timeout(max(2.0, min(float(timeout_seconds), 60.0)), connect=8.0)
        response = await _post_completion(payload, _setting("LLM_API_KEY"), base_url, timeout)
        content = _content_text(response.json())
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise LLMError("probe response was not an object", "invalid_response")
        base_result.update({"ok": True, "code": "ok"})
    except LLMError as exc:
        base_result["code"] = exc.code
    except (ValueError, TypeError, json.JSONDecodeError):
        base_result["code"] = "invalid_response"
    finally:
        base_result["latency_ms"] = int(round((time.perf_counter() - started) * 1000))
    return base_result
