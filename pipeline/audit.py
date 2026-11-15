#!/usr/bin/env python3
"""
RED ATLAS data audit - independently re-checks every PUBLISHED value against the ORIGINAL source files.
Unlike the build scripts, it reads the final web assets through the real browser code (web/audit-readout.mjs)
and compares with raw NASA/USGS/PDS/PSI products. Prints one line per check; exits 1 on any failure.

Usage: .venv/bin/python pipeline/audit.py
"""
import json, math, subprocess, sys
from pathlib import Path
import numpy as np, rasterio, yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW, WEB, AUD = ROOT / "data/raw/globe", ROOT / "web/public", ROOT / "data/audit"
AUD.mkdir(parents=True, exist_ok=True)
results = []

def check(ok, msg):
    results.append(ok); print(f"[{'PASS' if ok else 'FAIL'}] {msg}")

rng = np.random.default_rng(7)
# ---------- choose test points
glob_pts = [(float(a), float(b)) for a, b in zip(rng.uniform(-59, 59, 400), rng.uniform(-179.9, 179.9, 400))]
glob_pts += [(-42.4, 70.5), (18.65, -133.8), (45, -150), (8.4, 69.5), (89.0, 10.0), (-89.0, -10.0)]
tm = json.loads((WEB / "terrain/jezero/meta.json").read_text())
b = tm["bounds_deg"]
m20 = json.loads((RAW / "M20_waypoints.json").read_text())["features"]
inside = [f["properties"] for f in m20 if b["south"] < f["properties"]["lat"] < b["north"] and b["west"] < f["properties"]["lon"] < b["east"]]
terr_pts = [(p["lat"], p["lon"]) for p in inside]
(AUD / "points.json").write_text(json.dumps({"globe": glob_pts, "terrain": terr_pts}))
subprocess.run(["node", "audit-readout.mjs"], cwd=ROOT / "web", check=True)
ro = json.loads((AUD / "readouts.json").read_text())

def cell(lat, lon, w, h):
    return min(int((90 - lat) / 180 * h), h - 1), min(int((lon + 180) / 360 * w), w - 1)

# ---------- 1. Terrain readout vs NASA rover elevations (independent NASA measurement source)
d = np.array([r["elev"] - p["elev_geoid"] for r, p in zip(ro["terrain"], inside)])
check(len(d) > 200 and np.median(np.abs(d)) < 0.3 and np.percentile(np.abs(d), 95) < 1.0,
      f"Terrain readout vs NASA M20 elev_geoid at {len(d)} rover waypoints: median |d| {np.median(np.abs(d)):.2f} m, p95 {np.percentile(np.abs(d), 95):.2f} m")
geo_err = max(max(abs(r["dlat"]), abs(r["dlon"])) for r in ro["terrain"]) * math.pi / 180 * 3396190
check(geo_err < 0.01, f"Terrain lat/lon round-trip through browser formulas: max error {geo_err*1000:.3f} mm")

# ---------- 2. Globe elevation readout vs raw PDS MEGDR (cell = mean of 4x4 MEGDR samples)
z = np.roll(np.fromfile(RAW / "megt90n000fb.img", ">i2").reshape(5760, 11520), 5760, axis=1).astype(np.float64)
errs = []
for (la, lo), v in zip(glob_pts, ro["globe"]["elev"]):
    r, c = cell(la, lo, 2880, 1440)
    errs.append(abs(v - z[r*4:r*4+4, c*4:c*4+4].mean()))
check(max(errs) <= 0.5 + 1e-6, f"Globe elevation readout vs PDS MEGDR at {len(errs)} points: max |d| {max(errs):.2f} m (int16 rounding)")

# ---------- 3. Albedo readout vs raw USGS TES GeoTIFF (same 8 ppd grid)
alb = rasterio.open(RAW / "Mars_MGS_TES_Albedo_mosaic_global_7410m.tif").read(1)
errs = [abs(v - alb[cell(la, lo, 2880, 1440)]) for (la, lo), v in zip(glob_pts, ro["globe"]["albedo"])]
check(max(errs) <= 0.00005 + 1e-7, f"Globe albedo readout vs TES GeoTIFF: max |d| {max(errs):.6f} (quantization 0.0001)")

# ---------- 4. SWIM readouts vs raw SWIM GeoTIFFs (mean of native 0.05-deg pixels inside the 0.125-deg cell)
for lid, f in (("ice_0_1", "SWIM4MIM_Ci_0_1"), ("ice_1_5", "SWIM4MIM_Ci_1_5"), ("ice_5", "SWIM4MIM_Ci_5")):
    a = rasterio.open(RAW / f"{f}.tif").read(1).astype(np.float64)   # 7200 x 2400, 60N..60S, -180..180
    errs, nd_ok = [], True
    for (la, lo), v in zip(glob_pts, ro["globe"][lid]):
        if abs(la) >= 60:
            nd_ok &= v is None; continue
        r, c = cell(la, lo, 2880, 1440)
        lat_top, lon_left = 90 - r / 8, -180 + c / 8
        r0, r1 = (60 - lat_top) / 0.05, (60 - lat_top + 0.125) / 0.05
        c0, c1 = (lon_left + 180) / 0.05, (lon_left + 180 + 0.125) / 0.05
        # area-weighted mean over fractional pixels
        rows = np.arange(int(r0), int(math.ceil(r1))); cols = np.arange(int(c0), int(math.ceil(c1)))
        wr = np.minimum(rows + 1, r1) - np.maximum(rows, r0); wc = np.minimum(cols + 1, c1) - np.maximum(cols, c0)
        ref = (a[np.ix_(rows, cols)] * np.outer(wr, wc)).sum() / np.outer(wr, wc).sum()
        errs.append(abs(v - ref))
    check(np.percentile(errs, 99) < 0.01 and nd_ok,
          f"{lid} readout vs SWIM GeoTIFF: p99 |d| {np.percentile(errs, 99):.4f}, max {max(errs):.4f}; no data poleward of 60 deg")

# ---------- 5. Slope readout re-derived independently (central differences, metric spacing)
R = 3396190.0; dang = math.radians(1 / 32); errs = []
for (la, lo), v in list(zip(glob_pts, ro["globe"]["slope"]))[:60]:
    r, c = cell(la, lo, 2880, 1440); vals = []
    for rr in range(r*4, r*4+4):
        for cc in range(c*4, c*4+4):
            lat = 90 - (rr + 0.5) / 32
            dzdx = (z[rr, (cc+1) % 11520] - z[rr, cc-1]) / (2 * R * dang * max(math.cos(math.radians(lat)), 0.02))
            dzdy = (z[rr-1, cc] - z[rr+1, cc]) / (2 * R * dang)
            vals.append(math.degrees(math.atan(math.hypot(dzdx, dzdy))))
    errs.append(abs(v - np.mean(vals)))
check(max(errs) < 0.01, f"Regional slope readout vs independent re-derivation: max |d| {max(errs):.4f} deg")

# ---------- 6. Landing sites: published JSON == transcribed PDS ODE values; Perseverance == NASA first waypoint
gj = json.loads((WEB / "globe/globe.json").read_text())
cfg = {s["id"]: s for s in yaml.safe_load((ROOT / "pipeline/globe_sites.yaml").read_text())["landers"]}
ok = all(s["lat"] == cfg[s["id"]]["lat"] and abs(((s["lon"] - cfg[s["id"]]["lon_e"]) % 360)) < 1e-9
         for s in gj["sites"] if s["id"] in cfg)
first = sorted(m20, key=lambda f: (f["properties"]["sol"], f["properties"]["site"], f["properties"]["drive"]))[0]["properties"]
p = next(s for s in gj["sites"] if s["id"] == "perseverance")
ok &= abs(p["lat"] - first["lat"]) < 1e-6 and abs(p["lon"] - first["lon"]) < 1e-6
check(ok and len(cfg) == 7, "Landing-site coordinates match PDS ODE transcription and NASA MMGIS (7 + Perseverance)")
for s in gj["sites"]:
    r, c = cell(s["lat"], s["lon"], 11520, 5760)
    if abs(s["mola_elev_m"] - z[r, c]) > 0.5:
        check(False, f"{s['name']} MOLA elevation {s['mola_elev_m']} != MEGDR {z[r, c]}")
check(True, "Landing-site MOLA elevations equal the MEGDR cell values")

# ---------- 7. Texture georeferencing: Viking colour & MOLA texture vs independent data, lat AND lon shifts
def best_shift(img, ref):
    best = None
    for dy in (-8, 0, 8):
        for dx in (-16, 0, 16):
            a = np.roll(np.roll(img, dy, 0), dx, 1)[240:1200].ravel(); bb = ref[240:1200].ravel()
            m = np.isfinite(a) & np.isfinite(bb); r = np.corrcoef(a[m], bb[m])[0, 1]
            best = max(best or (r, dy, dx), (r, dy, dx))
    return best
vik = np.asarray(Image.open(WEB / "globe/viking.jpg").convert("L").resize((2880, 1440), Image.BOX), np.float64)
r_, dy, dx = best_shift(vik, alb.astype(np.float64))
check((dy, dx) == (0, 0), f"Viking texture aligned with TES albedo (best r={r_:.3f} at shift {dy/8},{dx/8} deg)")
mtex = np.asarray(Image.open(WEB / "globe/mola_shaded.jpg").convert("RGB").resize((2880, 1440), Image.BOX), np.float64)
zc = z.reshape(1440, 4, 2880, 4).mean(axis=(1, 3))
from cmcrameri import cm as cmc
lut = (cmc.batlow(np.linspace(0, 1, 256))[:, :3] * 255)
idx = np.argmin(((mtex[::4, ::4, None, :] / np.maximum(mtex[::4, ::4].max(axis=2, keepdims=True), 1)[..., None]
                  - lut[None, None] / lut.max(axis=1, keepdims=True)[None, None]) ** 2).sum(-1), axis=-1).astype(float)
r_, dy, dx = best_shift(np.repeat(np.repeat(idx, 4, 0), 4, 1), np.clip(zc, -8000, 8000))
check((dy, dx) == (0, 0), f"MOLA shaded texture aligned with MEGDR (best r={r_:.3f} at shift {dy/8},{dx/8} deg)")

# ---------- 8. SWIM overlay texture: visible pixels only where data exist and terrain <= +1 km
ov = np.asarray(Image.open(WEB / "globe/ice_0_1.png"))[..., 3]
zo = np.asarray(Image.fromarray(z.astype(np.float32)).resize((4096, 2048), Image.BOX))
lat_o = 90 - (np.arange(2048) + 0.5) * 180 / 2048
vis = ov > 0
check(not vis[np.abs(lat_o) > 60.1].any() and not (vis & (zo > 1000)).any(),
      "SWIM overlay hidden poleward of 60 deg and on terrain above +1 km (SWIM browse mask)")

# ---------- 9. Terrain tile footprint
R_, lat0, lon0 = tm["body"]["radius_m"], tm["center"]["lat"], tm["center"]["lon"]
half = (tm["extent_m"]["east"] - tm["extent_m"]["west"]) / 2
ok = abs(b["north"] - (lat0 + math.degrees(half / R_))) < 1e-9 and abs(b["east"] - (lon0 + math.degrees(half / (R_ * math.cos(math.radians(lat0)))))) < 1e-9
check(ok, "Jezero tile bounds in meta.json consistent with its projection and size")

# ---------- 10. On-demand global site (HRSC-MOLA 200 m + CTX) vs the HiRISE 1 m Jezero tile
# Rebuilt from scratch into data/audit (network), then compared with the HiRISE heightmap over the HiRISE footprint.
sys.path.insert(0, str(ROOT / "pipeline"))
import build_terrain as bt
gdir = AUD / "site_jezero_global"
try:
    bt.build_site({"profile": "global", "lat": 18.45, "lon": 77.43, "size_km": 20, "out_dir": str(gdir)})
    gm = json.loads((gdir / "meta.json").read_text())
    gn = gm["heightmap"]["width"]
    gh = np.fromfile(gdir / "heightmap.bin", "<f4").reshape(gn, gn).astype(np.float64)
    hn = tm["heightmap"]["width"]
    hh = np.fromfile(WEB / "terrain/jezero/heightmap.bin", "<f4").reshape(hn, hn).astype(np.float64)

    def sample(meta, arr, lat, lon):
        R = meta["body"]["radius_m"]; la0, lo0 = meta["center"]["lat"], meta["center"]["lon"]
        x = np.radians(lon - lo0) * R * math.cos(math.radians(la0)); y = np.radians(lat - la0) * R
        d = meta["heightmap"]["spacing_m"]
        c = (x - meta["extent_m"]["west"]) / d - 0.5; r = (meta["extent_m"]["north"] - y) / d - 0.5
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int); fc, fr = c - c0, r - r0
        return (arr[r0, c0] * (1 - fc) * (1 - fr) + arr[r0, c0 + 1] * fc * (1 - fr)
                + arr[r0 + 1, c0] * (1 - fc) * fr + arr[r0 + 1, c0 + 1] * fc * fr)
    gl = np.linspace(b["south"] + 0.002, b["north"] - 0.002, 64)
    gL = np.linspace(b["west"] + 0.002, b["east"] - 0.002, 64)
    LA, LO = [a.ravel() for a in np.meshgrid(gl, gL, indexing="ij")]
    dz = sample(gm, gh, LA, LO) - sample(tm, hh, LA, LO)
    check(abs(dz.mean()) < 50, f"Global site (HRSC-MOLA 200 m) vs HiRISE 1 m DTM over the Jezero tile: mean d "
                               f"{dz.mean():+.1f} m, rms {np.sqrt((dz ** 2).mean()):.1f} m (200 m vs 1 m resolution)")
    st = gm["validation"]
    check(all(c["level"] in ("pass", "warn") for c in st["checks"]) and abs(st["megdr_mean_diff_m"]) < 100,
          f"Global site validation: {st['status']}, DEM vs MOLA MEGDR mean {st['megdr_mean_diff_m']:+.1f} m, "
          f"imagery offset {math.hypot(st['registration']['offset_east_m'], st['registration']['offset_north_m']):.0f} m")
    gb, half = gm["bounds_deg"], (gm["extent_m"]["east"] - gm["extent_m"]["west"]) / 2
    R_, la0 = gm["body"]["radius_m"], gm["center"]["lat"]
    check(abs(gb["north"] - (la0 + math.degrees(half / R_))) < 1e-9 and
          abs(gb["east"] - (gm["center"]["lon"] + math.degrees(half / (R_ * math.cos(math.radians(la0)))))) < 1e-9,
          "Global site bounds in meta.json consistent with its projection and size")
except bt.SiteError as e:
    check(False, f"Global site build failed: {e}")

# ---------- 11. Colour layer: color.jpg pixels are the Viking mosaic (globe base map) at the right lat/lon
from rasterio.crs import CRS as _CRS
from rasterio.warp import transform as _wt
VIK = RAW / "Mars_Viking_ClrMosaic_global_925m.tif"
cm = json.loads((WEB / "terrain/jezero/meta.json").read_text())
if cm.get("color") and VIK.exists():
    worst = 0.0
    for fname, ext in ((cm["color"]["file"], cm["extent_m"]), (cm["color"]["context_file"], cm["context"]["extent_m"])):
        im = np.asarray(Image.open(WEB / "terrain/jezero" / fname).convert("RGB"), float)
        n = im.shape[0]; E = ext["east"] - ext["west"]; R_ = cm["body"]["radius_m"]
        rr, cc = rng.integers(8, n - 8, 60), rng.integers(8, n - 8, 60)
        x = ext["west"] + (cc + 0.5) * E / n; y = ext["north"] - (rr + 0.5) * E / n
        la = cm["center"]["lat"] + np.degrees(y / R_)
        lo = cm["center"]["lon"] + np.degrees(x / (R_ * math.cos(math.radians(cm["center"]["lat"]))))
        with rasterio.open(VIK) as vs:
            X, Y = _wt(_CRS.from_proj4(f"+proj=longlat +R={R_} +no_defs"), vs.crs, lo.tolist(), la.tolist())
            for (a, b_), px in zip([(~vs.transform) * (u, v) for u, v in zip(X, Y)], im[rr, cc]):
                c0, r0 = int(math.floor(a - 0.5)), int(math.floor(b_ - 0.5)); fc, fr = a - 0.5 - c0, b_ - 0.5 - r0
                blk = vs.read(window=rasterio.windows.Window(c0, r0, 2, 2)).astype(float)
                ref = (blk[:, 0, 0] * (1 - fc) * (1 - fr) + blk[:, 0, 1] * fc * (1 - fr)
                       + blk[:, 1, 0] * (1 - fc) * fr + blk[:, 1, 1] * fc * fr)
                worst = max(worst, float(np.median(np.abs(px - ref))))
    check(worst < 6, f"Jezero colour layers = Viking colour mosaic at the same lat/lon (max per-point median |d| {worst:.1f} DN, JPEG)")
else:
    check(False, "Jezero colour layer missing (run build_terrain.py --color-only web/public/terrain/jezero)")

# ---------- 12. Climate layers (dust, temperature, wind): published 1-degree readout grids re-derived point by point
# from the reduced product grids with an independent scalar bilinear formula (build_climate.py uses array code).
CL = ROOT / "data/raw/climate"
if (WEB / "globe/climate.json").exists() and (CL / "openmars_my30_reduced.npz").exists():
    cj = json.loads((WEB / "globe/climate.json").read_text())
    om, du = np.load(CL / "openmars_my30_reduced.npz"), np.load(CL / "dust_my30_reduced.npz")
    def at_points(a, lat, lon, la, lo):
        fr = min(max((lat[0] - la) / (lat[0] - lat[1]), 0), len(lat) - 1)
        fc = ((lo - lon[0]) / (lon[1] - lon[0])) % len(lon)
        r0, c0 = min(int(fr), len(lat) - 2), int(fc); tr, tc = fr - r0, fc - c0; c1 = (c0 + 1) % len(lon)
        return a[r0, c0]*(1-tr)*(1-tc) + a[r0, c1]*(1-tr)*tc + a[r0+1, c0]*tr*(1-tc) + a[r0+1, c1]*tr*tc
    worst = {}
    for sc in cj["scalars"]:
        g = np.fromfile(WEB / "globe" / sc["file"], "<i2").reshape(sc["height"], sc["width"]) / sc["scale"]
        src, lat, lon = {"dust": (du["tot_mean"], du["lat"], du["lon"]), "temp": (om["ts_mean"], om["lat"], om["lon"]),
                         "temp_min": (om["ts_min"], om["lat"], om["lon"]), "temp_max": (om["ts_max"], om["lat"], om["lon"]),
                         "wind": (om["spd_mean"], om["lat"], om["lon"]), "wind_u": (om["u_mean"], om["lat"], om["lon"]),
                         "wind_v": (om["v_mean"], om["lat"], om["lon"])}[sc["id"]]
        d = 0.0
        for la, lo in glob_pts:
            r, c = cell(la, lo, sc["width"], sc["height"])
            d = max(d, abs(g[r, c] - at_points(src, lat, lon, 90 - (r + 0.5), -180 + (c + 0.5))) * sc["scale"])
        worst[sc["id"]] = d
    check(max(worst.values()) <= 0.51, f"Climate readouts (dust, temperature, wind) = product grids interpolated at {len(glob_pts)} points "
          f"(max error {max(worst.values()):.2f} storage units, i.e. rounding only)")
    # Known geography as an independent sanity check of the published grids.
    T = np.fromfile(WEB / "globe/temp.i16", "<i2").reshape(180, 360) / 10
    D = np.fromfile(WEB / "globe/dust.i16", "<i2").reshape(180, 360) / 10000
    hellas, tharsis = D[cell(-42, 70, 360, 180)], D[cell(0, -110, 360, 180)]
    check(T[cell(0, 0, 360, 180)] > T[cell(80, 0, 360, 180)] + 30 and hellas > 1.5 * tharsis,
          f"Climate geography: equator warmer than 80 N by >30 K; more dust column over Hellas ({hellas:.2f}) than over Tharsis ({tharsis:.2f})")
else:
    print("[skip] climate layers not built on this computer (pipeline/build_climate.py)")

print(f"\n{sum(results)}/{len(results)} audit checks passed")
sys.exit(0 if all(results) else 1)
