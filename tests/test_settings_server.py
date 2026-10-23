"""Unit tests for the local Agent Quota settings server.

The HTTP layer is exercised manually against a temporary GSettings backend;
these tests cover the security-sensitive helpers: credential-file parsing,
write-only secret storage, layout validation, and metadata parsing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER_PATH = REPO / "gnome-shell-extension" / "settings_server.py"

spec = importlib.util.spec_from_file_location("agent_quota_settings_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

PROVIDERS = [
    {
        "id": "copilot",
        "title": "GitHub Copilot",
        "secret": {"key": "GITHUB_TOKEN", "label": "GitHub personal access token"},
    },
    {
        "id": "zai",
        "title": "Z.ai",
        "secret": {"key": "ZAI_TOKEN", "label": "API token"},
    },
]


class AssignmentTests(unittest.TestCase):
    def test_last_assignment_wins(self) -> None:
        contents = "GITHUB_TOKEN=old\nOTHER=x\nGITHUB_TOKEN = new  \n"
        self.assertEqual(server.read_assignment(contents, "GITHUB_TOKEN"), "new")

    def test_upsert_replaces_duplicates_and_preserves_other_lines(self) -> None:
        contents = "# comment\nA=1\nGITHUB_TOKEN=old\nB=2\nGITHUB_TOKEN=older\n"
        updated = server.upsert_assignment(contents, "GITHUB_TOKEN", "new")
        self.assertEqual(updated.count("GITHUB_TOKEN="), 1)
        self.assertIn("A=1", updated)
        self.assertIn("B=2", updated)
        self.assertIn("GITHUB_TOKEN=new", updated)
        self.assertNotIn("old", updated)

    def test_upsert_appends_to_empty_file(self) -> None:
        self.assertEqual(server.upsert_assignment("", "ZAI_TOKEN", "abc"), "ZAI_TOKEN=abc\n")


class MetadataTests(unittest.TestCase):
    def test_metric_options_group_and_dedupe(self) -> None:
        grouped = server.metric_options(["claude:5h", "claude:7d", "claude:5h", "bad", "codex:5h"])
        self.assertEqual(grouped["claude"], ["5h", "7d"])
        self.assertEqual(grouped["codex"], ["5h"])

    def test_workspace_options_ignore_invalid_json(self) -> None:
        options = server.workspace_options([
            json.dumps({"id": "ws-1", "label": "Business"}),
            "not-json",
            json.dumps({"id": "", "label": "ignored"}),
            json.dumps({"id": "ws-1", "label": "duplicate"}),
        ])
        self.assertEqual(options, [{"id": "ws-1", "label": "Business"}])


class LayoutValidationTests(unittest.TestCase):
    def test_layout_is_normalized_and_unknown_fields_are_dropped(self) -> None:
        raw = server.validate_layout({
            "version": 99,
            "columns": 3,
            "providers": [{
                "id": "copilot",
                "gaugeColumns": 2,
                "order": ["5h", "7d"],
                "col": 1,
                "row": 2,
                "w": 99,
                "h": 99,
                "unknown": True,
            }],
        }, {"copilot"})
        layout = json.loads(raw)
        self.assertEqual(layout["version"], 1)
        self.assertEqual(layout["columns"], 3)
        self.assertNotIn("w", layout["providers"][0])
        self.assertNotIn("unknown", layout["providers"][0])

    def test_layout_rejects_unknown_provider(self) -> None:
        with self.assertRaises(ValueError):
            server.validate_layout({"columns": 3, "providers": [{"id": "nope", "gaugeColumns": 1, "order": []}]}, {"copilot"})

    def test_layout_rejects_out_of_range_columns(self) -> None:
        with self.assertRaises(ValueError):
            server.validate_layout({"columns": 6, "providers": []}, {"copilot"})


class SecretStoreTests(unittest.TestCase):
    def test_secret_is_written_private_and_never_read_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "config"
            store = server.SecretStore(PROVIDERS, directory)
            self.assertFalse(store.configured("copilot"))
            self.assertTrue(store.set("copilot", "GITHUB_TOKEN", "dummy"))
            self.assertTrue(store.configured("copilot"))
            path = directory / "copilot.conf"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text().strip().splitlines()[-1], "GITHUB_TOKEN=dummy")
            self.assertFalse(store.set("copilot", "GITHUB_TOKEN", ""))
            self.assertFalse(store.configured("copilot"))

    def test_secret_rejects_multiline_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = server.SecretStore(PROVIDERS, Path(temporary))
            with self.assertRaises(ValueError):
                store.set("copilot", "GITHUB_TOKEN", "good\nINJECTED=yes")

    def test_secret_rejects_fields_not_belonging_to_provider(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = server.SecretStore(PROVIDERS, Path(temporary))
            with self.assertRaises(ValueError):
                store.set("copilot", "ZAI_TOKEN", "nope")
            with self.assertRaises(ValueError):
                store.set("unknown", "GITHUB_TOKEN", "nope")


class PrivateFileTests(unittest.TestCase):
    def test_info_file_is_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings-server.json"
            server.write_private_json(path, {"token": "x"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text()), {"token": "x"})


if __name__ == "__main__":
    unittest.main()
