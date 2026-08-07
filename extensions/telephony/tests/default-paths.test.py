#!/usr/bin/env python3

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "telephony"
    / "scripts"
    / "telephony.py"
)
SPEC = importlib.util.spec_from_file_location("ziggy_telephony_test_module", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load telephony helper")
TELEPHONY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TELEPHONY
SPEC.loader.exec_module(TELEPHONY)


class DefaultPathsTest(unittest.TestCase):
    def diagnose(self, cwd: Path, telephony_home: Path | None = None) -> dict[str, object]:
        env = os.environ.copy()
        env.pop("ZIGGY_TELEPHONY_HOME", None)
        if telephony_home is not None:
            env["ZIGGY_TELEPHONY_HOME"] = str(telephony_home)
        result = subprocess.run(
            ["python3", str(SCRIPT), "diagnose"],
            cwd=cwd,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_defaults_to_current_profile_runtime_directory(self) -> None:
        with tempfile.TemporaryDirectory() as profile:
            profile_path = Path(profile)
            diagnosis = self.diagnose(profile_path)
            process_cwd = profile_path.resolve()

            self.assertEqual(
                diagnosis["env_path"],
                str(process_cwd / ".runtime" / "telephony" / ".env"),
            )
            self.assertEqual(
                diagnosis["state_path"],
                str(process_cwd / ".runtime" / "telephony" / "telephony_state.json"),
            )

    def test_preserves_explicit_home_override(self) -> None:
        with tempfile.TemporaryDirectory() as profile:
            override = Path(profile) / "override"
            diagnosis = self.diagnose(Path(profile), override)

            self.assertEqual(diagnosis["env_path"], str(override / ".env"))
            self.assertEqual(
                diagnosis["state_path"],
                str(override / "telephony_state.json"),
            )

    def test_persisted_credentials_and_state_are_private_under_normal_umask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_path = root / ".env"
            state_path = root / "telephony_state.json"
            previous_umask = os.umask(0o022)
            try:
                TELEPHONY._upsert_env_file({"TWILIO_AUTH_TOKEN": "secret"}, env_path)
                TELEPHONY._save_state({"version": 1, "secret": "state"}, state_path)
            finally:
                os.umask(previous_umask)

            self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)

    def test_atomic_publish_failure_preserves_existing_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_path = root / ".env"
            state_path = root / "telephony_state.json"
            env_path.write_bytes(b"TWILIO_AUTH_TOKEN=old\n")
            state_path.write_bytes(b'{"version":1,"old":true}\n')

            attempts = (
                (
                    env_path,
                    lambda: TELEPHONY._upsert_env_file(
                        {"TWILIO_AUTH_TOKEN": "replacement"}, env_path
                    ),
                ),
                (
                    state_path,
                    lambda: TELEPHONY._save_state(
                        {"version": 1, "old": False}, state_path
                    ),
                ),
            )
            for target, attempt in attempts:
                with self.subTest(target=target.name):
                    original = target.read_bytes()
                    with patch.object(TELEPHONY.os, "replace", side_effect=OSError("injected")):
                        with self.assertRaisesRegex(OSError, "injected"):
                            attempt()
                    self.assertEqual(target.read_bytes(), original)
                    self.assertEqual(list(root.glob(f".{target.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
