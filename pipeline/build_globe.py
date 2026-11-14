#!/usr/bin/env python3
"""
RED ATLAS - build the scientific Mars globe layers from official NASA / USGS / PDS products.

Every output is on ONE global grid:
  planetocentric latitude, east-positive longitude, -180..+180 (left edge = 180 W), north up,
  pixel-is-area. Textures are equirectangular; scalar grids are 8 px/deg (0.125 deg) Int16 LE.

Inputs (see docs/DATA_SOURCES.md for citations; small files are downloaded to data/raw/globe):
  - PDS MGS MOLA MEGDR megt90n000fb.img (32 px/deg topography, metres above the areoid)
  - USGS Viking colour mosaic 925 m (streamed)
  - USGS MGS TES albedo 8 px/deg
  - PSI SWIM4MIM ice-consistency maps (0-1 m, 1-5 m, >5 m)
  - PDS ODE landing-site table (transcribed in pipeline/globe_sites.yaml) + NASA MMGIS Mars 2020 waypoints

Usage: .venv/bin/python pipeline/build_globe.py
"""
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
import yaml
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
import matplotlib
from cmcrameri import cm as cmc

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "globe"
OUT = ROOT / "web" / "public" / "globe"
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")

R_MARS = 3396190.0
GEO = CRS.from_proj4(f"+proj=longlat +R={R_MARS} +no_defs")
NODATA16 = -32768
SWIM_ELEV_MASK_M = 1000         # SWIM browse products mask terrain above ~+1 km (see swim section)
MOLA_CMIN, MOLA_CMAX = -8000, 8000   # colour stretch for the shaded-elevation base map
GRID_PPD = 8                      # scalar readout grids
GW, GH = 360 * GRID_PPD, 180 * GRID_PPD
TEX_W, TEX_H = 8192, 4096         # base textures
OVL_W, OVL_H = 4096, 2048         # overlay textures

VIKING_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_Viking_ClrMosaic_global_925m.tif"
MEGDR_URL = "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg032/megt90n000fb.img"
TES_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MGS_TES_Albedo_mosaic_global_7410m.tif"
SWIM_URL = "https://swim.psi.edu/output/SWIM4MIM/Global/Composite/{}.tif"
M20_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"

checks = []


def fail(msg):
    print(f"\n[FAIL] {msg}", file=sys.stderr)
    sys.exit(1)


def check(ok, msg):
    checks.append({"ok": bool(ok), "check": msg})
    print(f"  [{'ok' if ok else 'FAIL'}] {msg}")
    if not ok:
        fail(msg)


def grid_index(lat, lon, w, h):
    """Row/col of the cell containing (lat, lon) on a global -180..180 grid."""
    lon = ((lon + 180) % 360) - 180
    c = min(int((lon + 180) / 360 * w), w - 1)
    r = min(int((90 - lat) / 180 * h), h - 1)
    return r, c


def block_mean(a, f, mask=None):
    h, w = a.shape
    a = a.reshape(h // f, f, w // f, f)
    if mask is None:
        return a.mean(axis=(1, 3))
    m = mask.reshape(h // f, f, w // f, f)
    s = np.where(m, a, 0).sum(axis=(1, 3))
    n = m.sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, s / np.maximum(n, 1), np.nan)


def to_int16(a, scale):
    out = np.clip(np.where(np.isfinite(a), np.round(a * scale), 0), -32767, 32767)
    return np.where(np.isfinite(a), out, NODATA16).astype("<i2")   # NODATA16 must survive the clip


def colorize(a, cmap, vmin, vmax, alpha=None):
    norm = np.clip((a - vmin) / (vmax - vmin), 0, 1)
    rgba = (cmap(np.nan_to_num(norm)) * 255).astype(np.uint8)
    rgba[..., 3] = 255 if alpha is None else alpha
    rgba[~np.isfinite(a), 3] = 0
    return rgba


def legend_stops(cmap, n=11):
    return [matplotlib.colors.to_hex(cmap(i / (n - 1))) for i in range(n)]


def download(url, path):
    if path.exists():
        return
    import urllib.request
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (red-atlas pipeline)"})
    with urllib.request.urlopen(req) as r, open(path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def hillshade(z, lat_rows, az=315.0, alt=45.0):
    """Hillshade with true metric spacing on a 32 ppd lat/lon grid (visual aid only)."""
    d = math.radians(1 / 32)
    coslat = np.clip(np.cos(np.radians(lat_rows)), 0.02, None)[:, None]
    dzdx = np.gradient(z, axis=1) / (R_MARS * d * coslat)
    dzdy = -np.gradient(z, axis=0) / (R_MARS * d)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    zen, azr = math.radians(90 - alt), math.radians(az)
    hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(azr - aspect)
    return np.clip(hs, 0, 1), np.degrees(slope)


def swim_browse_alignment(browse_png, data):
    """Correlate a SWIM GeoTIFF with the SWIM team's own browse rendering (blue = positive consistency).
    The browse map frame is located from its white 30-degree graticule lines. Returns {shift_deg: r}."""
    im = np.asarray(Image.open(browse_png).convert("RGB")).astype(np.float32)
    white = im.min(axis=2) > 235
    def interior_lines(frac):
        idx = np.where(frac > 0.6)[0]
        runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
        # Graticule lines are thin (<= 6 px); frame borders and the colour bar are wide blocks.
        return np.array([r.mean() for r in runs if len(r) <= 6])
    vx = interior_lines(white.mean(axis=0))
    hy = interior_lines(white.mean(axis=1))
    if len(vx) != 11 or len(hy) != 3:
        fail(f"{browse_png.name}: graticule detection found {len(vx)} meridians / {len(hy)} parallels (expected 11 / 3)")
    sx, sy = np.median(np.diff(vx)), np.median(np.diff(hy))
    x0, x1 = int(round(vx[0] - sx)), int(round(vx[-1] + sx))
    y0, y1 = int(round(hy[0] - sy)), int(round(hy[-1] + sy))
    crop = im[y0:y1, x0:x1]
    blue = crop[..., 2] - crop[..., 0]
    d = np.asarray(Image.fromarray(data.astype(np.float32)).resize((blue.shape[1], blue.shape[0]), Image.BILINEAR))
    out = {}
    for sh in (0, 90, 180, 270):
        x = np.roll(d, int(sh / 360 * d.shape[1]), axis=1)
        out[sh] = float(np.corrcoef(x.ravel(), blue.ravel())[0, 1])
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    layers, scalars = [], []
    sites_cfg = yaml.safe_load((ROOT / "pipeline" / "globe_sites.yaml").read_text())

    # ------------------------------------------------------------------ MOLA MEGDR
    print("\n[MOLA] MGS MOLA MEGDR 32 ppd topography (PDS)")
    megdr = RAW / "megt90n000fb.img"
    download(MEGDR_URL, megdr)
    # PDS4 label: SignedMSB2, 5760 lines x 11520 samples, metres, lon 0..360 E, row 0 = 90 N.
    z = np.fromfile(megdr, dtype=">i2")
    if z.size != 5760 * 11520:
        fail(f"MEGDR size {z.size} != 5760*11520 (label)")
    z = z.reshape(5760, 11520).astype(np.float32)
    z = np.roll(z, 5760, axis=1)                      # 0..360 E  ->  -180..180 E
    lat32 = 90 - (np.arange(5760) + 0.5) / 32
    zmax_rc = np.unravel_index(np.argmax(z), z.shape)
    zmin_rc = np.unravel_index(np.argmin(z), z.shape)
    lon_at = lambda c, ppd: -180 + (c + 0.5) / ppd
    print(f"  max {z.max():.0f} m at {lat32[zmax_rc[0]]:.2f}N {lon_at(zmax_rc[1], 32):.2f}E; "
          f"min {z.min():.0f} m at {lat32[zmin_rc[0]]:.2f}N {lon_at(zmin_rc[1], 32):.2f}E")
    # Georeferencing sanity: highest point must be Olympus Mons (18.65 N, 226.2 E = -133.8 E, IAU Gazetteer);
    # lowest point must lie in Hellas Planitia (42.4 S, 70.5 E, IAU Gazetteer).
    check(abs(lat32[zmax_rc[0]] - 18.65) < 2 and abs(lon_at(zmax_rc[1], 32) + 133.8) < 2,
          "MOLA maximum lies on Olympus Mons (georeferencing + longitude convention)")
    # Hellas Planitia is ~2,300 km across (radius ~19 deg of arc on Mars), so test angular distance from its centre.
    la1, lo1, la2, lo2 = map(math.radians, (lat32[zmin_rc[0]], lon_at(zmin_rc[1], 32), -42.4, 70.5))
    ang = math.degrees(math.acos(math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(lo1 - lo2)))
    check(ang < 17, f"MOLA minimum lies inside Hellas Planitia ({ang:.1f} deg from basin centre)")
    check(-8206 <= z.min() and z.max() <= 21181,
          "MOLA values within label's stated observation range (-8206 .. 21181 m)")

    _, slope32 = hillshade(z, lat32)              # true-scale slope (data)
    hs, _ = hillshade(z * 20, lat32)              # 20x exaggerated hillshade (visual aid only)
    # Base texture: elevation colour (cmc.batlow) modulated by hillshade.
    zc = np.clip((z - MOLA_CMIN) / (MOLA_CMAX - MOLA_CMIN), 0, 1)
    rgb = cmc.batlow(zc)[..., :3] * (0.25 + 0.75 * hs[..., None])
    img = Image.fromarray((rgb * 255).astype(np.uint8)).resize((TEX_W, TEX_H), Image.BOX)
    img.save(OUT / "mola_shaded.jpg", quality=88)
    del rgb, img

    elev8 = block_mean(z, 32 // GRID_PPD)
    slope8 = block_mean(slope32, 32 // GRID_PPD)
    to_int16(elev8, 1).tofile(OUT / "elev.i16")
    to_int16(slope8, 100).tofile(OUT / "slope.i16")
    scalars += [
        {"id": "elev", "file": "elev.i16", "scale": 1, "units": "m", "label": "MOLA topography",
         "note": "metres above the Mars areoid; mean of 1/32-degree cells"},
        {"id": "slope", "file": "slope.i16", "scale": 100, "units": "deg", "label": "Regional slope",
         "note": "mean slope at 1.85 km baseline (MOLA 32 ppd); NOT astronaut-scale"},
    ]
    slope_tex = Image.fromarray(colorize(slope32, cmc.lajolla, 0, 15, alpha=235)).resize((OVL_W, OVL_H), Image.BOX)
    slope_tex.save(OUT / "slope.png", optimize=True)
    del slope_tex

    mola_credit = {
        "mission": "Mars Global Surveyor", "instrument": "MOLA", "product": "MEGDR megt90n000fb (1/32 degree)",
        "source": "NASA PDS Geosciences Node", "url": MEGDR_URL,
        "doc": "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/document/",
    }
    layers.append({"id": "mola", "kind": "base", "name": "MOLA elevation (shaded)", "texture": "mola_shaded.jpg",
                   "units": "m above areoid", "min": MOLA_CMIN, "max": MOLA_CMAX, "legend": legend_stops(cmc.batlow),
                   "description": "Laser-altimeter topography: planetary radius minus areoid (GMM3, degree/order 50). "
                                  "Colours saturate at -8 km and +8 km (Tharsis volcanoes reach +21.2 km; use the readout for exact values). Hillshade (sun from NW, 45 deg, 20x relief) is a visual aid.", **mola_credit})
    layers.append({"id": "slope", "kind": "overlay", "name": "Regional slope (MOLA)", "texture": "slope.png",
                   "units": "deg", "min": 0, "max": 15, "legend": legend_stops(cmc.lajolla),
                   "description": "Slope computed from MOLA 1/32-degree topography (1.85 km baseline). Shows regional "
                                  "steepness for landing/traverse context; local slopes can be much steeper.",
                   "derived": True, **mola_credit})

    # ------------------------------------------------------------------ TES albedo
    print("\n[TES] MGS TES albedo 8 ppd (USGS)")
    tes_path = RAW / "Mars_MGS_TES_Albedo_mosaic_global_7410m.tif"
    download(TES_URL, tes_path)
    with rasterio.open(tes_path) as s:
        if (s.width, s.height) != (2880, 1440):
            fail("TES albedo grid is not 2880 x 1440 (label: 8 px/deg, -180..180)")
        alb = s.read(1).astype(np.float32)
        alb[alb < -1e30] = np.nan
    # Science sanity (classic albedo features): Syrtis Major is dark, Arabia Terra is bright.
    a_syrtis = alb[grid_index(8.4, 69.5, 2880, 1440)]
    a_arabia = alb[grid_index(20.0, 5.0, 2880, 1440)]
    print(f"  Syrtis Major {a_syrtis:.3f}, Arabia Terra {a_arabia:.3f}")
    check(a_syrtis < a_arabia - 0.08, "TES albedo: Syrtis Major darker than Arabia Terra")
    to_int16(alb, 10000).tofile(OUT / "albedo.i16")
    scalars.append({"id": "albedo", "file": "albedo.i16", "scale": 10000, "units": "", "label": "TES albedo",
                    "note": "unitless; product values clipped to 0.06-0.32"})
    Image.fromarray(colorize(alb, matplotlib.colormaps["gray"], 0.06, 0.32, alpha=235)).resize(
        (OVL_W, OVL_H), Image.BILINEAR).save(OUT / "albedo.png", optimize=True)
    layers.append({"id": "albedo", "kind": "overlay", "name": "Surface albedo (TES)", "texture": "albedo.png",
                   "units": "unitless", "min": 0.06, "max": 0.32, "legend": legend_stops(matplotlib.colormaps["gray"]),
                   "description": "Thermal Emission Spectrometer albedo (P. Christensen, ASU). Bright regions are "
                                  "generally dust-covered; dark regions expose sand or rock. Values clipped at 0.06/0.32 "
                                  "in the source product.",
                   "mission": "Mars Global Surveyor", "instrument": "TES", "product": "GLOBAL_ALBEDO_8PPD",
                   "source": "USGS Astrogeology", "url": TES_URL, "doc": TES_URL.replace(".tif", "_pds3.lbl")})

    # ------------------------------------------------------------------ SWIM ice consistency
    print("\n[SWIM] SWIM4MIM ice consistency (PSI / NASA)")
    swim_meta = [("SWIM4MIM_Ci_0_1", "ice_0_1", "Ice consistency 0-1 m",
                  "Neutron, thermal, shallow geomorphology and radar surface power"),
                 ("SWIM4MIM_Ci_1_5", "ice_1_5", "Ice consistency 1-5 m",
                  "Shallow geomorphology, radar surface power and radar dielectric estimates"),
                 ("SWIM4MIM_Ci_5", "ice_5", "Ice consistency >5 m",
                  "Deep geomorphology and radar dielectric estimates")]
    tgt8 = from_origin(-180, 90, 1 / GRID_PPD, 1 / GRID_PPD)
    tgto = from_origin(-180, 90, 360 / OVL_W, 180 / OVL_H)
    for fname, lid, name, inputs in swim_meta:
        p = RAW / f"{fname}.tif"
        download(SWIM_URL.format(fname), p)
        with rasterio.open(p) as s:
            src = s.read(1)
            g8 = np.full((GH, GW), -30.0, np.float32)
            reproject(src, g8, src_transform=s.transform, src_crs=s.crs, src_nodata=-30.0,
                      dst_transform=tgt8, dst_crs=GEO, dst_nodata=-30.0, resampling=Resampling.average)
            go = np.full((OVL_H, OVL_W), -30.0, np.float32)
            reproject(src, go, src_transform=s.transform, src_crs=s.crs, src_nodata=-30.0,
                      dst_transform=tgto, dst_crs=GEO, dst_nodata=-30.0, resampling=Resampling.average)
        g8[g8 == -30.0] = np.nan
        go[go == -30.0] = np.nan
        # Georeferencing test against the SWIM team's own browse image (the web page text says 0-360 E,
        # the GeoTIFF header says -180..180; the browse rendering decides).
        bpath = RAW / f"{fname}_Browse.png"
        download(SWIM_URL.format(fname).replace(".tif", "_Browse.png"), bpath)
        r = swim_browse_alignment(bpath, src)
        print(f"  {lid}: correlation with SWIM browse at lon shift 0/90/180/270 = "
              + " / ".join(f"{r[k]:.2f}" for k in (0, 90, 180, 270)))
        check(r[0] > 0.6 and r[0] > max(r[90], r[180], r[270]) + 0.1,
              f"SWIM {lid}: matches SWIM's browse product at zero longitude shift (-180..180 E confirmed)")
        # The SWIM browse products black out terrain above ~+1 km MOLA elevation (measured: 91-98 % of
        # pixels above +1 km are masked vs ~4 % below 0.5 km). Reproduce that mask for display.
        mola_o = np.asarray(Image.fromarray(z).resize((OVL_W, OVL_H), Image.BOX))
        go[mola_o > SWIM_ELEV_MASK_M] = np.nan
        to_int16(g8, 1000).tofile(OUT / f"{lid}.i16")
        scalars.append({"id": lid, "file": f"{lid}.i16", "scale": 1000, "units": "", "label": name,
                        "note": "SWIM consistency index; + consistent with ice, - inconsistent",
                        "mask_above_elev_m": SWIM_ELEV_MASK_M})
        Image.fromarray(colorize(go, cmc.vik_r, -1, 1, alpha=225)).save(OUT / f"{lid}.png", optimize=True)
        layers.append({"id": lid, "kind": "overlay", "name": f"Water ice - {name.split('consistency ')[1]}",
                       "texture": f"{lid}.png", "units": "consistency index", "min": -1, "max": 1,
                       "legend": legend_stops(cmc.vik_r),
                       "description": f"SWIM combined ice-consistency map ({inputs}). Positive values: the input "
                                      "datasets are consistent with buried water ice; negative: inconsistent. "
                                      "It is a consistency score, not an ice abundance. Coverage 60 S - 60 N. "
                                      "As in SWIM's own browse products, terrain above +1 km MOLA elevation is masked.",
                       "mission": "Multiple Mars orbiters (see SWIM documentation)", "instrument": "Neutron, thermal, geomorphology and radar datasets",
                       "product": fname, "source": "Subsurface Water Ice Mapping (SWIM) project, PSI / NASA",
                       "url": SWIM_URL.format(fname), "doc": "https://swim.psi.edu/SWIM4MIMProducts.php"})

    # ------------------------------------------------------------------ Viking colour
    print("\n[Viking] colour mosaic 925 m (~0.8 GB download, cached in data/raw/globe)")
    vik_out = OUT / "viking.jpg"
    vik_raw = RAW / "Mars_Viking_ClrMosaic_global_925m.tif"
    download(VIKING_URL, vik_raw)
    with rasterio.open(vik_raw) as s:
        if s.count != 3 or "+R=3396190" not in s.crs.to_proj4():
            fail("Viking mosaic header differs from label (3 bands, R=3396190)")
        dec = s.read(out_shape=(3, TEX_H, TEX_W), resampling=Resampling.average)
        dec_tf = s.transform * s.transform.scale(s.width / TEX_W, s.height / TEX_H)
        src_crs = s.crs
    out = np.zeros((3, TEX_H, TEX_W), np.uint8)
    reproject(dec, out, src_transform=dec_tf, src_crs=src_crs, src_nodata=0,
              dst_transform=from_origin(-180, 90, 360 / TEX_W, 180 / TEX_H), dst_crs=GEO, dst_nodata=0,
              resampling=Resampling.bilinear)
    Image.fromarray(np.moveaxis(out, 0, -1)).save(vik_out, quality=88)
    # Cross-mission alignment test: Viking brightness should correlate with TES albedo, best at zero shift.
    lum = out.astype(np.float32).mean(axis=0)
    lum8 = np.asarray(Image.fromarray(lum).resize((GW, GH), Image.BOX))
    band = slice(int(GH * 0.25), int(GH * 0.75))     # 45 S .. 45 N
    def corr(shift):
        a = np.roll(lum8, shift, axis=1)[band].ravel()
        b = alb[band].ravel()
        m = np.isfinite(a) & np.isfinite(b)
        return float(np.corrcoef(a[m], b[m])[0, 1])
    c0, cl, cr = corr(0), corr(-16), corr(16)
    print(f"  Viking-vs-TES correlation: shift 0 = {c0:.3f}, -2 deg = {cl:.3f}, +2 deg = {cr:.3f}")
    check(c0 > 0.5 and c0 > cl and c0 > cr, "Viking colour aligns with TES albedo (best correlation at zero shift)")
    layers.insert(0, {"id": "viking", "kind": "base", "name": "Viking colour mosaic", "texture": "viking.jpg",
                      "description": "Viking Orbiter colour mosaic (USGS Astrogeology, 925 m). Colour reflects "
                                     "surface brightness; Viking-era image seams and haze remain visible.",
                      "mission": "Viking Orbiter 1 & 2", "instrument": "VIS", "product": "Mars_Viking_ClrMosaic_global_925m",
                      "source": "USGS Astrogeology", "url": VIKING_URL, "doc": VIKING_URL.replace(".tif", "_pds3.lbl")})

    # ------------------------------------------------------------------ sites + Jezero cross-checks
    print("\n[Sites] landing sites and Jezero")
    terrain_meta = json.loads((ROOT / "web" / "public" / "terrain" / "jezero" / "meta.json").read_text())
    m20_path = RAW / "M20_waypoints.json"
    download(M20_URL, m20_path)
    m20 = json.loads(m20_path.read_text())["features"]
    first = sorted(m20, key=lambda f: (f["properties"]["sol"], f["properties"]["site"], f["properties"]["drive"]))[0]["properties"]

    def elev_at(lat, lon):
        return float(z[grid_index(lat, lon, 11520, 5760)])
    d_land = elev_at(first["lat"], first["lon"]) - first["elev_geoid"]
    print(f"  MOLA at Perseverance first waypoint: {elev_at(first['lat'], first['lon']):.0f} m; "
          f"NASA elev_geoid {first['elev_geoid']:.1f} m; diff {d_land:.1f} m")
    check(abs(d_land) < 60, "MOLA areoid topography agrees with NASA Mars 2020 elev_geoid at the landing point (<60 m)")
    b = terrain_meta["bounds_deg"]
    r0, c0_ = grid_index(b["north"], b["west"], 11520, 5760)
    r1, c1 = grid_index(b["south"], b["east"], 11520, 5760)
    mola_tile = float(z[r0:r1 + 1, c0_:c1 + 1].mean())
    hirise_tile = float(np.fromfile(ROOT / "web/public/terrain/jezero/heightmap.bin", "<f4").mean())
    print(f"  Jezero tile mean: MOLA {mola_tile:.0f} m, HiRISE DTM {hirise_tile:.0f} m")
    check(abs(mola_tile - hirise_tile) < 60, "HiRISE tile and MOLA agree on Jezero mean elevation (<60 m)")

    sites = []
    for s_ in sites_cfg["landers"]:
        lon = s_["lon_e"] if s_["lon_e"] <= 180 else s_["lon_e"] - 360
        sites.append({**s_, "lon": lon, "mola_elev_m": round(elev_at(s_["lat"], lon))})
    sites.append({"id": "perseverance", "name": "Perseverance (Mars 2020)", "lat": round(first["lat"], 6),
                  "lon": round(first["lon"], 6), "lon_e": round(first["lon"], 6), "year": 2021,
                  "mola_elev_m": round(elev_at(first["lat"], first["lon"])),
                  "note": f"First localized waypoint (sol {first['sol']}); elev_geoid {first['elev_geoid']} m",
                  "source": "NASA/JPL Mars 2020 MMGIS waypoint layer (M20_waypoints.json)", "url": M20_URL})
    traverse = [[round(f["properties"]["lat"], 6), round(f["properties"]["lon"], 6), f["properties"]["sol"]]
                for f in sorted(m20, key=lambda f: (f["properties"]["sol"], f["properties"]["site"], f["properties"]["drive"]))]

    meta = {
        "frame": {"body": "Mars", "radius_m": R_MARS, "latitude": "planetocentric", "longitude": "east-positive, -180..180",
                  "texture_layout": "equirectangular, left edge 180 W, top 90 N, pixel-is-area"},
        "grid": {"width": GW, "height": GH, "ppd": GRID_PPD, "format": "int16-le", "nodata": NODATA16},
        "layers": layers, "scalars": scalars, "sites": sites,
        "jezero_tile": {"bounds_deg": b, "name": terrain_meta["site"]["name"]},
        "m20_traverse": {"points": traverse, "source": M20_URL, "layer_name": json.loads(m20_path.read_text())["name"]},
        "validation": checks,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (OUT / "globe.json").write_text(json.dumps(meta, indent=1))
    print(f"\nWrote {OUT} ({len(layers)} layers, {len(scalars)} scalar grids, {len(sites)} sites); all checks passed.")


if __name__ == "__main__":
    main()
