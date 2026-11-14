#!/usr/bin/env python3
"""
RED ATLAS - local on-demand site builder ("Land here").

  POST /api/site        {"lat": <deg N>, "lon": <deg E>, "size_km": 10|20|40, "prefetch": false}
                        prefetch=true is sent when a point is merely selected: it is built in the background at low
                        priority, and an older queued prefetch is dropped when a newer one arrives.
                        -> {"id", "status": "done"|"queued"|"running"|"error", ...}
  GET  /api/site/<id>   -> {"id", "status", "stage", "progress", "error", "base"}

Sites are written to web/public/sites/<id>/ (heightmap.bin, texture.jpg, meta.json - same contract as
/terrain/jezero). The id encodes the rounded centre (0.01 deg) and size, so a repeat visit is served from disk.
Builds run one at a time in a worker thread (they are network-bound and share connection pools).

Usage:  .venv/bin/python pipeline/site_server.py [--port 8765]
        (cd web && npm run dev)   # Vite proxies /api -> localhost:8765
"""
import argparse
import json
import itertools
import queue
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_terrain as bt  # noqa: E402

SITES = bt.ROOT / "web" / "public" / "sites"
CFG = bt.load_cfg()
G = CFG["global"]
jobs = {}                 # id -> {"status", "stage", "progress", "error", "spec"}
jobs_lock = threading.Lock()
work = queue.PriorityQueue()          # (priority, order, sid): 0 = "Land here", 1 = prefetch
order = itertools.count()


def worker():
    while True:
        _, _, sid = work.get()
        with jobs_lock:
            job = jobs.get(sid)
            if not job or job["status"] != "queued":     # dropped prefetch, or already handled
                continue
            job["status"] = "running"

        def progress(stage, frac):
            job["stage"], job["progress"] = stage, round(float(frac), 3)
        try:
            bt.build_site(job["spec"], CFG, progress)
            job.update(status="done", stage="done", progress=1.0)
        except bt.SiteError as e:
            job.update(status="error", error=str(e))
        except Exception as e:                      # network etc.: report, keep serving
            traceback.print_exc()
            job.update(status="error", error=f"{type(e).__name__}: {e}")


def state(sid):
    if (SITES / sid / "meta.json").exists():
        return {"id": sid, "status": "done", "stage": "done", "progress": 1.0, "base": f"/sites/{sid}"}
    job = jobs.get(sid)
    if not job:
        return None
    return {"id": sid, **{k: job.get(k) for k in ("status", "stage", "progress", "error")}, "base": f"/sites/{sid}"}


class Handler(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/site":
            return self.send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            lat, lon, size = float(req["lat"]), float(req["lon"]), int(req.get("size_km", 20))
            prefetch = bool(req.get("prefetch", False))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self.send(400, {"error": "expected JSON {lat, lon, size_km}"})
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or size not in G["sizes_km"]:
            return self.send(400, {"error": f"lat/lon out of range or size not in {G['sizes_km']}"})
        sid = bt.site_id(lat, lon, size)
        with jobs_lock:
            st = state(sid)
            if prefetch:     # only the latest selected point is worth building in the background
                for other, j in list(jobs.items()):
                    if other != sid and j["status"] == "queued" and j.get("prefetch"):
                        del jobs[other]
            if st is None or (st["status"] == "error" and not prefetch):   # (re)try failed builds on request
                jobs[sid] = {"status": "queued", "stage": "queued", "progress": 0.0, "error": None,
                             "prefetch": prefetch,
                             "spec": {"profile": "global", "lat": lat, "lon": lon, "size_km": size}}
                work.put((1 if prefetch else 0, next(order), sid))
                st = state(sid)
            elif not prefetch and jobs.get(sid, {}).get("prefetch") and jobs[sid]["status"] == "queued":
                jobs[sid]["prefetch"] = False                  # promote: user pressed "Land here"
                work.put((0, next(order), sid))
        self.send(200, st)

    def do_GET(self):
        m = re.fullmatch(r"/api/site/([A-Za-z0-9._]+)", self.path)
        if not m:
            return self.send(404, {"error": "not found"})
        st = state(m.group(1))
        self.send(200 if st else 404, st or {"error": "unknown site"})

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/site/"):     # don't log progress polling
            sys.stderr.write("%s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    SITES.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"RED ATLAS site server on http://127.0.0.1:{a.port}  (sites -> {SITES})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
