"""Per-provider deadline and partial-result tests for fetch_all (Issue #7)."""

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import agent_quota
import common
from agent_quota import Metric, _Provider, fetch_all


class FetchAllDeadlineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._stop = threading.Event()

    def tearDown(self) -> None:
        self._stop.set()

    def _hung_provider(self, name: str = "Codex") -> _Provider:
        def fetch(_browsers):
            self._stop.wait(5.0)
            return {}

        return _Provider(name=name, mode="usage", fetch=fetch, adapt=lambda _raw: [])

    def _ok_provider(self, name: str = "Gemini") -> _Provider:
        return _Provider(
            name=name,
            mode="usage",
            fetch=lambda _browsers: {"source": "agy oauth"},
            adapt=lambda _raw: [Metric("5h", "80%", 80, is_remaining=True)],
        )

    def test_hung_provider_does_not_block_healthy_providers(self) -> None:
        providers = {
            "codex": self._hung_provider("Codex"),
            "gemini": self._ok_provider("Gemini"),
        }

        start = time.monotonic()
        statuses = fetch_all(providers, None, timeout=0.05)
        elapsed = time.monotonic() - start

        self.assertLess(elapsed, 1.0)
        self.assertEqual([s.key for s in statuses], ["codex", "gemini"])

        codex_status, gemini_status = statuses
        self.assertEqual(codex_status.state, "net_err")
        self.assertIn("Timed out after 0.05s", codex_status.error)

        self.assertEqual(gemini_status.state, "ok")
        self.assertEqual(len(gemini_status.metrics), 1)
        self.assertEqual(gemini_status.metrics[0].value, "80%")

    def test_timed_out_provider_removes_stale_updating_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            codex_marker = cache_dir / "codex.updating"
            codex_scoped_marker = cache_dir / "codex:chrome.updating"
            codex_cache = cache_dir / "codex.json"
            gemini_marker = cache_dir / "gemini.updating"
            for path in (
                codex_marker,
                codex_scoped_marker,
                codex_cache,
                gemini_marker,
            ):
                path.write_text("{}")

            providers = {
                "codex": self._hung_provider("Codex"),
                "gemini": self._ok_provider("Gemini"),
            }
            with mock.patch.object(common, "CACHE_DIR", cache_dir):
                fetch_all(providers, None, timeout=0.05)

            self.assertFalse(codex_marker.exists())
            self.assertFalse(codex_scoped_marker.exists())
            self.assertTrue(codex_cache.exists())
            self.assertTrue(gemini_marker.exists())


if __name__ == "__main__":
    unittest.main()
