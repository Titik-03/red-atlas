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

## Run with one command (Windows, macOS, Linux)

Install **Node.js 22 or newer** (includes npm) and **Python 3.12 or newer**, with both available on PATH. On Windows, select **Add Python to PATH** during installation. Reopen your terminal after installing them.

Extract the shared ZIP, open a terminal in the `red-atlas` folder containing `package.json`, then run:

```bash
npm start
```

The same command handles first setup and later launches. It creates a project-local Python environment, installs the pinned Python packages and locked web dependencies, builds missing globe/climate data, runs the accuracy audit, and starts both the viewer and the local “Land here” backend. It opens your browser automatically; the terminal also prints the Local URL. Keep the terminal open while using the app; Ctrl+C stops it.

First setup needs internet access, downloads about **1.4 GB** of source data, and takes several minutes or longer depending on the connection. Allow **5 GB of free disk space** for the extracted project, dependencies, caches, and generated sites. Further terrain landings also need internet access. On later launches, existing dependencies and data are reused. If setup fails, fix the reported error and run the same command again.

The ZIP includes the prepared globe, Jezero terrain, and station model. Climate layers are rebuilt on each recipient’s computer because of the existing OpenMARS redistribution restriction; they are never included in the shared ZIP. The original NASA/USGS source cache is downloaded for local site validation and the independent audit.

## Share the project

Send **`red-atlas-share.zip`** and tell recipients to extract it and run `npm start` inside its `red-atlas` folder, after installing the prerequisites above. Git is not required to run the extracted project.

When preparing another copy, include the root launch files (`package.json`, `start.mjs`, `run.py`, `requirements.txt`), README, `pipeline/`, `docs/`, `data/raw/docs/`, and `web/` including the lockfile and prepared `web/public` assets. Exclude `.git/`, `.venv/`, `node_modules/`, `web/dist/`, `web/public/sites/`, downloaded caches, credentials/editor folders, and the climate files listed in `.gitignore`. Do not copy a virtual environment or `node_modules` between PCs.

For development after setup, `cd web` then `npm run dev` still works. Manual data rebuilds use the scripts in `pipeline/`: `build_terrain.py`, `build_globe.py`, `build_climate.py`, and `audit.py`, executed with the Python interpreter in `.venv/bin/` (macOS/Linux) or `.venv/Scripts/` (Windows).

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
