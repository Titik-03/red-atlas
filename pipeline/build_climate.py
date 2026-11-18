#!/usr/bin/env python3
"""
RED ATLAS - light climate layers for the globe: dust, surface temperature, near-surface wind.

One Mars year (Ls 19 deg of MY30 to Ls 19 deg of MY31; no global dust storm), globe scale only.

  Dust         Montabone et al. (2015) kriged daily maps of column dust optical depth, MY30, v2.0, 3 x 3 deg.
               Retrievals from MRO/MCS and Odyssey/THEMIS; gaps interpolated by kriging. CC BY-SA 3.0.
  Temperature  OpenMARS MY28-32 standard database (Holmes, Lewis & Patel 2020): 2-hourly `tsurf`, 5 x 5 deg.
  Wind         same files: `u`, `v` on the lowest model level (sigma = p/ps = 0.9995, roughly 5 m above ground).
               OpenMARS is a REANALYSIS: MCS temperature and dust retrievals assimilated into a Mars global
               circulation model. Winds and surface temperature are not measured directly. CC BY-NC-ND 4.0,
               so the derived files are not committed; every computer rebuilds them with this script.

The OpenMARS files are 407 MB each but stored uncompressed and contiguous, so only the needed slices are
fetched with HTTP range requests (about 6 MB per file). Every third sol is used, with all 12 two-hourly steps.

Outputs (web/public/globe): dust.png, temp.png, wind.png, *.i16 readout grids (1 deg), climate.json.
Usage: .venv/bin/python pipeline/build_climate.py
"""
import io
import json
import sys
import threading
import time
import urllib.error
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np
import rasterio
from PIL import Image, ImageDraw
from cmcrameri import cm as cmc

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_globe as bg  # noqa: E402  (colorize, legend_stops, to_int16, grid constants)

RAW = bg.ROOT / "data" / "raw" / "climate"
OUT = bg.OUT
DUST_URL = "https://www-mars.lmd.jussieu.fr/mars/dust_climatology/dataset_v2/dustscenario_MY30_v2-0.nc"
DUST_DOC = "https://www-mars.lmd.jussieu.fr/mars/dust_climatology/"
OPENMARS_ARTICLE = "https://api.figshare.com/v2/articles/7352579"
OPENMARS_DOC = "https://doi.org/10.21954/ou.rd.7352579.v1"
LS_START = 19.0            # the MY30 files start at Ls 19; the year is closed with MY31 Ls 0-19
SOL_STEP = 3               # use every third sol (all 12 two-hourly steps of it)
BUDGET_MB = 500
READ_W, READ_H = 360, 180  # readout grids: 1 deg, pixel-is-area, interpolated from the product grid points
TEX_W, TEX_H = 2048, 1024
UA = {"User-Agent": "Mozilla/5.0 (red-atlas pipeline)"}

checks = []
fetched = 0


def check(ok, msg):
    checks.append({"ok": bool(ok), "check": msg})
    print(f"  [{'ok' if ok else 'FAIL'}] {msg}")
    if not ok:
        bg.fail(msg)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_signed, _signed_lock = {}, threading.Lock()


def signed_url(url, refresh=False):
    """figshare redirects to an S3 link signed for 10 s. Resolve it once and share it for 6 s, so that hundreds of
    range requests cost one figshare request every few seconds (it answers HTTP 429 when asked too often)."""
    if "figshare.com" not in url:
        return url
    with _signed_lock:
        loc, t = _signed.get(url, (None, 0))
        if loc and not refresh and time.time() - t < 6:
            return loc
        for i in range(8):
            try:
                urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(url, headers=UA), timeout=60)
                raise IOError("figshare did not redirect")
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307) and e.headers.get("Location"):
                    _signed[url] = (e.headers["Location"], time.time())
                    return e.headers["Location"]
                if i == 7:
                    raise
                time.sleep(float(e.headers.get("Retry-After") or 5 * (i + 1)))


def http_range(url, a, b, tries=6):
    """Bytes a..b (inclusive)."""
    global fetched
    for i in range(tries):
        try:
            req = urllib.request.Request(signed_url(url, refresh=i > 0), headers={**UA, "Range": f"bytes={a}-{b}"})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
            if len(data) != b - a + 1:
                raise IOError(f"short read {len(data)} != {b - a + 1}")
            with _signed_lock:
                fetched += len(data)
            return data
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(0.5 * i)


class HttpFile(io.RawIOBase):
    """Seekable read-only view of a remote file (block cache), enough for h5py to parse the HDF5 header."""

    def __init__(self, url, block=1 << 16):
        req = urllib.request.Request(signed_url(url), headers={**UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=90) as r:
            self.size = int(r.headers["Content-Range"].split("/")[1])
        self.url, self.block, self.pos, self.cache = url, block, 0, {}

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, buf):
        n = min(len(buf), self.size - self.pos)
        out = bytearray()
        while len(out) < n:
            i, o = divmod(self.pos + len(out), self.block)
            if i not in self.cache:
                self.cache[i] = http_range(self.url, i * self.block, min(self.size, (i + 1) * self.block) - 1)
            out += self.cache[i][o:o + n - len(out)]
        buf[:n] = out
        self.pos += n
        return n


def reduce_openmars(name, url, pool, ls_max=None):
    """Sums over the sampled steps of one file: surface temperature, pressure, lowest-level wind."""
    with h5py.File(HttpFile(url), "r") as h:
        lat, lon, lev, ls = h["lat"][:], h["lon"][:], h["lev"][:], h["Ls"][:]
        nt = len(ls)
        info = {}
        for v in ("tsurf", "ps", "u", "v"):
            d = h[v]
            if d.chunks is not None or d.id.get_offset() is None:
                bg.fail(f"{name}: variable {v} is not stored contiguously; partial reads are not possible")
            info[v] = (d.id.get_offset(), d.dtype, d.shape)
    if info["tsurf"][2] != (nt, 36, 72) or info["u"][2] != (nt, 35, 36, 72):
        bg.fail(f"{name}: unexpected dimensions {info['tsurf'][2]} / {info['u'][2]} (documented: 72 x 36 x 35)")
    if not (abs(lev[0] - 0.9995) < 1e-4 and abs(lat[0] - 87.5) < 0.01 and abs(lon[0] + 180) < 0.01):
        bg.fail(f"{name}: unexpected grid (lev0 {lev[0]}, lat0 {lat[0]}, lon0 {lon[0]})")
    cell = 36 * 72 * 4
    sols = [s for s in range(0, nt // 12, SOL_STEP) if ls_max is None or ls[s * 12] < ls_max]
    steps = [t for s in sols for t in range(s * 12, s * 12 + 12)]
    if not steps:
        return None

    def surf(v):     # one request per sol: its 12 steps are adjacent
        off, dt, _ = info[v]
        parts = pool.map(lambda s: http_range(url, off + s * 12 * cell, off + (s * 12 + 12) * cell - 1), sols)
        return np.concatenate([np.frombuffer(p, dt).reshape(12, 36, 72) for p in parts]).astype(np.float64)

    def lowest(v):   # one request per step: level 0 of that step
        off, dt, _ = info[v]
        parts = pool.map(lambda t: http_range(url, off + t * 35 * cell, off + t * 35 * cell + cell - 1), steps)
        return np.stack([np.frombuffer(p, dt).reshape(36, 72) for p in parts]).astype(np.float64)

    ts, ps, u, v = surf("tsurf"), surf("ps"), lowest("u"), lowest("v")
    return {"n": len(steps), "ls0": float(ls[steps[0]]), "ls1": float(ls[steps[-1]]),
            "ts_sum": ts.sum(0), "ts_min": ts.min(0), "ts_max": ts.max(0), "ps_sum": ps.sum(0),
            "spd_sum": np.hypot(u, v).sum(0), "u_sum": u.sum(0), "v_sum": v.sum(0),
            "lat": lat.astype(np.float64), "lon": lon.astype(np.float64)}


def openmars():
    cache = RAW / "openmars_my30_reduced.npz"
    if cache.exists():
        print("  using cached reduction", cache.name)
        return dict(np.load(cache))
    with urllib.request.urlopen(urllib.request.Request(OPENMARS_ARTICLE, headers=UA), timeout=60) as r:
        files = {f["name"]: f["download_url"] for f in json.load(r)["files"]}
    todo = [(n, None) for n in files if n.startswith("openmars_my30_")]
    todo += [(n, LS_START) for n in ("openmars_my31_ls0_my31_ls15.nc", "openmars_my31_ls15_my31_ls29.nc")]
    if len(todo) != 23:
        bg.fail(f"expected 21 MY30 files + 2 MY31 files in the OpenMARS record, found {len(todo)}")
    acc, spans = None, []
    with ThreadPoolExecutor(16) as pool:
        for i, (name, ls_max) in enumerate(todo):
            t0, f0 = time.time(), fetched
            r = reduce_openmars(name, files[name], pool, ls_max)
            if r is None:
                continue
            spans.append((r["ls0"], r["ls1"], r["n"]))
            if acc is None:
                acc = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in r.items()}
            else:
                acc["n"] += r["n"]
                for k in ("ts_sum", "ps_sum", "spd_sum", "u_sum", "v_sum"):
                    acc[k] += r[k]
                acc["ts_min"] = np.minimum(acc["ts_min"], r["ts_min"])
                acc["ts_max"] = np.maximum(acc["ts_max"], r["ts_max"])
            print(f"  [{i + 1:2d}/{len(todo)}] {name}: {r['n']} steps, Ls {r['ls0']:.0f}-{r['ls1']:.0f}, "
                  f"{(fetched - f0) / 1e6:.1f} MB, {time.time() - t0:.0f} s")
            if fetched / 1e6 > BUDGET_MB:
                bg.fail(f"download budget exceeded ({fetched / 1e6:.0f} MB > {BUDGET_MB} MB)")
    n = acc["n"]
    out = {"n": n, "lat": acc["lat"], "lon": acc["lon"], "ts_mean": acc["ts_sum"] / n, "ts_min": acc["ts_min"],
           "ts_max": acc["ts_max"], "ps_mean": acc["ps_sum"] / n, "spd_mean": acc["spd_sum"] / n,
           "u_mean": acc["u_sum"] / n, "v_mean": acc["v_sum"] / n, "spans": np.array(spans)}
    np.savez_compressed(cache, **out)
    return out


def dust():
    cache = RAW / "dust_my30_reduced.npz"
    if cache.exists():
        print("  using cached reduction", cache.name)
        return dict(np.load(cache))
    global fetched
    p = RAW / "dustscenario_MY30_v2-0.nc"
    if not p.exists():
        bg.download(DUST_URL, p)
        fetched += p.stat().st_size
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        arrs = {}
        for v in ("cdodtot", "cdod610"):
            with rasterio.open(f'NETCDF:"{p}":{v}') as s:
                if (s.count, s.height, s.width) != (669, 60, 120):
                    bg.fail(f"dust file: unexpected {v} dimensions {s.count} x {s.height} x {s.width}")
                if "9.3 micron" not in s.tags().get("NC_GLOBAL#title", ""):
                    bg.fail("dust file: title does not describe 9.3 micron absorption optical depth")
                a = s.read().astype(np.float64)
                t = s.transform
                lon = t.c + t.a * (np.arange(120) + 0.5)
                lat = t.f + t.e * (np.arange(60) + 0.5)
                arrs[v] = a
    out = {"lat": lat, "lon": lon, "tot_mean": arrs["cdodtot"].mean(0), "ref_mean": arrs["cdod610"].mean(0),
           "ref_first": arrs["cdod610"][:372].mean(), "ref_second": arrs["cdod610"][372:].mean()}
    np.savez_compressed(cache, **out)
    p.unlink()          # 58 MB; the reduction above is all that is used
    return out


def resample(a, lat, lon, h, w):
    """Bilinear interpolation of values at grid POINTS (lat north to south, lon west to east, periodic in
    longitude) onto a pixel-is-area grid: left edge 180 W, top 90 N. Rows beyond the last point repeat it."""
    tl = 90 - (np.arange(h) + 0.5) * 180 / h
    tn = -180 + (np.arange(w) + 0.5) * 360 / w
    fr = np.clip((lat[0] - tl) / (lat[0] - lat[1]), 0, len(lat) - 1)
    fc = ((tn - lon[0]) / (lon[1] - lon[0])) % len(lon)
    r0 = np.minimum(np.floor(fr).astype(int), len(lat) - 2)
    c0 = np.floor(fc).astype(int)
    tr, tc = (fr - r0)[:, None], (fc - c0)[None, :]
    c1 = (c0 + 1) % len(lon)
    return (a[r0][:, c0] * (1 - tr) * (1 - tc) + a[r0][:, c1] * (1 - tr) * tc
            + a[r0 + 1][:, c0] * tr * (1 - tc) + a[r0 + 1][:, c1] * tr * tc)


def orientation(field, lat, lon, elev1):
    """Correlation of a pressure-like field with MOLA elevation for the stated orientation and for wrong ones."""
    def r(f):      # area-weighted correlation on a 5-degree grid
        g = resample(f, lat, lon, 36, 72)
        e = elev1.reshape(36, 5, 72, 5).mean(axis=(1, 3))
        w = np.cos(np.radians(90 - (np.arange(36) + 0.5) * 5))[:, None] * np.ones((1, 72))
        gm, em = g - (g * w).sum() / w.sum(), e - (e * w).sum() / w.sum()
        return float((w * gm * em).sum() / np.sqrt((w * gm * gm).sum() * (w * em * em).sum()))
    return {"as documented": r(field), "north-south flipped": r(field[::-1]),
            "shifted 90 deg": r(np.roll(field, len(lon) // 4, 1)), "shifted 180 deg": r(np.roll(field, len(lon) // 2, 1))}


def nice_range(a, lo_step, hi_step):
    lo, hi = np.percentile(a, [1, 99])
    return float(np.floor(lo / lo_step) * lo_step), float(np.ceil(hi / hi_step) * hi_step)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    if not (OUT / "elev.i16").exists():
        bg.fail("web/public/globe/elev.i16 not found (it is in the repository; or run pipeline/build_globe.py)")
    elev8 = np.fromfile(OUT / "elev.i16", "<i2").reshape(bg.GH, bg.GW).astype(np.float64)
    elev1 = elev8.reshape(180, bg.GRID_PPD, 360, bg.GRID_PPD).mean(axis=(1, 3))
    area = np.cos(np.radians(90 - (np.arange(READ_H) + 0.5)))[:, None] * np.ones((1, READ_W))
    layers, scalars = [], []

    # ------------------------------------------------------------------ dust
    print("Dust (Montabone et al., MY30)")
    d = dust()
    o = orientation(np.log(d["tot_mean"] / d["ref_mean"]), d["lat"], d["lon"], elev1)
    print("  correlation of ln(total / 610 Pa-normalised) with MOLA elevation:", {k: round(v, 2) for k, v in o.items()})
    check(o["as documented"] < -0.9 and o["as documented"] < min(v for k, v in o.items() if k != "as documented") - 0.3,
          f"Dust grid orientation: total/normalised optical depth follows surface pressure, i.e. MOLA elevation "
          f"(r = {o['as documented']:.2f}; wrong orientations are far weaker)")
    check(d["ref_second"] > 1.3 * d["ref_first"],
          f"Dust season: mean normalised optical depth is higher in Ls 180-360 ({float(d['ref_second']):.2f}) "
          f"than in Ls 0-180 ({float(d['ref_first']):.2f}), the known dusty season")
    dust1 = resample(d["tot_mean"], d["lat"], d["lon"], READ_H, READ_W)
    check(0 < dust1.min() and dust1.max() < 2, f"Dust annual mean within physical bounds ({dust1.min():.3f} .. {dust1.max():.3f})")
    dmin, dmax = nice_range(dust1, 0.02, 0.02)
    bg.to_int16(dust1, 10000).tofile(OUT / "dust.i16")
    Image.fromarray(bg.colorize(resample(d["tot_mean"], d["lat"], d["lon"], TEX_H, TEX_W), cmc.bilbao, dmin, dmax, alpha=225)
                    ).save(OUT / "dust.png", optimize=True)
    scalars.append({"id": "dust", "file": "dust.i16", "scale": 10000, "units": "", "label": "Dust optical depth",
                    "width": READ_W, "height": READ_H,
                    "note": "annual mean column dust optical depth, 9.3 um absorption, MY30; 3-degree product, interpolated"})
    layers.append({"id": "dust", "kind": "overlay", "name": "Dust", "texture": "dust.png", "data_kind": "Measured from orbit, gaps interpolated",
                   "units": "optical depth", "min": dmin, "max": dmax, "legend": bg.legend_stops(cmc.bilbao),
                   "description": "Dust in the atmosphere above each point: annual mean of the daily column dust optical "
                                  "depth (absorption at 9.3 um, total column down to the local surface) for Mars Year 30, "
                                  "a year without a global dust storm. Multiply by 2.6 for an approximate visible optical "
                                  "depth. 3-degree maps; it does not show dust lying on the ground or single storms.",
                   "mission": "MRO, Mars Odyssey", "instrument": "MCS, THEMIS", "product": "dustscenario_MY30_v2-0",
                   "source": "Montabone et al. (2015), Icarus 251, 65-95; LMD. CC BY-SA 3.0", "url": DUST_URL, "doc": DUST_DOC})

    # ------------------------------------------------------------------ OpenMARS: temperature and wind
    print("Surface temperature and wind (OpenMARS reanalysis, MY30)")
    m = openmars()
    lat, lon, n = m["lat"], m["lon"], int(m["n"])
    spans = m["spans"]
    check(n >= 12 * 200 and spans[:, 0].min() < 25 and spans[:, 1].max() > 355,
          f"OpenMARS sampling covers the whole year: {n} two-hourly steps on {n // 12} sols "
          f"(every {SOL_STEP}rd sol, Ls {LS_START:.0f} of MY30 to Ls {LS_START:.0f} of MY31)")
    o = orientation(np.log(m["ps_mean"]), lat, lon, elev1)
    print("  correlation of ln(surface pressure) with MOLA elevation:", {k: round(v, 2) for k, v in o.items()})
    check(o["as documented"] < -0.9 and o["as documented"] < min(v for k, v in o.items() if k != "as documented") - 0.3,
          f"OpenMARS grid orientation: surface pressure follows MOLA elevation (r = {o['as documented']:.2f}; "
          "wrong orientations are far weaker)")
    t1 = resample(m["ts_mean"], lat, lon, READ_H, READ_W)
    tmin1 = resample(m["ts_min"], lat, lon, READ_H, READ_W)
    tmax1 = resample(m["ts_max"], lat, lon, READ_H, READ_W)
    gmean = float((t1 * area).sum() / area.sum())
    eq, pole = float(t1[80:100].mean()), float(np.concatenate([t1[:10], t1[-10:]]).mean())
    check(195 < gmean < 220 and eq > pole + 30,
          f"Surface temperature is physically plausible: global mean {gmean:.0f} K, equator {eq:.0f} K, poles {pole:.0f} K")
    check(float(tmin1.min()) > 120 and float(tmax1.max()) < 320,
          f"Surface temperature extremes within bounds ({float(tmin1.min()):.0f} .. {float(tmax1.max()):.0f} K; CO2 frost point is about 145 K)")
    w1 = resample(m["spd_mean"], lat, lon, READ_H, READ_W)
    check(0 < w1.min() and w1.max() < 30, f"Mean near-surface wind speed within bounds ({w1.min():.1f} .. {w1.max():.1f} m/s)")

    tlo, thi = nice_range(t1, 10, 10)
    for sid, arr, label, note in (
            ("temp", t1, "Surface temperature, mean", "annual mean"),
            ("temp_min", tmin1, "Surface temperature, coldest", "coldest sampled 2-hourly value of the year"),
            ("temp_max", tmax1, "Surface temperature, warmest", "warmest sampled 2-hourly value of the year")):
        bg.to_int16(arr, 10).tofile(OUT / f"{sid}.i16")
        scalars.append({"id": sid, "file": f"{sid}.i16", "scale": 10, "units": "K", "label": label,
                        "width": READ_W, "height": READ_H,
                        "note": f"{note}; OpenMARS reanalysis MY30, 5-degree grid, interpolated; not a direct measurement"})
    Image.fromarray(bg.colorize(resample(m["ts_mean"], lat, lon, TEX_H, TEX_W), cmc.roma_r, tlo, thi, alpha=225)
                    ).save(OUT / "temp.png", optimize=True)
    om = {"mission": "MRO (assimilated observations)", "instrument": "MCS + Open University Mars GCM",
          "product": "OpenMARS MY28-32 standard database",
          "source": "Holmes, Lewis & Patel (2020), Planet. Space Sci. 188, 104962. CC BY-NC-ND 4.0",
          "url": OPENMARS_DOC, "doc": "https://ndownloader.figshare.com/files/14441774"}
    layers.append({"id": "temp", "kind": "overlay", "name": "Temperature", "texture": "temp.png", "data_kind": "Reanalysis",
                   "units": "K", "min": tlo, "max": thi, "legend": bg.legend_stops(cmc.roma_r),
                   "description": "Annual mean temperature of the ground surface for Mars Year 30. A reanalysis: orbiter "
                                  "measurements of atmospheric temperature and dust are fed into a climate model, which "
                                  "computes the surface temperature. Day-night swings are large; the readout gives the "
                                  "coldest and warmest values. 5-degree grid, so it shows regions, not local sites.", **om})

    wlo, whi = 0.0, float(np.ceil(np.percentile(w1, 99)))
    bg.to_int16(w1, 100).tofile(OUT / "wind.i16")
    scalars.append({"id": "wind", "file": "wind.i16", "scale": 100, "units": "m/s", "label": "Wind speed, mean",
                    "width": READ_W, "height": READ_H,
                    "note": "annual mean wind speed on the lowest model level (about 5 m above ground); OpenMARS "
                            "reanalysis MY30, 5-degree grid, interpolated; not a direct measurement"})
    # Mean wind VECTOR (east and north components): used on 3D sites to work out which slopes face the wind.
    for sid, arr, what in (("wind_u", m["u_mean"], "eastward"), ("wind_v", m["v_mean"], "northward")):
        bg.to_int16(resample(arr, lat, lon, READ_H, READ_W), 100).tofile(OUT / f"{sid}.i16")
        scalars.append({"id": sid, "file": f"{sid}.i16", "scale": 100, "units": "m/s", "label": f"Mean wind, {what}",
                        "width": READ_W, "height": READ_H, "readout": False,
                        "note": f"annual mean {what} wind component on the lowest model level; OpenMARS reanalysis MY30"})
    tex = Image.fromarray(bg.colorize(resample(m["spd_mean"], lat, lon, TEX_H, TEX_W), cmc.davos_r, wlo, whi, alpha=225))
    draw = ImageDraw.Draw(tex)
    um, vm = m["u_mean"], m["v_mean"]
    vmax = float(np.percentile(np.hypot(um, vm), 98))
    for i in range(2, 34, 2):               # every 10 degrees, away from the poles
        for j in range(0, 72, 2):
            x0 = ((lon[j] + 180) % 360) / 360 * TEX_W
            y0 = (90 - lat[i]) / 180 * TEX_H
            k = min(1.0, float(np.hypot(um[i, j], vm[i, j])) / vmax) * 44 / max(1e-9, float(np.hypot(um[i, j], vm[i, j])))
            dx, dy = um[i, j] * k, -vm[i, j] * k          # east is +x, north is up
            if np.hypot(dx, dy) < 5:
                continue
            x1, y1 = x0 + dx, y0 + dy
            a = np.arctan2(dy, dx)
            head = [(x1, y1), (x1 - 9 * np.cos(a - 0.45), y1 - 9 * np.sin(a - 0.45)),
                    (x1 - 9 * np.cos(a + 0.45), y1 - 9 * np.sin(a + 0.45))]
            draw.line([(x0, y0), (x1, y1)], fill=(20, 23, 26, 255), width=2)
            draw.polygon(head, fill=(20, 23, 26, 255))
    tex.save(OUT / "wind.png", optimize=True)
    layers.append({"id": "wind", "kind": "overlay", "name": "Wind", "texture": "wind.png", "data_kind": "Reanalysis",
                   "units": "m/s", "min": wlo, "max": whi, "legend": bg.legend_stops(cmc.davos_r),
                   "description": "Annual mean wind speed about 5 m above the ground (lowest model level) for Mars Year 30; "
                                  "arrows show the mean direction and are longer where the wind is steadier. A reanalysis: "
                                  "wind has never been measured globally on Mars, so it is computed by a climate model "
                                  "constrained by orbiter temperature and dust measurements. Gusts and local slope winds "
                                  "are not resolved on the 5-degree grid.", **om})

    check(fetched / 1e6 < BUDGET_MB, f"Download stayed within budget ({fetched / 1e6:.0f} MB of {BUDGET_MB} MB)")
    meta = {"period": "Mars Year 30 (Ls 19 of MY30 to Ls 19 of MY31)", "layers": layers, "scalars": scalars,
            "validation": checks, "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (OUT / "climate.json").write_text(json.dumps(meta, indent=1))
    # Dust alone may be redistributed (Montabone et al., CC BY-SA 3.0); temperature and wind may not (OpenMARS,
    # CC BY-NC-ND 4.0). climate_public.json carries only dust and is the file that ships with the online version.
    pub = {**meta, "public": True,
           "layers": [l for l in layers if l["id"] == "dust"],
           "scalars": [s for s in scalars if s["id"] == "dust"],
           "validation": [c for c in checks if c["check"].startswith("Dust")]}
    (OUT / "climate_public.json").write_text(json.dumps(pub, indent=1))
    print(f"\nWrote {OUT}/climate.json ({len(layers)} layers, {len(scalars)} readout grids); "
          f"downloaded {fetched / 1e6:.0f} MB this run; all checks passed.")
    print(f"  ranges: dust {dmin}-{dmax}, temperature {tlo}-{thi} K, wind {wlo}-{whi} m/s")


if __name__ == "__main__":
    main()
