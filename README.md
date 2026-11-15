# RED ATLAS — Interactive 3D Martian Map

NASA Space Apps challenge "Interplanetary Survival Guide: Martian Map".

The opening view is a **scientific Mars globe**. It uses a calibrated planetocentric frame (east-positive, −180…180°) with real NASA data layers that you can switch and read out point by point:

- **Base maps:** Viking Orbiter colour mosaic, or MGS MOLA shaded elevation (metres above the areoid).
- **Science overlays:** water ice from the SWIM project (0–1 m, 1–5 m and >5 m depth), MGS TES surface albedo, and regional slope derived from MOLA.
- **Context:** NASA landing sites from the PDS ODE table, the Perseverance traverse from NASA MMGIS, the Jezero tile outline and a 30° graticule.
- **Readout:** hover or click anywhere to see lat/lon, elevation, slope, albedo and the three ice-consistency values.

**Explore terrain** flies down to Jezero and opens the 1 m HiRISE 3D tile.

**Land anywhere:** click any point on the globe, choose 10/20/40 km and press **Land here**.
- The camera descends while a local server builds a 3D site for that point. Elevation comes from the HRSC–MOLA blended DEM (200 m) and imagery from the CTX global mosaic (~5 m).
- The site opens in the same viewer, usually in 5–15 s the first time and instantly from cache.
- Each site is validated against its documented headers and MOLA, and the HUD shows the results.

Every 3D view, Jezero included, sits inside a wider, lower-resolution **context ring**:
- Size: 8 × the site edge, at least 64 km; for Jezero that covers the whole crater.
- Data: the 200 m DEM and coarser CTX imagery, under a Mars-sky haze, so there is no black void at the edge.
- A yellow outline marks the high-resolution tile, which is where readouts apply.

3D views are shown in **Mars colour**: colour from the globe's Viking mosaic, detail from the full-resolution image. A toggle switches back to the original grayscale.
- A site starts building as soon as you select a point, so it is often ready by the time you press **Land here**.
- Transitions run through a haze veil with a real progress bar: descent → build → download → surface glide-in, and the reverse on return.

**Back to Mars** climbs back to orbit. All sources, conventions and checks are in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md). The header badge shows how many automated data checks passed.

## Run
```bash
# 1. Build data assets (both scripts abort if any validation check fails)
python3 -m venv .venv && .venv/bin/pip install rasterio numpy pyyaml pillow matplotlib cmcrameri h5py
.venv/bin/python pipeline/build_terrain.py   # Jezero HiRISE tile (streams ~1.7 GB; writes ~30 MB)
.venv/bin/python pipeline/build_globe.py     # globe layers (downloads ~1.2 GB to data/raw/globe; ~2.5 min after that)
.venv/bin/python pipeline/build_climate.py   # dust, temperature and wind filters (~180 MB of downloads, ~5 min).
                                             # Not in the repository (OpenMARS licence), so run it once per computer.
.venv/bin/python pipeline/audit.py           # independent accuracy audit of all published values (17 checks)

# 2. Start the viewer. `npm run dev` also starts the "Land here" site server (pipeline/site_server.py on :8765,
#    sites -> web/public/sites/<id>/) and proxies /api to it. Needs data/raw/globe/megt90n000fb.img (build_globe.py).
cd web && npm install && npm run dev                 # open the printed localhost URL
#    Build one site from the CLI:      .venv/bin/python pipeline/build_terrain.py --lat -4.59 --lon 137.44 --size 20
#    Add surroundings to a built site: .venv/bin/python pipeline/build_terrain.py --context-only web/public/terrain/jezero
```

## Terrain controls
Left-drag pans · right-drag rotates/tilts · wheel zooms toward the cursor. Hover shows lat/lon/elevation, and a click pins a point.

## Web checks
From `web/`, run `node check-globe.mjs` (initial view, reduced motion) and `node check-geo.mjs` (globe geodesy), and `npm run build` for TypeScript and the production build. Browser rendering and external imagery loading need a browser with WebGL and network access.

## How accuracy is kept
- The pipeline checks each product's live header against `pipeline/config.yaml` (values transcribed from the USGS metadata and labels). It stops on any mismatch.
- Both rasters are reprojected onto one local Equirectangular grid (Mars 2000 sphere, R = 3,396,190 m) centred on the tile, so 1 scene unit = 1 ground metre and the DTM and imagery align by construction.
- Clicked elevations come from bilinear sampling of the real Float32 DTM grid, not from mesh vertices.
- The validation results (heights vs. the source DTM, geolocation-formula error) are stored in `web/public/terrain/jezero/meta.json`.
- On-demand sites also compare their DEM with MOLA MEGDR and check that the uncontrolled CTX imagery lines up with the DEM. They screen out defective server tiles, and every result is stored in `meta.json → validation.checks` and shown in the HUD.

## Layout
```
pipeline/   config.yaml, build_terrain.py (build_site: hirise_jezero | global), site_server.py, build_globe.py, build_climate.py, audit.py
docs/       DATA_SOURCES.md (data dossier)
data/raw/docs/  official metadata/labels as downloaded
data/processed/ local-grid GeoTIFFs (for checking with GIS tools)
web/        Vite + React + Three.js (React Three Fiber) viewer
```
