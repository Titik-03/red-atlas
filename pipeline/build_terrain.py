#!/usr/bin/env python3
"""
RED ATLAS - build a browser-ready 3D terrain tile from official USGS/NASA products.

Steps
  1. Open the remote USGS Mars 2020 TRN HiRISE DTM + orthomosaic (HTTP range reads, no full download).
  2. Verify each product's live header against the documented values in config.yaml (abort on mismatch).
  3. Read only the source window covering the tile.
  4. Reproject both onto ONE local Equirectangular grid centred on the tile
     (+proj=eqc +lat_ts=<lat> +lat_0=<lat> +lon_0=<lon>, Mars 2000 sphere) so 1 unit = 1 ground metre.
     Downsampling uses area averaging (Resampling.average).
  5. Export web assets: heightmap.bin (Float32 LE, row 0 = north), texture.jpg, meta.json.
  6. Validate: no NoData, value ranges, geolocation formulas, and heights vs. the source DTM.

Profiles (build_site(spec) -> out_dir; every site writes the same heightmap.bin / texture.jpg / meta.json contract)
  hirise_jezero  fixed HiRISE 1 m DTM + 25 cm ortho tile (config.yaml "site"/"products")
  global         any point on Mars: USGS HRSC-MOLA blended DEM (200 m) + CTX beta01 mosaic (~5 m) (config.yaml "global")

Usage:  .venv/bin/python pipeline/build_terrain.py [pipeline/config.yaml]          # Jezero HiRISE tile
        .venv/bin/python pipeline/build_terrain.py --lat -4.59 --lon 137.44 [--size 20]   # global site
"""
import argparse
import http.client
import io
import json
import math
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
import yaml
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform as warp_transform
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("VSI_CACHE", "FALSE")


class SiteError(Exception):
    """A documented-value check or validation failed; the site must not be opened."""


def fail(msg):
    raise SiteError(msg)


def check_header(name, src, exp):
    """Compare a product's live header with the values documented in config.yaml."""
    proj = src.crs.to_proj4()
    for token in exp["proj_contains"]:
        if token not in proj:
            fail(f"{name}: CRS '{proj}' lacks documented token '{token}'")
    if not math.isclose(src.res[0], exp["pixel_size_m"]) or not math.isclose(src.res[1], exp["pixel_size_m"]):
        fail(f"{name}: pixel size {src.res} != documented {exp['pixel_size_m']}")
    if (src.width, src.height) != (exp["width"], exp["height"]):
        fail(f"{name}: size {src.width}x{src.height} != documented {exp['width']}x{exp['height']}")
    if src.dtypes[0] != exp["dtype"]:
        fail(f"{name}: dtype {src.dtypes[0]} != documented {exp['dtype']}")
    if not math.isclose(src.nodata, exp["nodata"], rel_tol=1e-6):
        fail(f"{name}: nodata {src.nodata} != documented {exp['nodata']}")
    if src.tags().get("AREA_OR_POINT", "Area") != "Area":
        fail(f"{name}: expected pixel-is-area registration")
    print(f"  [ok] {name}: header matches documentation ({proj})")


def read_window_chunked(src, window, label):
    """Strip-organised remote TIFF: read in row chunks so progress is visible."""
    out = np.empty((int(window.height), int(window.width)), dtype=src.dtypes[0])
    step = 1024
    t0 = time.time()
    for r in range(0, out.shape[0], step):
        h = min(step, out.shape[0] - r)
        out[r:r + h] = src.read(1, window=Window(window.col_off, window.row_off + r, window.width, h))
        done = (r + h) / out.shape[0]
        print(f"\r  reading {label}: {done*100:5.1f}%  ({time.time()-t0:5.0f}s)", end="", flush=True)
    print()
    return out


def bilinear(arr, transform, x, y):
    """Bilinear sample at map coords (pixel-is-area: centres at +0.5)."""
    inv = ~transform
    c, r = inv * (x, y)
    c -= 0.5
    r -= 0.5
    c0, r0 = int(math.floor(c)), int(math.floor(r))
    fc, fr = c - c0, r - r0
    v = arr[r0:r0 + 2, c0:c0 + 2].astype(np.float64)
    if v.shape != (2, 2):
        raise IndexError("sample outside array")
    return (v[0, 0] * (1 - fc) * (1 - fr) + v[0, 1] * fc * (1 - fr)
            + v[1, 0] * (1 - fc) * fr + v[1, 1] * fc * fr)


def build_hirise(cfg):
    site, body, prods, val = cfg["site"], cfg["body"], cfg["products"], cfg["validation"]
    R = float(body["radius_m"])
    lat_c, lon_c = float(site["center_lat"]), float(site["center_lon"])
    S = float(site["size_m"])
    dres, tres = float(site["dem_res_m"]), float(site["tex_res_m"])

    geo_crs = CRS.from_proj4(f"+proj=longlat +R={R} +no_defs")
    local_proj = f"+proj=eqc +lat_ts={lat_c} +lat_0={lat_c} +lon_0={lon_c} +x_0=0 +y_0=0 +R={R} +units=m +no_defs"
    local_crs = CRS.from_proj4(local_proj)

    # Destination grids (west/north edges at -S/2, +S/2)
    x0, y0 = -S / 2, S / 2
    nd, nt = int(round(S / dres)), int(round(S / tres))
    dem_tf = from_origin(x0, y0, dres, dres)
    tex_tf = from_origin(x0, y0, tres, tres)

    # Tile footprint in lon/lat (closed-form inverse of the local eqc; checked against PROJ below)
    k = R * math.cos(math.radians(lat_c))
    lon_w, lon_e = lon_c + math.degrees(x0 / k), lon_c + math.degrees(-x0 / k)
    lat_s, lat_n = lat_c + math.degrees(-S / 2 / R), lat_c + math.degrees(S / 2 / R)
    print(f"Tile {site['id']}: {S:.0f} m square, lat {lat_s:.5f}..{lat_n:.5f}, lon {lon_w:.5f}..{lon_e:.5f}")

    out_web = ROOT / "web" / "public" / "terrain" / site["id"]
    out_proc = ROOT / "data" / "processed" / site["id"]
    out_web.mkdir(parents=True, exist_ok=True)
    out_proc.mkdir(parents=True, exist_ok=True)

    results = {}
    for key, res, n, tf, resamp in (("dtm", dres, nd, dem_tf, Resampling.average),
                                    ("ortho", tres, nt, tex_tf, Resampling.average)):
        p = prods[key]
        print(f"\n[{key}] {p['id']}")
        with rasterio.open("/vsicurl/" + p["url"]) as src:
            check_header(key, src, p["expected"])
            # Source window: tile footprint in the source CRS + margin
            xs, ys = warp_transform(geo_crs, src.crs, [lon_w, lon_e], [lat_s, lat_n])
            m = 8 * src.res[0] + 4
            sb = (min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m)
            if not (src.bounds.left <= sb[0] and sb[2] <= src.bounds.right
                    and src.bounds.bottom <= sb[1] and sb[3] <= src.bounds.top):
                fail(f"{key}: tile is not fully inside the product bounds {src.bounds}")
            win = from_bounds(*sb, transform=src.transform).round_offsets().round_lengths()
            arr = read_window_chunked(src, win, key)
            win_tf = src.window_transform(win)
            dst = np.full((n, n), src.nodata, dtype=arr.dtype)
            reproject(arr, dst, src_transform=win_tf, src_crs=src.crs, src_nodata=src.nodata,
                      dst_transform=tf, dst_crs=local_crs, dst_nodata=src.nodata, resampling=resamp)
            results[key] = dict(src_arr=arr, src_tf=win_tf, src_crs=src.crs, dst=dst, nodata=src.nodata)

            profile = dict(driver="GTiff", width=n, height=n, count=1, dtype=arr.dtype, crs=local_crs,
                           transform=tf, nodata=src.nodata, compress="deflate", tiled=True)
            with rasterio.open(out_proc / f"{key}_local.tif", "w", **profile) as o:
                o.write(dst, 1)

    # ---------------- validation ----------------
    print("\nValidation")
    dem, dnod = results["dtm"]["dst"], results["dtm"]["nodata"]
    bad = np.count_nonzero(~np.isfinite(dem) | np.isclose(dem, dnod, rtol=1e-6) | (dem < -1e30))
    if bad:
        fail(f"heightmap contains {bad} NoData cells - move the tile inside DTM coverage")
    emin, emax = float(dem.min()), float(dem.max())
    ex = prods["dtm"]["expected"]
    if emin < ex["valid_min"] - 1e-3 or emax > ex["valid_max"] + 1e-3:
        fail(f"elevation range {emin:.2f}..{emax:.2f} outside documented {ex['valid_min']}..{ex['valid_max']}")
    print(f"  [ok] no NoData; elevation {emin:.2f} .. {emax:.2f} m (within documented product range)")

    tex = results["ortho"]["dst"]
    zero_frac = np.count_nonzero(tex == 0) / tex.size
    if zero_frac > 0.001:
        fail(f"texture has {zero_frac*100:.2f}% NoData (0) pixels")
    print(f"  [ok] texture NoData fraction {zero_frac*100:.4f}%")

    rng = np.random.default_rng(42)
    lats = rng.uniform(lat_s + 0.1 * (lat_n - lat_s), lat_n - 0.1 * (lat_n - lat_s), val["n_check_points"])
    lons = rng.uniform(lon_w + 0.1 * (lon_e - lon_w), lon_e - 0.1 * (lon_e - lon_w), val["n_check_points"])

    # (a) closed-form local eqc formulas (used by the browser) vs PROJ
    lx, ly = warp_transform(geo_crs, local_crs, lons.tolist(), lats.tolist())
    geo_err = 0.0
    for la, lo, x, y in zip(lats, lons, lx, ly):
        la2 = lat_c + math.degrees(y / R)
        lo2 = lon_c + math.degrees(x / k)
        geo_err = max(geo_err, abs(la2 - la) * math.pi / 180 * R, abs(lo2 - lo) * math.pi / 180 * k)
    if geo_err > 0.001:
        fail(f"closed-form inverse differs from PROJ by {geo_err:.4f} m")
    print(f"  [ok] browser lat/lon formulas match PROJ (max error {geo_err*1000:.3f} mm)")

    # (b) heights: output grid vs original source DTM at the same lat/lon
    r = results["dtm"]
    sx, sy = warp_transform(geo_crs, r["src_crs"], lons.tolist(), lats.tolist())
    diffs = np.array([bilinear(dem, dem_tf, x, y) - bilinear(r["src_arr"], r["src_tf"], a, b)
                      for x, y, a, b in zip(lx, ly, sx, sy)])
    med, p95 = float(np.median(np.abs(diffs))), float(np.percentile(np.abs(diffs), 95))
    print(f"  heights vs source DTM at {len(diffs)} random points: median |d| = {med:.3f} m, "
          f"p95 = {p95:.3f} m, max = {np.abs(diffs).max():.3f} m")
    if med > val["max_median_abs_diff_m"] or p95 > val["max_p95_abs_diff_m"]:
        fail("heightmap deviates from the source DTM more than allowed")
    print("  [ok] heights agree with the source DTM")

    # ---------------- export ----------------
    dem.astype("<f4").tofile(out_web / "heightmap.bin")
    Image.fromarray(tex, mode="L").save(out_web / "texture.jpg", quality=92, optimize=True)

    def credit(p):
        return {k_: p[k_] for k_ in ("id", "title", "mission", "instrument", "doi", "url")}

    meta = {
        "site": {"id": site["id"], "name": site["name"]},
        "body": {"name": body["name"], "radius_m": R},
        "center": {"lat": lat_c, "lon": lon_c,
                   "latitude_type": "planetocentric", "longitude_direction": "east-positive"},
        "projection": local_proj,
        "extent_m": {"west": x0, "north": y0, "east": -x0, "south": -y0},
        "bounds_deg": {"west": lon_w, "east": lon_e, "south": lat_s, "north": lat_n},
        "heightmap": {"file": "heightmap.bin", "format": "float32-le", "width": nd, "height": nd,
                      "spacing_m": dres, "row0": "north", "registration": "pixel-is-area (values at cell centres)",
                      "units": prods["dtm"]["units"], "min": emin, "max": emax,
                      "vertical_reference": prods["dtm"]["vertical_reference"],
                      "resampling": "area average from 1 m source"},
        "texture": {"file": "texture.jpg", "width": nt, "height": nt, "pixel_m": tres,
                    "resampling": "area average from 0.25 m source", "bands": "HiRISE red (grayscale)"},
        "products": {"dtm": credit(prods["dtm"]), "ortho": credit(prods["ortho"])},
        "resolution": {"dem_native_m": prods["dtm"]["expected"]["pixel_size_m"],
                       "image_native_m": prods["ortho"]["expected"]["pixel_size_m"]},
        "sources": [source("elevation", prods["dtm"]), source("imagery", prods["ortho"])],
        "validation": {"heights_median_abs_diff_m": med, "heights_p95_abs_diff_m": p95,
                       "geolocation_formula_max_error_m": geo_err, "n_points": len(diffs),
                       "status": "pass",
                       "checks": [
                           check_rec("Product headers match documented values", True),
                           check_rec("No NoData in heightmap", True, f"{emin:.1f} .. {emax:.1f} m"),
                           check_rec("Texture NoData fraction", True, f"{zero_frac*100:.4f} %"),
                           check_rec("Heights vs source DTM", True, f"median {med:.3f} m, p95 {p95:.3f} m"),
                           check_rec("Browser lat/lon formulas vs PROJ", True, f"{geo_err*1000:.3f} mm"),
                       ]},
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out_web / "meta.json").write_text(json.dumps(meta, indent=2))
    add_context(cfg, out_web)
    add_color(cfg, out_web)
    add_thermal(cfg, out_web)
    print(f"\nWrote {out_web}/heightmap.bin, texture.jpg, context.*, meta.json")
    return out_web



# =============================================================================================
# Shared helpers for meta.json
# =============================================================================================
def check_rec(name, ok, value="", level=None):
    return {"name": name, "ok": bool(ok), "level": level or ("pass" if ok else "fail"), "value": value}


def source(role, p):
    return {"role": role, **{k: p.get(k) for k in ("id", "title", "mission", "instrument", "doi", "citation",
                                                    "info", "url")}}


def footprint(lat_c, lon_c, S, R):
    """Closed-form lon/lat bounds of a square local-eqc tile (edge S metres) centred on lat_c/lon_c."""
    k = R * math.cos(math.radians(lat_c))
    return (lon_c - math.degrees(S / 2 / k), lon_c + math.degrees(S / 2 / k),
            lat_c - math.degrees(S / 2 / R), lat_c + math.degrees(S / 2 / R))


# =============================================================================================
# "global" profile: HRSC-MOLA blended DEM (windowed /vsicurl/ read) + CTX beta01 WMTS tiles
# =============================================================================================
_megdr = None
_ctx_service = None
_lock = threading.Lock()


def site_id(lat, lon, size_km):
    """Cache key; the site centre IS the rounded point (0.01 deg ~ 590 m), so the id is honest. The "_f" suffix marks
    sites built with the fixed surroundings square (context.global_edge_m), so older cached sites are not reused."""
    return f"g{round(lat, 2):+07.2f}{round(lon, 2):+08.2f}_{int(size_km)}km_f".replace("+", "p").replace("-", "m")


def context_edge_m(cfg, S_main, fixed=False):
    """Edge of the surroundings square: fixed for "Land here" sites, 8 x the tile (clamped) for the HiRISE tile."""
    cx = cfg["global"]["context"]
    if fixed:
        return float(cx["global_edge_m"])
    return float(min(max(cx["factor"] * S_main, cx["min_m"]), cx["max_m"]))


def check_header_geo(name, src, exp):
    proj = src.crs.to_proj4()
    for token in exp["proj_contains"]:
        if token not in proj:
            fail(f"{name}: CRS '{proj}' lacks documented token '{token}'")
    a, _, x0, _, e, y0 = tuple(src.transform)[:6]
    if not (math.isclose(a, exp["pixel_size_deg"], rel_tol=1e-9) and math.isclose(-e, exp["pixel_size_deg"], rel_tol=1e-9)):
        fail(f"{name}: pixel size {a}, {e} deg != documented {exp['pixel_size_deg']}")
    if (x0, y0) != tuple(exp["origin_deg"]):
        fail(f"{name}: origin {(x0, y0)} != documented {exp['origin_deg']}")
    if (src.width, src.height) != (exp["width"], exp["height"]):
        fail(f"{name}: size {src.width}x{src.height} != documented {exp['width']}x{exp['height']}")
    if src.dtypes[0] != exp["dtype"] or src.nodata != exp["nodata"]:
        fail(f"{name}: dtype/nodata {src.dtypes[0]}/{src.nodata} != documented {exp['dtype']}/{exp['nodata']}")
    if src.tags().get("AREA_OR_POINT", "Area") != "Area":
        fail(f"{name}: expected pixel-is-area registration")


_tls = threading.local()
# One long-lived pool for all tile/row downloads: its threads keep their keep-alive HTTPS connections between
# builds (a new TLS handshake costs ~0.5-1 s per thread). Pool tasks only download/decode, never submit.
HTTP_POOL = ThreadPoolExecutor(48, thread_name_prefix="http")


def http_get(url, timeout=15, headers=None):
    """GET with a per-thread keep-alive HTTPS connection (a fresh TLS handshake costs ~0.5-1 s on these hosts).
    Returns (status, body); 400/404 are returned, other errors are retried."""
    u = urlsplit(url)
    path = u.path + (f"?{u.query}" if u.query else "")
    hdrs = {"User-Agent": "red-atlas-pipeline/1.0", **(headers or {})}
    for attempt in range(4):
        conns = getattr(_tls, "conns", None) or {}
        _tls.conns = conns
        conn = conns.get(u.netloc)
        if conn is None:
            conn = conns[u.netloc] = http.client.HTTPSConnection(u.netloc, timeout=timeout)
        try:
            conn.request("GET", path, headers=hdrs)
            r = conn.getresponse()
            body = r.read()
            if r.status in (200, 206, 400, 404):
                return r.status, body
            err = f"HTTP {r.status}"
        except (http.client.HTTPException, OSError) as e:
            err = repr(e)
        conn.close()
        conns.pop(u.netloc, None)
        if attempt == 3:
            raise SiteError(f"download failed: {url} ({err})")
        time.sleep(0.5 + attempt)


def ctx_service(img):
    """Fetch the ArcGIS service JSON once and check it against the documented tiling."""
    global _ctx_service
    with _lock:
        if _ctx_service is None:
            st, body = http_get(img["service_json"])
            if st != 200:
                fail(f"CTX service JSON HTTP {st}")
            _ctx_service = json.loads(body)
    j, ex = _ctx_service, img["expected"]
    ti = j["tileInfo"]
    wkt = ti["spatialReference"]["wkt"]
    for t in ex["wkt_contains"]:
        if t not in wkt:
            fail(f"CTX: spatial reference lacks '{t}'")
    if (ti["origin"]["x"], ti["origin"]["y"]) != tuple(ex["origin_deg"]) or ti["rows"] != ex["tile_px"] or ti["cols"] != ex["tile_px"]:
        fail("CTX: tile origin/size differ from documented values")
    lods = {l["level"]: l["resolution"] for l in ti["lods"]}
    if not math.isclose(lods[ex["max_level"]], ex["level_res_deg"], rel_tol=1e-12):
        fail(f"CTX: level {ex['max_level']} resolution {lods[ex['max_level']]} != documented {ex['level_res_deg']}")
    return lods


def megdr():
    """PDS MOLA MEGDR 32 ppd (metres above areoid), memory-mapped."""
    global _megdr
    with _lock:
        if _megdr is None:
            f = ROOT / "data" / "raw" / "globe" / "megt90n000fb.img"
            if not f.exists():
                fail(f"{f} missing - run pipeline/build_globe.py first")
            _megdr = np.memmap(f, dtype=">i2", mode="r", shape=(5760, 11520))
    return _megdr


def megdr_sample(lats, lons):
    m = megdr()
    r = (90 - lats) * 32 - 0.5
    c = (np.mod(lons, 360)) * 32 - 0.5
    r0, c0 = np.floor(r).astype(int), np.floor(c).astype(int)
    fr, fc = r - r0, c - c0
    r0 = np.clip(r0, 0, 5758)
    g = lambda rr, cc: m[rr, np.mod(cc, 11520)].astype(np.float64)
    return (g(r0, c0) * (1 - fr) * (1 - fc) + g(r0, c0 + 1) * (1 - fr) * fc
            + g(r0 + 1, c0) * fr * (1 - fc) + g(r0 + 1, c0 + 1) * fr * fc)


def col_segments(c0, W, width):
    """Split columns c0..c0+W-1 (may run past either edge of a global raster) into in-file pieces
    [(file_col, n), ...] in output order: longitude wraps at +-180 deg."""
    segs, c, left = [], c0, W
    while left > 0:
        fc = c % width
        n = min(left, width - fc)
        segs.append((fc, n))
        c += n
        left -= n
    return segs


def relief_fill(tex, dem, sun_az=315.0, sun_el=35.0):
    """Last-resort fill for pixels CTX never imaged: shaded relief of the DEM (any resolution), scaled to the
    brightness of the real imagery around it. Returns the filled fraction."""
    hole = tex == 0
    if not hole.any():
        return 0.0
    gy, gx = np.gradient(np.nan_to_num(dem.astype(np.float64), nan=float(np.nanmean(dem)) if np.isfinite(dem).any() else 0.0))
    az, el = np.radians(sun_az), np.radians(sun_el)
    shade = np.clip(np.sin(el) + np.cos(el) * (np.sin(az) * gx - np.cos(az) * gy) / 50.0, 0, 1)
    sh = np.asarray(Image.fromarray(shade.astype(np.float32), mode="F").resize(tex.shape[::-1], Image.BILINEAR))
    good = ~hole
    if good.sum() > 100:
        m, sd = float(tex[good].mean()), float(tex[good].std()) or 20.0
    else:
        m, sd = 128.0, 25.0
    v = (sh - sh.mean()) / (sh.std() or 1.0) * sd * 0.6 + m
    tex[hole] = np.clip(v[hole], 1, 255).astype(np.uint8)
    return float(hole.mean())


def read_dem_ranges(url, win, src, exp, step=1):
    """The blended DEM GeoTIFF is uncompressed with one row per strip (ISIS label: BandSequential, SignedWord LSB,
    core at StartByte). Fetch only the needed bytes of each row with parallel HTTP range requests (GDAL would pull
    the whole 213 KB strip per row), then cross-check the middle row against GDAL's own read.
    step > 1 reads every step-th row and keeps every step-th column (subsampling, used for the context ring)."""
    if src.compression is not None or src.block_shapes[0] != (1, exp["width"]):
        fail("dem: expected an uncompressed 1-row-strip GeoTIFF (label: BandSequential)")
    c0, r0, W, H = int(win.col_off), int(win.row_off), int(win.width), int(win.height)
    base = exp["core_start_byte"] - 1
    rows = list(range(0, H, step))
    out = np.empty((len(rows), W), dtype="<i2")

    segs = col_segments(c0, W, exp["width"])          # >1 piece when the site straddles +-180 deg

    def rd(i):
        parts = []
        for fc, n in segs:
            off = base + ((r0 + rows[i]) * exp["width"] + fc) * 2
            st, body = http_get(url, headers={"Range": f"bytes={off}-{off + 2 * n - 1}"})
            if st != 206 or len(body) != 2 * n:
                fail(f"dem: range read returned HTTP {st}, {len(body)} bytes (expected 206, {2 * n})")
            parts.append(np.frombuffer(body, dtype="<i2"))
        out[i] = np.concatenate(parts)
    mid = len(rows) // 2
    fc0, n0 = segs[0]
    with ThreadPoolExecutor(1) as ex:   # GDAL cross-check of the first in-file piece of the middle row
        ref = ex.submit(lambda: src.read(1, window=Window(fc0, r0 + rows[mid], n0, 1))[0])  # only this thread uses src
        list(HTTP_POOL.map(rd, range(len(rows))))
        ref = ref.result()
    if not np.array_equal(ref, out[mid, :n0]):
        fail("dem: byte-range read disagrees with GDAL's read (file layout differs from the label)")
    if len(segs) > 1:
        # Meridian seam: the file's last column (179.998 E) is NoData padding in places. Interpolate those cells
        # from their east/west neighbours (the seam geometry is exact to < 0.5 px = 100 m; see DATA_SOURCES.md).
        seam = segs[0][1] - 1
        col = out[:, seam]
        bad = col == exp["nodata"]
        if bad.any() and 0 < seam < W - 1:
            l, r = out[:, seam - 1].astype(np.int32), out[:, seam + 1].astype(np.int32)
            okn = (l != exp["nodata"]) & (r != exp["nodata"])
            col[bad & okn] = ((l + r) // 2)[bad & okn]
    return out[:, ::step]


def choose_level(img, lods, lon_w, lon_e, lat_s, lat_n):
    """Finest CTX level within the tile budget that actually has imagery at the site centre."""
    ex, tp = img["expected"], img["expected"]["tile_px"]

    def count(z):
        span = lods[z] * tp
        return ((int((lon_e + 180) // span) - int((lon_w + 180) // span) + 1)
                * (int((90 - lat_s) // span) - int((90 - lat_n) // span) + 1))
    z = ex["max_level"]
    while z > img["min_level"] and count(z) > img["max_tiles"]:
        z -= 1
    # The service's level-12 cache has regional holes (e.g. Arcadia 45N 150W returns 404 at levels 11-12 but
    # real CTX at level 10): probe the centre tile and step down.
    lon_c, lat_c = (lon_w + lon_e) / 2, (lat_s + lat_n) / 2
    while z > img["min_level"]:
        span = lods[z] * tp
        try:
            st, _ = http_get(img["url"].format(z=z, row=int((90 - lat_c) // span),
                                               col=int((lon_c + 180) // span) % round(360 / span)))
        except SiteError:         # persistent 5xx on the probe tile: try the next level
            st = 0
        if st == 200:
            break
        z -= 1
    return z


def fetch_ctx(img, lods, lon_w, lon_e, lat_s, lat_n, progress, z):
    """Mosaic the CTX tiles at level z covering the footprint (404 / truncated tiles stay 0 = NoData)."""
    tp = img["expected"]["tile_px"]
    res = lods[z]
    span = res * tp
    c0, c1 = int((lon_w + 180) // span), int((lon_e + 180) // span)
    r0, r1 = int((90 - lat_n) // span), int((90 - lat_s) // span)
    ncols = round(360 / span)
    tiles = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    mosaic = np.zeros(((r1 - r0 + 1) * tp, (c1 - c0 + 1) * tp), dtype=np.uint8)
    done, missing, truncated = [0], [0], [0]

    def get(rc):
        r, c = rc
        trunc = False
        for attempt in range(3):
            try:
                st, body = http_get(img["url"].format(z=z, row=r, col=c % ncols))   # wrap at +-180 deg
            except SiteError:             # persistent 5xx / network error on one tile: treat as missing
                st, body = 0, b""
            if st != 200:
                break
            try:
                im = Image.open(io.BytesIO(body))
                im.load()
                trunc = False
                break
            except OSError:
                # Some tiles are stored truncated on the server (full Content-Length, PNG stream ends early;
                # same bytes on every fetch). They are Adam7-interlaced, so a partial decode is garbage:
                # treat the whole tile as NoData and let the coarser-level fill cover it.
                trunc = True
            _tls.conns = {}
        if trunc:
            truncated[0] += 1
            st = 0
        if st == 200:
            if im.size != (tp, tp):
                fail(f"CTX tile {z}/{r}/{c} is {im.size}, documented {tp}x{tp}")
            a = np.asarray(im.convert("L") if im.mode != "L" else im)
            mosaic[(r - r0) * tp:(r - r0 + 1) * tp, (c - c0) * tp:(c - c0 + 1) * tp] = a
        elif not trunc:
            missing[0] += 1           # 404 = no CTX coverage -> stays 0 (NoData)
        done[0] += 1
        progress("imagery", done[0] / len(tiles))
    list(HTTP_POOL.map(get, tiles))
    tf = from_origin(-180 + c0 * span, 90 - r0 * span, res, res)
    return mosaic, tf, z, res, len(tiles), missing[0], truncated[0]


def tile_consistency(mosaic, tf, coarse, ctf, tp, min_r):
    """Reject fine tiles whose content disagrees with the 4x-coarser overview (the service has a few tiles with
    the wrong scene, e.g. 12/2154/7223 at Gale). Pearson r of the 4x box-averaged tile vs the overview block."""
    f = round(ctf.a / tf.a)
    rejected, rs = 0, []
    for r in range(0, mosaic.shape[0], tp):
        for c in range(0, mosaic.shape[1], tp):
            t = mosaic[r:r + tp, c:c + tp]
            if not t.any():
                continue
            # overview block covering this tile
            x, y = tf * (c, r)
            cc, cr = ~ctf * (x, y)
            cc, cr = int(round(cc)), int(round(cr))
            blk = coarse[cr:cr + tp // f, cc:cc + tp // f].astype(np.float64)
            small = t.reshape(tp // f, f, tp // f, f).astype(np.float64).mean(axis=(1, 3))
            if blk.shape != small.shape:
                continue
            ok = (blk > 0) & (small > 0)
            if ok.mean() < 0.5:
                continue
            a, b = small[ok] - small[ok].mean(), blk[ok] - blk[ok].mean()
            den = math.sqrt(float(a @ a) * float(b @ b))
            rr = float(a @ b) / den if den > 0 else 1.0
            rs.append(rr)
            if rr < min_r:
                mosaic[r:r + tp, c:c + tp] = 0
                rejected += 1
    return rejected, rs


def ntiles_at_max_exceeds_budget(img, lods, lon_w, lon_e, lat_s, lat_n):
    """True when a coarser level was chosen only to stay within the tile budget (expected, not a data gap)."""
    span = lods[img["expected"]["max_level"]] * img["expected"]["tile_px"]
    n = ((int((lon_e + 180) // span) - int((lon_w + 180) // span) + 1)
         * (int((90 - lat_s) // span) - int((90 - lat_n) // span) + 1))
    return n > img["max_tiles"]


def box_blur(a, r):
    """Separable box mean of radius r cells (edge-normalised), via cumulative sums."""
    def one(x, axis):
        x = np.moveaxis(x, axis, 0)
        c = np.cumsum(np.pad(x, ((1, 0),) + ((0, 0),) * (x.ndim - 1)), axis=0)
        n = x.shape[0]
        lo, hi = np.clip(np.arange(n) - r, 0, n), np.clip(np.arange(n) + r + 1, 0, n)
        return np.moveaxis((c[hi] - c[lo]) / (hi - lo)[:, None], 0, axis)
    return one(one(a, 0), 1)


def highpass(a, r):
    b = a
    for _ in range(2):                    # two box passes ~ Gaussian
        b = box_blur(b, r)
    return a - b


def registration(tex, dem, S, grid_m, search_m, hp_m=1000.0):
    """Sun-agnostic check that the uncontrolled CTX image lines up with the DEM.

    For a Lambertian surface, brightness ~ a*dz/dx + b*dz/dy + c for ANY sun direction (first order), so for each
    trial shift we fit that model by least squares and keep R^2. The shift with the best R^2 is the measured offset.
    """
    n = int(round(S / grid_m))
    I = np.asarray(Image.fromarray(tex).resize((n, n), Image.BOX), dtype=np.float64)
    Z = np.asarray(Image.fromarray(dem.astype(np.float32), mode="F").resize((n, n), Image.BILINEAR), dtype=np.float64)
    gy, gx = np.gradient(Z, grid_m)
    # Remove regional albedo / slope trends (> ~1 km), which otherwise pull the peak to the search edge.
    hr = max(1, int(round(hp_m / grid_m / 2)))
    I, gx, gy = highpass(I, hr), highpass(gx, hr), highpass(gy, hr)
    k = int(round(search_m / grid_m))
    G = np.stack([gx[k:n - k, k:n - k].ravel(), gy[k:n - k, k:n - k].ravel(), np.ones((n - 2 * k) ** 2)], 1)
    M = np.linalg.inv(G.T @ G)

    def r2_at(dy, dx):
        y = I[k + dy:n - k + dy, k + dx:n - k + dx].ravel()
        y = y - y.mean()
        ss = float(y @ y)
        if ss <= 0:
            return None
        b = G.T @ y
        return float(b @ M @ b) / ss          # explained / total variance of the least-squares fit
    best = (-1.0, 0, 0)
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            r = r2_at(dy, dx)
            if r is not None and r > best[0]:
                best = (r, dx, dy)
    r0 = r2_at(0, 0)
    r2, dx, dy = best
    # Image content at +dx cols (east) / +dy rows (south) matches the DEM: image is displaced by (+dx E, -dy N).
    return {"r2_best": r2, "r2_zero_shift": r0, "offset_east_m": dx * grid_m, "offset_north_m": -dy * grid_m,
            "grid_m": grid_m, "search_m": search_m, "highpass_m": hp_m, "at_search_edge": max(abs(dx), abs(dy)) == k}


def build_global(cfg, lat_c, lon_c, size_km, out_web, progress=lambda stage, frac: None):
    g, R = cfg["global"], float(cfg["body"]["radius_m"])
    dem_p, img = g["dem"], g["image"]
    V = g["validation"]
    lat_c, lon_c = round(float(lat_c), 2), round(float(lon_c), 2)
    if size_km not in g["sizes_km"]:
        fail(f"size {size_km} km not in {g['sizes_km']}")
    if abs(lat_c) > g["max_abs_lat"]:
        fail(f"|lat| > {g['max_abs_lat']} deg not supported (local equirectangular tiles distort near the poles)")
    S = size_km * 1000.0
    lon_w, lon_e, lat_s, lat_n = footprint(lat_c, lon_c, S, R)
    nd = int(g["heightmap_px"])
    dres = S / nd
    nt = int(min(g["texture_max_px"], 2 ** math.ceil(math.log2(S / img["native_m"]))))
    tres = S / nt
    x0, y0 = -S / 2, S / 2
    dem_tf, tex_tf = from_origin(x0, y0, dres, dres), from_origin(x0, y0, tres, tres)
    local_proj = f"+proj=eqc +lat_ts={lat_c} +lat_0={lat_c} +lon_0={lon_c} +x_0=0 +y_0=0 +R={R} +units=m +no_defs"
    # All warps run in longitude RELATIVE to the site centre (source transforms shifted by -lon_c, local frame with
    # lon_0 = 0). The maths is identical, and a site straddling the 180 deg meridian never meets a wrap: source
    # windows use continuous longitude (e.g. 179.6 .. 180.3) and the raster readers wrap the columns.
    geo_crs = CRS.from_proj4(f"+proj=longlat +R={R} +no_defs")
    local_crs = CRS.from_proj4(f"+proj=eqc +lat_ts={lat_c} +lat_0={lat_c} +lon_0=0 +x_0=0 +y_0=0 +R={R} +units=m +no_defs")
    rel = lambda t: rasterio.Affine.translation(-lon_c, 0) * t
    t0 = time.time()
    tmp = out_web.with_name(out_web.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    ctx_pool = ThreadPoolExecutor(1)
    f_ctx = ctx_pool.submit(build_context, cfg, lat_c, lon_c, S, tmp, fixed=True)    # surroundings, in parallel with the site
    print(f"Global site {lat_c}, {lon_c}, {size_km} km: lat {lat_s:.4f}..{lat_n:.4f}, lon {lon_w:.4f}..{lon_e:.4f}")

    # ---- elevation (runs concurrently with the imagery download)
    def do_dem():
        progress("elevation", 0.0)
        with rasterio.open("/vsicurl/" + dem_p["url"]) as src:
            check_header_geo("dem", src, dem_p["expected"])
            m = 3 * src.res[0]
            win = from_bounds(lon_w - m, lat_s - m, lon_e + m, lat_n + m, transform=src.transform)
            win = win.round_offsets().round_lengths()
            src_tf, src_crs, nod = src.window_transform(win), src.crs, src.nodata
            td = time.time()
            arr = read_dem_ranges(dem_p["url"], win, src, dem_p["expected"])
        print(f"  DEM window {arr.shape[1]}x{arr.shape[0]} read in {time.time()-td:.1f}s")
        progress("elevation", 1.0)
        a32 = arr.astype(np.float32)
        a32[arr == nod] = np.nan
        dst = np.full((nd, nd), np.nan, dtype=np.float32)
        reproject(a32, dst, src_transform=rel(src_tf), src_crs=geo_crs, src_nodata=np.nan,
                  dst_transform=dem_tf, dst_crs=local_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
        return arr, src_tf, src_crs, nod, dst

    with ThreadPoolExecutor(3) as ex:
        f_dem = ex.submit(do_dem)
        lods = ctx_service(img)
        z = choose_level(img, lods, lon_w, lon_e, lat_s, lat_n)
        fz = z - 2 if z - 2 >= img["min_level"] else None
        f_ov = ex.submit(fetch_ctx, img, lods, lon_w, lon_e, lat_s, lat_n, lambda *_: None, fz) if fz else None
        mosaic, mtf, z, mres, ntiles, nmiss, ntrunc = fetch_ctx(img, lods, lon_w, lon_e, lat_s, lat_n, progress, z)
        src_arr, src_tf, src_crs, nod, dem = f_dem.result()
        ov = f_ov.result() if f_ov else None
    t_dl = time.time() - t0
    print(f"  CTX level {z}: {ntiles} tiles ({nmiss} without coverage); downloads done at {t_dl:.1f}s")
    print(f"    [{time.time()-t0:5.1f}s] after dl")
    progress("processing", 0.0)
    img_native_m = mres * math.pi / 180 * R

    def to_tex(src, stf, resampling):
        out = np.zeros((nt, nt), dtype=np.uint8)
        reproject(src, out, src_transform=rel(stf), src_crs=geo_crs, src_nodata=0, dst_transform=tex_tf,
                  dst_crs=local_crs, dst_nodata=0, resampling=resampling, num_threads=os.cpu_count() or 4)
        return out
    fine_resampling = Resampling.average if tres > img_native_m else Resampling.bilinear
    print(f"    [{time.time()-t0:5.1f}s] after reproject")
    # Overview 4x coarser: (1) reject fine tiles that disagree with it, (2) fill NoData (missing / truncated /
    # rejected tiles) from it, and report how much was filled.
    filled, nrej = 0.0, 0
    if ov:
        fm, ftf = ov[0], ov[1]
        nrej, rs = tile_consistency(mosaic, mtf, fm, ftf, img["expected"]["tile_px"], V["tile_min_r"])
        if rs:
            print(f"  tile vs overview r: min {min(rs):.2f}, median {np.median(rs):.2f}; rejected {nrej}")
    tex = to_tex(mosaic, mtf, fine_resampling)
    if ov:
        if np.any(tex == 0):
            ftex = to_tex(fm, ftf, Resampling.bilinear)
            hole = (tex == 0) & (ftex > 0)
            filled = float(hole.mean())
            tex[hole] = ftex[hole]
            print(f"  filled {filled*100:.2f}% of the texture from CTX level {fz}")
    # Still holes (the service has regional gaps at several levels): keep stepping down the pyramid.
    fill_levels = [fz] if filled else []
    lvl = (fz if fz is not None else z) - 2
    while np.any(tex == 0) and lvl >= img["min_level"] - 3 and lvl >= 3:
        cm_, ctf_, *_ = fetch_ctx(img, lods, lon_w, lon_e, lat_s, lat_n, lambda *_: None, lvl)
        ctex = to_tex(cm_, ctf_, Resampling.bilinear)
        hole = (tex == 0) & (ctex > 0)
        if hole.any():
            tex[hole] = ctex[hole]
            filled += float(hole.mean())
            fill_levels.append(lvl)
            print(f"  filled {hole.mean()*100:.2f}% more from CTX level {lvl}")
        lvl -= 2
    no_ctx = float(np.count_nonzero(tex == 0)) / tex.size     # never imaged by CTX at any level here
    relief = relief_fill(tex, dem) if no_ctx else 0.0
    if relief:
        print(f"  {relief*100:.2f}% has no CTX at any level: filled with DEM shaded relief")

    print(f"    [{time.time()-t0:5.1f}s] after overview+fill")
    # ---- validation
    checks = []
    checks.append(check_rec("Product headers match documented values", True,
                            "DEM GeoTIFF header + CTX service tiling"))
    bad = int(np.count_nonzero(~np.isfinite(dem)))
    if bad:
        fail(f"heightmap contains {bad} NoData cells (no DEM coverage here)")
    emin, emax = float(dem.min()), float(dem.max())
    ex_ = dem_p["expected"]
    if emin < ex_["valid_min"] or emax > ex_["valid_max"]:
        fail(f"elevation {emin:.1f}..{emax:.1f} outside documented product range {ex_['valid_min']}..{ex_['valid_max']}")
    checks.append(check_rec("No NoData in heightmap", True, f"{emin:.0f} .. {emax:.0f} m"))

    gap = no_ctx
    gap_ok = gap <= V["texture_gap_warn"] and filled <= V["texture_gap_warn"]
    detail = []
    if filled:
        detail.append(f"{filled*100:.1f} % filled from coarser CTX (level {', '.join(map(str, fill_levels))}; "
                      f"{ntrunc} truncated, {nmiss} missing, {nrej} inconsistent server tiles)")
    if relief:
        detail.append(f"{relief*100:.1f} % never imaged by CTX here - shown as shaded relief from the DEM")
    checks.append(check_rec("Imagery coverage (CTX gaps)", gap_ok,
                            "; ".join(detail) if detail else "complete", level="pass" if gap_ok else "warn"))

    full = z == img["expected"]["max_level"] or ntiles_at_max_exceeds_budget(img, lods, lon_w, lon_e, lat_s, lat_n)
    checks.append(check_rec("Imagery resolution", full, f"CTX level {z}, {img_native_m:.1f} m/px"
                            + ("" if full else " (finer CTX tiles unavailable here)"), level="pass" if full else "warn"))

    rng = np.random.default_rng(42)
    lats = rng.uniform(lat_s + 0.1 * (lat_n - lat_s), lat_n - 0.1 * (lat_n - lat_s), 25)
    lons = rng.uniform(lon_w + 0.1 * (lon_e - lon_w), lon_e - 0.1 * (lon_e - lon_w), 25)
    lx, ly = warp_transform(geo_crs, local_crs, (lons - lon_c).tolist(), lats.tolist())
    k = R * math.cos(math.radians(lat_c))
    geo_err = max(max(abs(lat_c + math.degrees(y / R) - la) * math.pi / 180 * R,
                      abs(lon_c + math.degrees(x / k) - lo) * math.pi / 180 * k)
                  for la, lo, x, y in zip(lats, lons, lx, ly))
    if geo_err > 0.001:
        fail(f"closed-form inverse differs from PROJ by {geo_err:.4f} m")
    checks.append(check_rec("Browser lat/lon formulas vs PROJ", True, f"{geo_err*1000:.3f} mm"))

    src_f = src_arr.astype(np.float64)
    diffs = np.array([bilinear(dem, dem_tf, x, y) - bilinear(src_f, src_tf, lo, la)
                      for x, y, lo, la in zip(lx, ly, lons, lats)])
    med, p95 = float(np.median(np.abs(diffs))), float(np.percentile(np.abs(diffs), 95))
    if med > 1.0 or p95 > 5.0:
        fail(f"heightmap deviates from the source DEM (median {med:.2f} m, p95 {p95:.2f} m)")
    checks.append(check_rec("Heights vs source DEM", True, f"median {med:.3f} m, p95 {p95:.3f} m"))

    print(f"    [{time.time()-t0:5.1f}s] after basic checks")
    # MOLA MEGDR over exactly the same footprint (every 8th heightmap cell)
    cc = (np.arange(0, nd, 8) + 0.5) * dres + x0
    XX, YY = np.meshgrid(cc, y0 - (np.arange(0, nd, 8) + 0.5) * dres)
    LA = lat_c + np.degrees(YY / R)
    LO = lon_c + np.degrees(XX / k)
    mola = megdr_sample(LA.ravel(), LO.ravel())
    sub = dem[::8, ::8].ravel().astype(np.float64)
    mean_diff = float(sub.mean() - mola.mean())
    rms_diff = float(np.sqrt(np.mean((sub - mola) ** 2)))
    if abs(mean_diff) > V["megdr_max_mean_diff_m"]:
        fail(f"DEM mean differs from MOLA MEGDR by {mean_diff:.1f} m (> {V['megdr_max_mean_diff_m']} m)")
    checks.append(check_rec("DEM vs MOLA MEGDR (areoid)", True, f"mean {mean_diff:+.1f} m, rms {rms_diff:.1f} m"))

    print(f"    [{time.time()-t0:5.1f}s] after megdr")
    tr = time.time()
    reg = registration(tex, dem, S, V["registration_grid_m"], V["registration_search_m"])
    print(f"  registration search {time.time()-tr:.1f}s")
    off = math.hypot(reg["offset_east_m"], reg["offset_north_m"])
    if reg["r2_best"] < V["registration_min_r2"]:
        lvl, val = "warn", f"inconclusive (too little relief texture, R² {reg['r2_best']:.2f})"
    elif reg["at_search_edge"]:
        lvl, val = "warn", f"inconclusive (no clear peak within ±{reg['search_m']:.0f} m)"
    elif off <= V["registration_pass_m"]:
        lvl, val = "pass", f"offset {off:.0f} m (R² {reg['r2_best']:.2f})"
    else:
        lvl, val = "warn", (f"imagery offset ≈ {reg['offset_east_m']:+.0f} m E, {reg['offset_north_m']:+.0f} m N "
                            f"(R² {reg['r2_best']:.2f}) - uncontrolled mosaic")
    checks.append(check_rec("CTX imagery registered to DEM", lvl == "pass", val, level=lvl))
    status = "warn" if any(c["level"] == "warn" for c in checks) else "pass"
    for c in checks:
        print(f"  [{c['level']}] {c['name']}: {c['value']}")

    print(f"    [{time.time()-t0:5.1f}s] after registration")
    # ---- export (write to a temp dir, then rename: a meta.json on disk always means a complete site)
    dem.astype("<f4").tofile(tmp / "heightmap.bin")
    Image.fromarray(tex, mode="L").save(tmp / "texture.jpg", quality=90, optimize=True)
    ns, ew = ("N" if lat_c >= 0 else "S"), ("E" if lon_c >= 0 else "W")
    credit = lambda p: {k_: p.get(k_) for k_ in ("id", "title", "mission", "instrument", "doi")} | {"url": p["info"]}
    meta = {
        "site": {"id": out_web.name, "name": f"{abs(lat_c):.2f}° {ns}, {abs(lon_c):.2f}° {ew}", "profile": "global"},
        "body": {"name": cfg["body"]["name"], "radius_m": R},
        "center": {"lat": lat_c, "lon": lon_c, "latitude_type": "planetocentric", "longitude_direction": "east-positive"},
        "projection": local_proj,
        "extent_m": {"west": x0, "north": y0, "east": -x0, "south": -y0},
        "bounds_deg": {"west": lon_w, "east": lon_e, "south": lat_s, "north": lat_n},
        "heightmap": {"file": "heightmap.bin", "format": "float32-le", "width": nd, "height": nd,
                      "spacing_m": dres, "row0": "north", "registration": "pixel-is-area (values at cell centres)",
                      "units": "m", "min": emin, "max": emax, "vertical_reference": dem_p["vertical_reference"],
                      "resampling": f"bilinear from the {dem_p['native_m']:.0f} m source (upsampled; no added detail)"},
        "texture": {"file": "texture.jpg", "width": nt, "height": nt, "pixel_m": tres,
                    "resampling": f"{'area average' if tres > img_native_m else 'bilinear'} from CTX level {z} "
                                  f"({img_native_m:.2f} m/px)", "bands": img["bands"]},
        "products": {"dtm": credit(dem_p), "ortho": credit(img)},
        "resolution": {"dem_native_m": dem_p["native_m"], "image_native_m": round(img_native_m, 3),
                       "image_level": z, "image_tiles": ntiles, "image_tiles_missing": nmiss,
                       "image_tiles_truncated": ntrunc,
                       "image_tiles_rejected": nrej, "fill_level": fz},
        "sources": [source("elevation", dem_p), source("imagery", img)],
        "validation": {"status": status, "checks": checks, "heights_median_abs_diff_m": med,
                       "heights_p95_abs_diff_m": p95, "geolocation_formula_max_error_m": geo_err,
                       "megdr_mean_diff_m": mean_diff, "megdr_rms_diff_m": rms_diff, "texture_gap_fraction": gap,
                       "texture_filled_fraction": filled,
                       "texture_relief_fraction": relief,
                       "registration": reg},
        "timing_s": {"download": round(t_dl, 1), "total": round(time.time() - t0, 1)},
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    print(f"    [{time.time()-t0:5.1f}s] after export")
    progress("context", 1.0)
    try:
        meta["context"] = f_ctx.result()
    except SiteError as e:
        print(f"  [warn] no context ring: {e}")
    ctx_pool.shutdown()
    (tmp / "meta.json").write_text(json.dumps(meta, indent=2))
    add_color(cfg, tmp)
    try:
        add_thermal(cfg, tmp)
    except SiteError as e:               # the thermal layers are optional: never fail a site for them
        print(f"  [warn] no thermal layers: {e}")
    shutil.rmtree(out_web, ignore_errors=True)
    tmp.rename(out_web)
    progress("done", 1.0)
    print(f"Wrote {out_web} in {time.time()-t0:.1f}s (download {t_dl:.1f}s)")
    return out_web


# =============================================================================================
# Context ring: a wide, low-resolution terrain around any site (so the high-res tile does not float in a void)
# =============================================================================================
def build_context(cfg, lat_c, lon_c, S_main, out_dir, progress=lambda stage, frac: None, fixed=False):
    """Write context.bin / context.jpg in the SAME local eqc frame as the site and return meta["context"].
    Elevation: HRSC-MOLA blended DEM (200 m), rows/cols subsampled to the context grid. Imagery: CTX at the finest
    level within a small tile budget. Same documented-header checks as the site; context is optional (on any
    failure the caller just omits it)."""
    g, R = cfg["global"], float(cfg["body"]["radius_m"])
    dem_p, img, cx = g["dem"], g["image"], g["context"]
    C = context_edge_m(cfg, S_main, fixed)
    n, nt = int(cx["heightmap_px"]), int(cx["texture_px"])
    sp, tres = C / n, C / nt
    lon_w, lon_e, lat_s, lat_n = footprint(lat_c, lon_c, C, R)
    if abs(lat_s) > 89 or abs(lat_n) > 89:
        fail("context ring would reach a pole")
    geo_crs = CRS.from_proj4(f"+proj=longlat +R={R} +no_defs")       # relative-longitude warps, see build_global
    local_crs = CRS.from_proj4(f"+proj=eqc +lat_ts={lat_c} +lat_0={lat_c} +lon_0=0 +x_0=0 +y_0=0 +R={R} "
                               f"+units=m +no_defs")
    rel = lambda t: rasterio.Affine.translation(-lon_c, 0) * t
    x0, y0 = -C / 2, C / 2
    h_tf, t_tf = from_origin(x0, y0, sp, sp), from_origin(x0, y0, tres, tres)
    step = max(1, int(sp // dem_p["native_m"]))

    def do_dem():
        with rasterio.open("/vsicurl/" + dem_p["url"]) as src:
            check_header_geo("dem", src, dem_p["expected"])
            m = 3 * src.res[0] * step
            win = from_bounds(lon_w - m, lat_s - m, lon_e + m, lat_n + m, transform=src.transform)
            win = win.round_offsets().round_lengths()
            arr = read_dem_ranges(dem_p["url"], win, src, dem_p["expected"], step)
            t = src.window_transform(win)
            nod = src.nodata
        # pixel j of the subsampled array is source pixel j*step: shift the origin so centres stay exact
        stf = rasterio.Affine(t.a * step, 0, t.c + 0.5 * t.a * (1 - step), 0, t.e * step, t.f + 0.5 * t.e * (1 - step))
        a32 = arr.astype(np.float32)
        a32[arr == nod] = np.nan
        dst = np.full((n, n), np.nan, dtype=np.float32)
        reproject(a32, dst, src_transform=rel(stf), src_crs=geo_crs, src_nodata=np.nan, dst_transform=h_tf,
                  dst_crs=local_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
        return dst

    with ThreadPoolExecutor(2) as ex:
        f_dem = ex.submit(do_dem)
        lods = ctx_service(img)
        im2 = dict(img, max_tiles=cx["max_tiles"], min_level=cx["min_level"])
        z = choose_level(im2, lods, lon_w, lon_e, lat_s, lat_n)
        while True:   # step down while the service cache has holes here (> 20 % missing)
            mosaic, mtf, z, mres, ntiles, nmiss, ntrunc = fetch_ctx(im2, lods, lon_w, lon_e, lat_s, lat_n,
                                                                     lambda st, f: progress("context", f), z)
            tex = np.zeros((nt, nt), dtype=np.uint8)
            native = mres * math.pi / 180 * R
            reproject(mosaic, tex, src_transform=rel(mtf), src_crs=geo_crs, src_nodata=0, dst_transform=t_tf,
                      dst_crs=local_crs, dst_nodata=0,
                      resampling=Resampling.average if tres > native else Resampling.bilinear,
                      num_threads=os.cpu_count() or 4)
            gap = float((tex == 0).mean())
            if gap <= 0.2 or z <= cx["min_level"]:
                break
            z -= 1
        hm = f_dem.result()
    if not np.all(np.isfinite(hm)):
        fail("context heightmap has NoData")
    if gap > 0 and z - 2 >= 3:   # holes (missing/truncated tiles): fill from the 4x coarser level
        fm, ftf, *_ = fetch_ctx(im2, lods, lon_w, lon_e, lat_s, lat_n, lambda *_: None, z - 2)
        ftex = np.zeros_like(tex)
        reproject(fm, ftex, src_transform=rel(ftf), src_crs=geo_crs, src_nodata=0, dst_transform=t_tf, dst_crs=local_crs,
                  dst_nodata=0, resampling=Resampling.bilinear, num_threads=os.cpu_count() or 4)
        hole = (tex == 0) & (ftex > 0)
        tex[hole] = ftex[hole]
    if (tex == 0).any():         # never imaged by CTX: shaded relief of the context DEM
        relief_fill(tex, hm)
    hm.astype("<f4").tofile(out_dir / "context.bin")
    Image.fromarray(tex, mode="L").save(out_dir / "context.jpg", quality=85, optimize=True)
    print(f"  context ring {C/1000:.0f} km: DEM every {step} px ({dem_p['native_m']*step:.0f} m) -> {sp:.0f} m grid, "
          f"CTX level {z} ({native:.0f} m/px, {ntiles} tiles, gaps {gap*100:.1f}%)")
    return {"heightmap": {"file": "context.bin", "format": "float32-le", "width": n, "height": n, "spacing_m": sp,
                          "row0": "north", "min": float(hm.min()), "max": float(hm.max())},
            "texture": {"file": "context.jpg", "width": nt, "height": nt, "pixel_m": tres},
            "extent_m": {"west": x0, "north": y0, "east": -x0, "south": -y0},
            "bounds_deg": {"west": lon_w, "east": lon_e, "south": lat_s, "north": lat_n},
            "dem_sample_m": dem_p["native_m"] * step, "image_native_m": round(native, 1), "image_level": z,
            "image_gap_fraction": gap, "fixed": bool(fixed),
            "note": (f"Low-resolution surroundings for orientation only: {dem_p['title']} subsampled to "
                     f"{dem_p['native_m']*step:.0f} m, CTX level {z} (~{native:.0f} m/px). Readouts use the site tile.")}


def add_context(cfg, site_dir):
    """Add (or refresh) the context ring of an existing site directory; never fails the site itself."""
    site_dir = Path(site_dir)
    meta = json.loads((site_dir / "meta.json").read_text())
    S = meta["extent_m"]["east"] - meta["extent_m"]["west"]
    try:
        meta["context"] = build_context(cfg, meta["center"]["lat"], meta["center"]["lon"], S, site_dir)
    except SiteError as e:
        print(f"  [warn] no context ring: {e}")
        meta.pop("context", None)
    (site_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta.get("context")


# =============================================================================================
# Colour: Viking Orbiter colour mosaic (the globe's base map) cut to the site / context frames
# =============================================================================================
VIKING = ROOT / "data" / "raw" / "globe" / "Mars_Viking_ClrMosaic_global_925m.tif"


def add_color(cfg, site_dir):
    """Write color.jpg (site extent) and context_color.jpg (context extent): the USGS Viking colour mosaic
    (925 m, same file as the globe base map) reprojected onto the site's local frame. The viewer fuses it with
    the full-resolution grayscale image (colour from Viking, detail from CTX/HiRISE); grayscale stays available."""
    site_dir = Path(site_dir)
    meta = json.loads((site_dir / "meta.json").read_text())
    if not VIKING.exists():
        print("  [warn] no colour: Viking mosaic missing (run pipeline/build_globe.py)")
        return None
    R = float(cfg["body"]["radius_m"])
    with rasterio.open(VIKING) as src:
        proj = src.crs.to_proj4()
        if src.count != 3 or "+R=3396190" not in proj or "+proj=eqc" not in proj or src.dtypes[0] != "uint8":
            fail(f"Viking mosaic header differs from the documented values ({proj}, {src.count} bands)")
        out = {}
        for key, ext, n, fname in (("site", meta["extent_m"], 256, "color.jpg"),
                                   ("context", (meta.get("context") or {}).get("extent_m"), 512, "context_color.jpg")):
            if not ext:
                continue
            E = ext["east"] - ext["west"]
            tf = from_origin(ext["west"], ext["north"], E / n, E / n)
            lon_w, lon_e, lat_s, lat_n = footprint(meta["center"]["lat"], meta["center"]["lon"], E, R)
            m = 4 * src.res[0]
            # Viking is eqc with lat_ts = 0 on the same sphere: x = R * lon (continuous across +-180), y = R * lat
            xs = [R * math.radians(lon_w), R * math.radians(lon_e)]
            ys = [R * math.radians(lat_s), R * math.radians(lat_n)]
            win = from_bounds(min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m, transform=src.transform)
            win = win.round_offsets().round_lengths()
            c0w, r0w, Ww, Hw = int(win.col_off), int(win.row_off), int(win.width), int(win.height)
            arr = np.concatenate([src.read(window=Window(fc, r0w, nn, Hw))           # wraps at +-180 deg
                                  for fc, nn in col_segments(c0w, Ww, src.width)], axis=2)
            dst = np.zeros((3, n, n), dtype=np.uint8)
            la0, lo0 = meta["center"]["lat"], meta["center"]["lon"]
            reproject(arr, dst,
                      src_transform=rasterio.Affine.translation(-R * math.radians(lo0), 0) * src.window_transform(win),
                      src_crs=src.crs, src_nodata=0, dst_transform=tf,
                      dst_crs=CRS.from_proj4(f"+proj=eqc +lat_ts={la0} +lat_0={la0} +lon_0=0 +x_0=0 +y_0=0 +R={R} "
                                             f"+units=m +no_defs"), dst_nodata=0, resampling=Resampling.bilinear)
            Image.fromarray(np.moveaxis(dst, 0, -1), mode="RGB").save(site_dir / fname, quality=92)
            out[key] = fname
    meta["color"] = {
        "file": out.get("site"), "context_file": out.get("context"), "native_m": 925.4,
        "source": "USGS Viking Orbiter colour mosaic Mars_Viking_ClrMosaic_global_925m (same as the globe base map)",
        "method": ("colour fusion in the viewer: Viking colour x (image / image averaged over ~925 m); "
                   "brightness detail from the grayscale image, colour from Viking. Visual product, not a measured "
                   "colour at the image resolution."),
    }
    (site_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta["color"]


# THEMIS infrared mosaics (Mars Odyssey, ASU Mars Space Flight Facility; hosted by USGS), 100 m/px.
# Facts from the PDS3/ISIS labels next to the files: 8-bit, uncompressed, one row per strip, simple cylindrical on the
# R = 3396190 m sphere, centre longitude 180 (so column 0 is 0 deg E), image data from byte ^IMAGE (1-based).
# The DN are RELATIVE brightness (the mosaics are normalised and blended), not calibrated temperatures.
THEMIS_BASE = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
THEMIS = {
    "night": {"file": "Mars_MO_THEMIS-IR-Night_mosaic_60N60S_100m_v14.tif", "product": "thm_night_ir_v14",
              "width": 213388, "height": 71130, "start_byte": 1138870, "x0": -10669400.0, "y0": 3556500.0},
    "day": {"file": "Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif", "product": "thm_day_ir_v12",
            "width": 213390, "height": 106696, "start_byte": 1707926, "x0": -10669500.0, "y0": 5334800.0},
}
THERMAL_N = 256


def add_thermal(cfg, site_dir):
    """Write ir_night.u8 / ir_day.u8 (THERMAL_N x THERMAL_N bytes, row 0 = north, 0 = no data): the THEMIS night and
    day infrared mosaics over the site, in the site's local frame. Only the site's window is fetched (HTTP ranges).
    Night IR is the measured basis of the "ground dust and fines" filter (fine dust cools fast and is dark at
    night, rock stays warm and is bright); day and night IR give the relative temperature pattern."""
    site_dir = Path(site_dir)
    if not (site_dir / "meta.json").exists():        # unfinished or leftover folder
        return
    meta = json.loads((site_dir / "meta.json").read_text())
    R = float(cfg["body"]["radius_m"])
    ext, la0, lo0 = meta["extent_m"], meta["center"]["lat"], meta["center"]["lon"]
    n = THERMAL_N
    xs = ext["west"] + (np.arange(n) + 0.5) * (ext["east"] - ext["west"]) / n
    ys = ext["north"] - (np.arange(n) + 0.5) * (ext["north"] - ext["south"]) / n
    lat = la0 + np.degrees(ys / R)                                             # same formulas as the browser
    lon = (lo0 % 360) + np.degrees(xs / (R * math.cos(math.radians(la0))))     # unwrapped around the site centre
    out = {}
    for key, t in THEMIS.items():
        url = THEMIS_BASE + t["file"]
        fr = (t["y0"] - R * np.radians(lat)) / 100.0 - 0.5
        fc = (R * np.radians(lon - 180.0) - t["x0"]) / 100.0 - 0.5
        r0, r1 = int(math.floor(fr.min())), int(math.floor(fr.max())) + 1
        c0, c1 = int(math.floor(fc.min())), int(math.floor(fc.max())) + 1
        if r0 < 0 or r1 > t["height"] - 1:
            print(f"  thermal {key}: site is outside the mosaic's latitude range, skipped")
            continue
        H, W = r1 - r0 + 1, c1 - c0 + 1
        with rasterio.open("/vsicurl/" + url) as src:
            g = src.transform
            if (src.width, src.height, src.dtypes[0], src.compression) != (t["width"], t["height"], "uint8", None) \
                    or src.block_shapes[0] != (1, t["width"]) or abs(g.c - t["x0"]) > 1e-6 or abs(g.f - t["y0"]) > 1e-6 \
                    or abs(g.a - 100) > 1e-9 or "+lon_0=180" not in src.crs.to_proj4() or "+R=3396190" not in src.crs.to_proj4():
                fail(f"thermal {key}: file header differs from the documented values")
            segs = col_segments(c0, W, t["width"])        # wraps at 0/360 deg E
            arr = np.empty((H, W), np.uint8)

            def rd(i):
                parts = []
                for fcol, cnt in segs:
                    off = t["start_byte"] - 1 + (r0 + i) * t["width"] + fcol
                    st, body = http_get(url, headers={"Range": f"bytes={off}-{off + cnt - 1}"})
                    if st != 206 or len(body) != cnt:
                        fail(f"thermal {key}: range read returned HTTP {st}, {len(body)} bytes")
                    parts.append(np.frombuffer(body, np.uint8))
                arr[i] = np.concatenate(parts)
            list(HTTP_POOL.map(rd, range(H)))
            ref = src.read(1, window=Window(segs[0][0], r0 + H // 2, segs[0][1], 1))[0]
        if not np.array_equal(ref, arr[H // 2, :segs[0][1]]):
            fail(f"thermal {key}: byte-range read disagrees with GDAL's read (label offset wrong?)")
        # Bilinear onto the site grid, ignoring no-data (0) neighbours.
        rr, cc = fr[:, None] - r0, fc[None, :] - c0
        i0, j0 = np.clip(np.floor(rr).astype(int), 0, H - 2), np.clip(np.floor(cc).astype(int), 0, W - 2)
        tr, tc = np.clip(rr - i0, 0, 1), np.clip(cc - j0, 0, 1)
        acc, wsum = np.zeros((n, n)), np.zeros((n, n))
        for di, dj, w in ((0, 0, (1 - tr) * (1 - tc)), (0, 1, (1 - tr) * tc), (1, 0, tr * (1 - tc)), (1, 1, tr * tc)):
            v = arr[i0 + di, j0 + dj].astype(np.float64)
            acc += np.where(v > 0, v * w, 0)
            wsum += np.where(v > 0, w, 0)
        res = np.where(wsum > 0.25, np.clip(np.round(acc / np.maximum(wsum, 1e-9)), 1, 255), 0).astype(np.uint8)
        valid = float((res > 0).mean())
        if valid < 0.5:
            print(f"  thermal {key}: only {valid:.0%} of the site has data, skipped")
            continue
        res.tofile(site_dir / f"ir_{key}.u8")
        out[key] = {"file": f"ir_{key}.u8", "product": t["product"], "url": url, "valid_fraction": round(valid, 4),
                    "dn_p2": int(np.percentile(res[res > 0], 2)), "dn_p98": int(np.percentile(res[res > 0], 98))}
        print(f"  thermal {key}: {H} x {W} px window, {valid:.1%} valid, DN {out[key]['dn_p2']}..{out[key]['dn_p98']} (2-98 %)")
    if not out:
        return None
    meta["thermal"] = {
        "size": n, "native_m": 100.0, **out,
        "source": "Mars Odyssey THEMIS infrared mosaics, 100 m (ASU Mars Space Flight Facility; USGS Astrogeology)",
        "note": ("8-bit relative brightness from normalised, blended mosaics: it shows where the ground is warmer or "
                 "colder than its surroundings, not a temperature in kelvin."),
    }
    (site_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta["thermal"]


def load_cfg(path=None):
    return yaml.safe_load(Path(path or ROOT / "pipeline" / "config.yaml").read_text())


def build_site(spec, cfg=None, progress=lambda stage, frac: None):
    """spec = {"profile": "hirise_jezero"} | {"profile": "global", "lat", "lon", "size_km"[, "out_dir"]}"""
    cfg = cfg or load_cfg()
    if spec["profile"] == "hirise_jezero":
        return build_hirise(cfg)
    if spec["profile"] == "global":
        sid = site_id(spec["lat"], spec["lon"], spec["size_km"])
        out = Path(spec.get("out_dir") or ROOT / "web" / "public" / "sites" / sid)
        return build_global(cfg, spec["lat"], spec["lon"], int(spec["size_km"]), out, progress)
    raise SiteError(f"unknown profile {spec['profile']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config", nargs="?")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--size", type=int, default=20)
    ap.add_argument("--context-only", metavar="SITE_DIR", help="(re)build only the context ring of a built site")
    ap.add_argument("--color-only", metavar="SITE_DIR", nargs="+", help="(re)build only the Viking colour layers")
    ap.add_argument("--thermal-only", metavar="SITE_DIR", nargs="+", help="(re)build only the THEMIS infrared layers")
    a = ap.parse_args()
    cfg = load_cfg(a.config)
    if a.thermal_only:
        for d in a.thermal_only:
            print(d, "->", sorted(k for k in (add_thermal(cfg, d) or {}) if k in THEMIS))
        return
    if a.context_only:
        sys.exit(0 if add_context(cfg, a.context_only) else 1)
    if a.color_only:
        for d in a.color_only:
            print(d, "->", (add_color(cfg, d) or {}).get("file"))
        return
    try:
        if a.lat is None:
            build_site({"profile": "hirise_jezero"}, cfg)
        else:
            build_site({"profile": "global", "lat": a.lat, "lon": a.lon, "size_km": a.size}, cfg)
    except SiteError as e:
        print(f"\n[FAIL] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
