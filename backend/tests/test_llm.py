import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))

import llm  # noqa: E402
from llm import LLMError  # noqa: E402


class FakeResponse:
    def __init__(self, content: str = '{"ok": true}') -> None:
        self.content = content

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self.content}}]}

    def raise_for_status(self) -> None:
        return None


def fake_setting(name: str, default: str = "") -> str:
    values = {
        "LLM_API_KEY": "configured-for-test",
        "LLM_MODEL": "gpt-5-test-model",
        "LLM_TIMEOUT_SECONDS": "30",
    }
    return values.get(name, default)


class LlmRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_error_retries_once_with_short_backoff(self):
        post = AsyncMock(side_effect=[LLMError("temporary", "provider_error"), FakeResponse()])
        sleep = AsyncMock()
        with (
            patch("llm._setting", side_effect=fake_setting),
            patch("llm._validated_base_url", return_value="https://provider.example/v1"),
            patch("llm._post_completion", post),
            patch("llm.asyncio.sleep", sleep),
        ):
            result = await llm.complete_json("system", "user")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(post.await_count, 2)
        sleep.assert_awaited_once_with(1.0)
        payload = post.await_args_list[0].args[0]
        self.assertEqual(payload["reasoning_effort"], "low")
        self.assertEqual(payload["max_completion_tokens"], 2400)

    async def test_non_reasoning_model_omits_reasoning_effort(self):
        post = AsyncMock(return_value=FakeResponse())
        with (
            patch("llm._setting", side_effect=lambda name, default="": "gpt-4o-mini" if name == "LLM_MODEL" else fake_setting(name, default)),
            patch("llm._validated_base_url", return_value="https://provider.example/v1"),
            patch("llm._post_completion", post),
        ):
            await llm.complete_json("system", "user")

        self.assertNotIn("reasoning_effort", post.await_args.args[0])

    async def test_deepseek_uses_max_tokens_and_json_mode(self):
        post = AsyncMock(return_value=FakeResponse())
        with (
            patch("llm._setting", side_effect=lambda name, default="": "deepseek-chat" if name == "LLM_MODEL" else fake_setting(name, default)),
            patch("llm._validated_base_url", return_value="https://api.deepseek.com/v1"),
            patch("llm._post_completion", post),
        ):
            await llm.complete_json("system", "user")

        payload = post.await_args.args[0]
        self.assertEqual(payload["max_tokens"], 2400)
        self.assertNotIn("max_completion_tokens", payload)
        self.assertEqual(payload["response_format"], {"type": "json_object"})

    async def test_invalid_json_is_not_retried(self):
        post = AsyncMock(return_value=FakeResponse("not-json"))
        with (
            patch("llm._setting", side_effect=fake_setting),
            patch("llm._validated_base_url", return_value="https://provider.example/v1"),
            patch("llm._post_completion", post),
        ):
            with self.assertRaises(LLMError) as raised:
                await llm.complete_json("system", "user")

        self.assertEqual(raised.exception.code, "invalid_response")
        self.assertEqual(post.await_count, 1)

    async def test_auth_error_is_not_retried(self):
        post = AsyncMock(side_effect=LLMError("denied", "auth_failed"))
        sleep = AsyncMock()
        with (
            patch("llm._setting", side_effect=fake_setting),
            patch("llm._validated_base_url", return_value="https://provider.example/v1"),
            patch("llm._post_completion", post),
            patch("llm.asyncio.sleep", sleep),
        ):
            with self.assertRaises(LLMError) as raised:
                await llm.complete_json("system", "user")

        self.assertEqual(raised.exception.code, "auth_failed")
        self.assertEqual(post.await_count, 1)
        sleep.assert_not_awaited()

    async def test_provider_semaphore_serializes_concurrent_posts(self):
        state = {"active": 0, "maximum": 0}

        class FakeClient:
            def __init__(self, **_: object) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_: object) -> None:
                return None

            async def post(self, *_: object, **__: object) -> FakeResponse:
                state["active"] += 1
                state["maximum"] = max(state["maximum"], state["active"])
                await asyncio.sleep(0.01)
                state["active"] -= 1
                return FakeResponse()

        with patch("llm.httpx.AsyncClient", FakeClient):
            timeout = llm.httpx.Timeout(5.0)
            await asyncio.gather(
                llm._post_completion({}, "test-key", "https://provider.example/v1", timeout),
                llm._post_completion({}, "test-key", "https://provider.example/v1", timeout),
            )

        self.assertEqual(state["maximum"], 1)


class ProviderSemaphoreLoopTests(unittest.TestCase):
    def test_provider_semaphore_is_recreated_for_a_new_event_loop(self):
        class FakeClient:
            def __init__(self, **_: object) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_: object) -> None:
                return None

            async def post(self, *_: object, **__: object) -> FakeResponse:
                await asyncio.sleep(0.01)
                return FakeResponse()

        async def run_pair() -> None:
            timeout = llm.httpx.Timeout(5.0)
            await asyncio.gather(
                llm._post_completion({}, "test-key", "https://provider.example/v1", timeout),
                llm._post_completion({}, "test-key", "https://provider.example/v1", timeout),
            )

        with patch("llm.httpx.AsyncClient", FakeClient):
            asyncio.run(run_pair())
            asyncio.run(run_pair())


if __name__ == "__main__":
    unittest.main()
