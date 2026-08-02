import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).parents[1]))

import security  # noqa: E402


def request_from(ip: str = "127.0.0.1") -> Request:
    return Request({"type": "http", "headers": [], "client": (ip, 1234)})


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        security._RATE_BUCKETS.clear()

    async def test_local_mode_can_run_without_access_code(self):
        with patch.dict(os.environ, {"APP_ENV": "local", "APP_ACCESS_CODE": "", "APP_RATE_LIMIT_PER_HOUR": "0"}):
            await security.require_model_access(request_from(), None)

    async def test_production_requires_configured_access_code(self):
        with patch.dict(os.environ, {"APP_ENV": "production", "APP_ACCESS_CODE": "", "APP_RATE_LIMIT_PER_HOUR": "0"}):
            with self.assertRaises(HTTPException) as raised:
                await security.require_model_access(request_from(), None)
        self.assertEqual(raised.exception.status_code, 503)

    async def test_access_code_is_compared_and_rate_limited(self):
        settings = {"APP_ENV": "production", "APP_ACCESS_CODE": "classroom", "APP_RATE_LIMIT_PER_HOUR": "1"}
        with patch.dict(os.environ, settings):
            with self.assertRaises(HTTPException) as denied:
                await security.require_model_access(request_from(), "wrong")
            self.assertEqual(denied.exception.status_code, 401)

            await security.require_model_access(request_from(), "classroom")
            with self.assertRaises(HTTPException) as limited:
                await security.require_model_access(request_from(), "classroom")
            self.assertEqual(limited.exception.status_code, 429)
