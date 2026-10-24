"""CLI config.toml persistence: save_config must not touch tables it does not own.

The GNOME extension settings server mirrors its GSettings into the [gnome]
table of ~/.config/agent-quota/config.toml.  `agent-quota setup` rewrites the
CLI's own keys (enabled, show_user) and has to keep that table verbatim.
"""

from __future__ import annotations

import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import agent_quota


class SaveConfigTests(unittest.TestCase):
    def test_writes_enabled_and_show_user(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude", "codex"], show_user=False)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["claude", "codex"])
            self.assertFalse(data["show_user"])

    def test_preserves_gnome_table(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["old"]\n'
                "\n"
                "[gnome]\n"
                'meter-style = "bar"\n'
                "popup-width = 480\n"
            )
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"], show_user=True)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["zen"])
            self.assertNotIn("show_user", data)
            self.assertEqual(data["gnome"], {"meter-style": "bar", "popup-width": 480})

    def test_replaces_stale_managed_keys_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["old"]\nshow_user = false\n\n[gnome]\n"refresh-seconds" = 60\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["kimi"], show_user=True)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["kimi"])
            self.assertNotIn("show_user", data)
            self.assertEqual(data["gnome"], {"refresh-seconds": 60})


if __name__ == "__main__":
    unittest.main()
