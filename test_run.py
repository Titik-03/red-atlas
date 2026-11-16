from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

import run as launcher


class LauncherTest(unittest.TestCase):
    def test_fresh_setup_then_cached_restart(self):
        with tempfile.TemporaryDirectory(prefix="red atlas ") as directory:
            root = Path(directory)
            for name, value in [("requirements.txt", "numpy"), ("web/package-lock.json", "{}")]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)

            def command(args, cwd):
                if "venv" in args:
                    python = root / ".venv" / ("Scripts/python.exe" if launcher.os.name == "nt" else "bin/python")
                    python.parent.mkdir(parents=True)
                    python.touch()
                elif "ci" in args:
                    vite = root / "web/node_modules/vite/bin/vite.js"
                    vite.parent.mkdir(parents=True)
                    vite.touch()
                else:
                    outputs = {
                        "build_terrain.py": ["web/public/terrain/jezero/meta.json", "web/public/terrain/jezero/heightmap.bin", "web/public/terrain/jezero/texture.jpg"],
                        "build_globe.py": ["web/public/globe/globe.json", "data/raw/globe/megt90n000fb.img"],
                        "build_climate.py": ["web/public/globe/climate.json"],
                    }
                    for name in outputs.get(Path(str(args[-1])).name, []):
                        path = root / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.touch()

            with patch.object(launcher, "run", side_effect=command) as execute, patch.object(launcher.shutil, "which", return_value="npm"):
                launcher.prepare(root)
                scripts = [Path(str(call.args[0][-1])).name for call in execute.call_args_list]
                self.assertLess(scripts.index("build_terrain.py"), scripts.index("build_globe.py"))
                self.assertLess(scripts.index("build_globe.py"), scripts.index("build_climate.py"))
                self.assertEqual(scripts[-1], "audit.py")
                execute.reset_mock()
                launcher.prepare(root)
                execute.assert_not_called()
                (root / "requirements.txt").write_text("numpy\npillow")
                launcher.prepare(root)
                self.assertEqual(execute.call_count, 1)
                self.assertIn("pip", execute.call_args.args[0])
                (root / ".venv/red-atlas-data-audit.ok").unlink()
                execute.reset_mock()
                execute.side_effect = subprocess.CalledProcessError(1, "audit")
                with self.assertRaises(subprocess.CalledProcessError):
                    launcher.prepare(root)
                self.assertFalse((root / ".venv/red-atlas-data-audit.ok").exists())
                execute.side_effect = command
                execute.reset_mock()
                launcher.prepare(root)
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(Path(str(execute.call_args.args[0][-1])).name, "audit.py")

    def test_failed_install_does_not_record_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text("numpy")
            python = root / ".venv" / ("Scripts/python.exe" if launcher.os.name == "nt" else "bin/python")
            python.parent.mkdir(parents=True)
            python.touch()
            with patch.object(launcher, "run", side_effect=subprocess.CalledProcessError(1, "install")):
                with self.assertRaises(subprocess.CalledProcessError):
                    launcher.prepare(root)
            self.assertFalse((root / ".venv/red-atlas-requirements.sha256").exists())


if __name__ == "__main__":
    unittest.main()
