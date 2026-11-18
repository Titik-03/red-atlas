"""
RED ATLAS - online "Land here" builder, run as a Vercel function by api/site.py.

Same build as pipeline/site_server.py (build_terrain.build_site, profile "global"), with three differences:
  - the two source files the local builder reads from disk (MOLA MEGDR, Viking colour mosaic) are read from their
    official servers by HTTP byte ranges, only the rows a site needs;
  - finished sites are stored in Vercel Blob under sites/<id>/ and served at /sites/<id>/ by a rewrite in vercel.json;
  - a request builds the site and answers when it is done (no job queue: a function lives for one request).
Prefetch requests (sent when a point is merely selected) are not built online, to save function time.
"""
import json
import os
import threading
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np

import build_terrain as bt

MEGDR_URL = "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg032/megt90n000fb.img"
VIKING_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_Viking_ClrMosaic_global_925m.tif"
CFG = bt.load_cfg()
G = CFG["global"]
TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
STORE = TOKEN.split("_")[3].lower() if TOKEN.count("_") >= 4 else ""
BLOB_BASE = f"https://{STORE}.public.blob.vercel-storage.com"
TMP = Path("/tmp/sites")


def megdr_sample(lats, lons):
    """bt.megdr_sample with the needed rows fetched from the PDS file (5760 x 11520, >i2, 23040 bytes per row)."""
    r = (90 - lats) * 32 - 0.5
    c = np.mod(lons, 360) * 32 - 0.5
    r0, c0 = np.floor(r).astype(int), np.floor(c).astype(int)
    fr, fc = r - r0, c - c0
    r0 = np.clip(r0, 0, 5758)
    ra, rb = int(r0.min()), int(r0.max()) + 1
    req = urllib.request.Request(MEGDR_URL, headers={"Range": f"bytes={ra * 23040}-{(rb + 1) * 23040 - 1}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        body = res.read()
    if len(body) != (rb - ra + 1) * 23040:
        bt.fail("MOLA MEGDR range read returned the wrong size")
    m = np.frombuffer(body, dtype=">i2").reshape(-1, 11520)
    g = lambda rr, cc: m[rr - ra, np.mod(cc, 11520)].astype(np.float64)
    return (g(r0, c0) * (1 - fr) * (1 - fc) + g(r0, c0 + 1) * (1 - fr) * fc
            + g(r0 + 1, c0) * fr * (1 - fc) + g(r0 + 1, c0 + 1) * fr * fc)


# Layout of the Viking GeoTIFF, read from the file itself: uncompressed, band-sequential (PlanarConfiguration 2),
# one 23059-byte row per strip, strips contiguous from byte 277367.
VIK = {"w": 23059, "h": 11530, "res": 925.406, "x0": -10669931.18, "y0": 5334965.59, "first": 277367,
       "proj": "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"}


def viking_rows(lat, size_km, path):
    """The rows of the Viking colour mosaic that cover the site and its context ring, written as a small local GeoTIFF
    with the source's georeferencing, so build_terrain.add_color reads it exactly as it reads the full file."""
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_origin
    half = bt.context_edge_m(CFG, size_km * 1000, fixed=True) / 2 + 30 * VIK["res"]
    y = float(CFG["body"]["radius_m"]) * np.radians(lat)
    r0 = max(0, int((VIK["y0"] - (y + half)) / VIK["res"]))
    r1 = min(VIK["h"], int((VIK["y0"] - (y - half)) / VIK["res"]) + 1)
    n, w = r1 - r0, VIK["w"]
    out = [None] * 3

    def band(b):
        a = VIK["first"] + (b * VIK["h"] + r0) * w
        req = urllib.request.Request(VIKING_URL, headers={"Range": f"bytes={a}-{a + n * w - 1}"})
        with urllib.request.urlopen(req, timeout=90) as res:
            body = res.read()
        if len(body) == n * w:
            out[b] = np.frombuffer(body, dtype=np.uint8).reshape(n, w)
    ts = [threading.Thread(target=band, args=(b,)) for b in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    if any(o is None for o in out):
        bt.fail("Viking mosaic could not be read")
    with rasterio.open(path, "w", driver="GTiff", width=w, height=n, count=3, dtype="uint8", nodata=0,
                       crs=CRS.from_proj4(VIK["proj"]),
                       transform=from_origin(VIK["x0"], VIK["y0"] - r0 * VIK["res"], VIK["res"], VIK["res"])) as dst:
        dst.write(np.stack(out))
    return Path(path)


bt.megdr_sample = megdr_sample
build_lock = threading.Lock()          # one build at a time per instance (bt.VIKING is module state)
TYPES = {".json": "application/json", ".jpg": "image/jpeg"}


def blob_put(name, data, ctype):
    req = urllib.request.Request(f"https://blob.vercel-storage.com/{name}", data=data, method="PUT", headers={
        "authorization": f"Bearer {TOKEN}", "x-api-version": "7", "x-content-type": ctype,
        "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": "31536000"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def exists(sid):
    try:
        req = urllib.request.Request(f"{BLOB_BASE}/sites/{sid}/meta.json", method="HEAD")
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status == 200
    except urllib.error.URLError:
        return False


def done(sid):
    return {"id": sid, "status": "done", "stage": "done", "progress": 1.0, "base": f"/sites/{sid}"}


def build(lat, lon, size):
    sid = bt.site_id(lat, lon, size)
    if exists(sid):
        return done(sid)
    try:
        out = TMP / sid
        TMP.mkdir(parents=True, exist_ok=True)
        with build_lock:
            vik = TMP / f"viking_{sid}.tif"
            bt.VIKING = viking_rows(lat, size, vik)
            try:
                bt.build_site({"profile": "global", "lat": lat, "lon": lon, "size_km": size, "out_dir": str(out)}, CFG)
            finally:
                vik.unlink(missing_ok=True)
        files = sorted(p for p in out.iterdir() if p.is_file() and p.name != "meta.json")
        for p in files + [out / "meta.json"]:          # meta.json last: its presence marks the site complete
            blob_put(f"sites/{sid}/{p.name}", p.read_bytes(), TYPES.get(p.suffix, "application/octet-stream"))
        return done(sid)
    except bt.SiteError as e:
        return {"id": sid, "status": "error", "error": str(e)}
    except Exception as e:                             # network etc.
        traceback.print_exc()
        return {"id": sid, "status": "error", "error": f"{type(e).__name__}: {e}"}


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
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            lat, lon, size = float(req["lat"]), float(req["lon"]), int(req.get("size_km", 20))
            prefetch = bool(req.get("prefetch", False))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self.send(400, {"error": "expected JSON {lat, lon, size_km}"})
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or size not in G["sizes_km"]:
            return self.send(400, {"error": f"lat/lon out of range or size not in {G['sizes_km']}"})
        if not TOKEN:
            return self.send(503, {"error": "The online site builder has no storage configured."})
        sid = bt.site_id(lat, lon, size)
        if prefetch:
            return self.send(200, done(sid) if exists(sid) else {"id": sid, "status": "queued", "stage": "queued",
                                                                 "progress": 0.0, "base": f"/sites/{sid}"})
        self.send(200, build(lat, lon, size))

    def do_GET(self):
        sid = (parse_qs(urlsplit(self.path).query).get("id") or [""])[0]
        if not sid or not all(ch.isalnum() or ch in "._" for ch in sid):
            return self.send(404, {"error": "not found"})
        self.send(200, done(sid) if exists(sid) else {"error": "unknown site"})
