import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parents[1]))

import main  # noqa: E402


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_ready_requires_model_and_access_configuration(self):
        with (
            patch("main.get_model_status", return_value={"configured": False}),
            patch(
                "main.get_access_status",
                return_value={"access_required": True, "access_configured": False},
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                await main.readiness()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "service_not_configured")

    async def test_ready_succeeds_without_calling_the_model(self):
        with (
            patch("main.get_model_status", return_value={"configured": True}),
            patch(
                "main.get_access_status",
                return_value={"access_required": True, "access_configured": True},
            ),
        ):
            result = await main.readiness()

        self.assertEqual(result, {"status": "ready"})
