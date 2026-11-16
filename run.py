"""One-command local setup and launch; invoked by npm start on Windows, macOS and Linux."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def run(args, cwd):
    print("\n> " + " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)


def prepare(root):
    web = root / "web"
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        run([sys.executable, "-m", "venv", root / ".venv"], root)
    requirements = root / "requirements.txt"
    signature = hashlib.sha256(requirements.read_bytes()).hexdigest()
    stamp = root / ".venv/red-atlas-requirements.sha256"
    if not stamp.is_file() or stamp.read_text() != signature:
        run([python, "-m", "pip", "install", "-r", requirements], root)
        stamp.write_text(signature)

    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise RuntimeError("Node.js and npm must be installed and available on PATH.")
    signature = hashlib.sha256((web / "package-lock.json").read_bytes()).hexdigest()
    stamp = web / "node_modules/.red-atlas-lock.sha256"
    if not stamp.is_file() or stamp.read_text() != signature or not (web / "node_modules/vite/bin/vite.js").is_file():
        run([npm, "ci", "--no-audit", "--no-fund"], web)
        stamp.write_text(signature)

    rebuilt = False
    for script, outputs in [
        ("build_terrain.py", ["web/public/terrain/jezero/meta.json", "web/public/terrain/jezero/heightmap.bin", "web/public/terrain/jezero/texture.jpg"]),
        ("build_globe.py", ["web/public/globe/globe.json", "data/raw/globe/megt90n000fb.img"]),
        ("build_climate.py", ["web/public/globe/climate.json"]),
    ]:
        if not all((root / path).is_file() for path in outputs):
            print("\nPreparing missing Mars data. First setup downloads over 1 GB; keep this terminal open.", flush=True)
            run([python, root / "pipeline" / script], root)
            rebuilt = True
    audit_stamp = root / ".venv/red-atlas-data-audit.ok"
    if rebuilt or not audit_stamp.is_file():
        audit_stamp.unlink(missing_ok=True)
        run([python, root / "pipeline/audit.py"], root)
        audit_stamp.touch()
    return npm


def main():
    try:
        npm = prepare(ROOT)
        print("\nStarting RED ATLAS. Open the Local URL below. Press Ctrl+C to stop.\n", flush=True)
        run([npm, "run", "dev", "--", "--host", "127.0.0.1", "--open"], ROOT / "web")
    except KeyboardInterrupt:
        return 0
    except (subprocess.CalledProcessError, OSError, RuntimeError) as error:
        print(f"\nSetup stopped: {error}\nFix the error above and run npm start again.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
