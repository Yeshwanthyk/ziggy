#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "telephony"
    / "scripts"
    / "telephony.py"
)


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

            self.assertEqual(
                diagnosis["env_path"],
                str(profile_path / ".runtime" / "telephony" / ".env"),
            )
            self.assertEqual(
                diagnosis["state_path"],
                str(profile_path / ".runtime" / "telephony" / "telephony_state.json"),
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


if __name__ == "__main__":
    unittest.main()
