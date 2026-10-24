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
import tomllib
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


class TomlValueTests(unittest.TestCase):
    def test_scalars(self) -> None:
        self.assertEqual(server.toml_value(True), "true")
        self.assertEqual(server.toml_value(False), "false")
        self.assertEqual(server.toml_value(12), "12")
        self.assertEqual(server.toml_value("bar"), '"bar"')

    def test_strings_are_escaped(self) -> None:
        self.assertEqual(server.toml_value('say "hi"'), '"say \\"hi\\""')
        self.assertEqual(server.toml_value("back\\slash"), '"back\\\\slash"')

    def test_lists(self) -> None:
        self.assertEqual(server.toml_value(["claude", "codex"]), '["claude", "codex"]')
        self.assertEqual(server.toml_value([]), "[]")

    def test_unsupported_type_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            server.toml_value({"nope": 1})


class GnomeSectionTests(unittest.TestCase):
    def test_replace_appends_when_missing(self) -> None:
        updated = server.replace_gnome_section('enabled = ["claude"]\n', {"meter-style": "bar"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["enabled"], ["claude"])
        self.assertEqual(parsed["gnome"], {"meter-style": "bar"})

    def test_replace_updates_in_place_and_keeps_unmanaged_keys(self) -> None:
        contents = (
            'enabled = ["claude"]\n\n[gnome]\n'
            "# hand written\n"
            'meter-style = "circle"\n'
            "circle-radius = 20\n"
            "warning-threshold = 25\n"
        )
        updated = server.replace_gnome_section(contents, {"meter-style": "bar"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["enabled"], ["claude"])
        # The mirror owns meter-style only; the rest of the table survives.
        self.assertEqual(
            parsed["gnome"],
            {"meter-style": "bar", "circle-radius": 20, "warning-threshold": 25},
        )
        self.assertIn("# hand written", updated)

    def test_replace_keeps_quoted_keys_untouched(self) -> None:
        contents = '[gnome]\n"warning-threshold" = 40\n"meter-style" = "bar"\n'
        updated = server.replace_gnome_section(contents, {"meter-style": "circle"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"warning-threshold": 40, "meter-style": "circle"})

    def test_replace_appends_missing_keys_inside_the_table(self) -> None:
        contents = '[gnome]\nwarning-threshold = 25\n\n[other]\nb = "x"\n'
        updated = server.replace_gnome_section(contents, {"meter-style": "bar", "popup-width": 480})
        parsed = tomllib.loads(updated)
        self.assertEqual(
            parsed["gnome"],
            {"warning-threshold": 25, "meter-style": "bar", "popup-width": 480},
        )
        self.assertEqual(parsed["other"], {"b": "x"})

    def test_replace_preserves_later_tables(self) -> None:
        contents = '[gnome]\na = 1\n\n[other]\nb = "x"\n'
        updated = server.replace_gnome_section(contents, {"a": 2})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"a": 2})
        self.assertEqual(parsed["other"], {"b": "x"})

    def test_write_creates_and_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            server.write_gnome_section(path, {"meter-style": "bar", "popup-width": 480})
            self.assertEqual(tomllib.loads(path.read_text())["gnome"], {"meter-style": "bar", "popup-width": 480})
            server.write_gnome_section(path, {"meter-style": "circle"})
            # Saving one key must not drop the others.
            self.assertEqual(
                tomllib.loads(path.read_text())["gnome"],
                {"meter-style": "circle", "popup-width": 480},
            )

    def test_write_keeps_keys_it_does_not_manage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["claude"]\n'
                "\n"
                "[gnome]\n"
                "warning-threshold = 25\n"
                "critical-threshold = 5\n"
            )
            server.write_gnome_section(path, {"refresh-seconds": 120})
            data = tomllib.loads(path.read_text())
            self.assertEqual(
                data["gnome"],
                {"warning-threshold": 25, "critical-threshold": 5, "refresh-seconds": 120},
            )
            self.assertEqual(data["enabled"], ["claude"])

    def test_load_section(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.assertEqual(server.load_gnome_section(path), {})
            path.write_text('enabled = ["a"]\n[gnome]\n"refresh-seconds" = 30\n')
            self.assertEqual(server.load_gnome_section(path), {"refresh-seconds": 30})
            path.write_text("this is not toml [")
            self.assertEqual(server.load_gnome_section(path), {})


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
