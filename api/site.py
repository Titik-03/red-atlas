"""Vercel entry point for "Land here" (POST /api/site, GET /api/site/<id>): see pipeline/online_builder.py.
If the builder cannot load on this host, the app gets a clear message instead of a crash."""
import ctypes
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
# The rasterio wheel needs the system libexpat, which the function image lacks; the build copies it into lib/.
try:
    ctypes.CDLL(str(ROOT / "lib" / "libexpat.so.1"), mode=ctypes.RTLD_GLOBAL)
except OSError as e:
    print(f"libexpat not preloaded: {e}")
try:
    import online_builder as ob
except Exception as e:  # noqa: BLE001
    print(f"online builder unavailable: {type(e).__name__}: {e}")
    ob = None
MSG = ("Landing on a new point is not available in the online version right now. Press Explore terrain to visit "
       "Jezero Crater, or run the project on your computer with npm start.")


class handler(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        return ob.handler.do_POST(self) if ob else self.send(503, {"error": MSG})

    def do_GET(self):
        return ob.handler.do_GET(self) if ob else self.send(503, {"error": MSG})
