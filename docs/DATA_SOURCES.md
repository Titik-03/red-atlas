# RED ATLAS — Data Sources Dossier

All values below are transcribed from the **official product documentation**: the USGS FGDC metadata XML, ISIS and PDS3 labels, and DOI landing pages. Each entry says which document it came from. Raw copies of the documents are kept in `data/raw/docs/`. `pipeline/config.yaml` holds the same values, and `pipeline/build_terrain.py` aborts if a live product header disagrees with them.

Status key: ✅ verified from the official document · ⚠️ open question, needs confirmation · 🕓 not yet used (future milestone)

---

## 1. HiRISE DTM Mosaic, Mars 2020 Terrain Relative Navigation — ✅ in use (Milestone 1)

| Field | Value | Source |
|---|---|---|
| Product ID | `JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40` | USGS index |
| Title | High-Resolution Imaging Science Experiment Digital Terrain Model Mosaic for Mars 2020 Terrain Relative Navigation | FGDC metadata |
| Authors | Fergason, Galuszka, Hare, Mayer, Redding, Smith (2020-07-24) | FGDC metadata |
| DOI | [10.5066/P9REJ9JN](https://doi.org/10.5066/P9REJ9JN) | FGDC metadata |
| Mission / instrument | Mars Reconnaissance Orbiter / HiRISE | FGDC metadata |
| URL | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif | USGS index |
| Projection | Equirectangular, CenterLongitude 0, CenterLatitude (lat_ts) 0 | ISIS label |
| Body | Mars, EquatorialRadius = PolarRadius = 3,396,190 m (D_Mars_2000_Sphere) | ISIS label, PDS3 label, FGDC metadata |
| Latitude / longitude | Planetocentric, PositiveEast, domain −180…180 | ISIS label |
| Bounds | lat 18.3068…18.6693, lon 77.2229…77.5840 | ISIS label |
| Grid | 21,400 × 21,488 px, 1.0 m/px, pixel-is-area | ISIS label, GeoTIFF |
| Data type | 32-bit float, LSB, Base 0, Multiplier 1 | ISIS label |
| NoData | −3.4028226550889045e+38 | GeoTIFF header |
| Units | metres | FGDC metadata |
| Value range | −2,659.776611328125 … −1,942.1046142578125 m | FGDC Range_Domain |
| Horizontal accuracy | HiRISE orthoimages co-registered "better than 3 meters at the 99th percentile". Against CTX, "94.1% of matched features have displacements less than 6 meters". | FGDC metadata |
| Vertical accuracy | "median vertical offset from the CTX DTM mosaic … of ~0.4 meters, with the CTX DTM mosaic floating above the HiRISE mosaic" | FGDC metadata |
| Caveat | Crater Rim (CR, far-western) stereo pair has "quality issues due to uncompensated y-parallax … users should be cautious" | FGDC metadata |
| Source stereo pairs | E: ESP_048908_1985/ESP_048842_1985 · N: ESP_037818_1990/ESP_037330_1990 · C: ESP_046060_1985/ESP_045994_1985 · DL: PSP_003798_1985/PSP_002387_1985 · W: ESP_042315_1985/ESP_037396_1985 · CR: ESP_037119_1985/ESP_036618_1985 | FGDC metadata |

### Vertical reference ✅ resolved: areoid
- The HiRISE metadata gives no explicit vertical datum. The CTX DTM metadata says *"Elevation values … refer to the Mars 2020 IAU Sphere with a radius of 3396190m."* The filename says `MOLAtopography_DeltaGeoid`.
- **Test with NASA data (2026-11-14).** We compared NASA's Mars 2020 rover waypoint layer ([MMGIS `M20_waypoints.json`](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), 708 localized positions) with this DTM.
  - At the **261 waypoints inside our tile**, NASA's `elev_geoid` equals the DTM value. Median difference 0.00 m, σ 0.08 m, range −0.33…+0.46 m.
  - NASA's sphere-relative `elev_radii` at the landing point is −4,253 m. That is about 1.7 km below the DTM value of −2,569.9 m.
  - MOLA MEGDR (areoid, PDS) agrees with the tile's mean elevation; see the globe validation in `web/public/globe/globe.json`.
- **Conclusion:** DTM heights are metres **relative to the Mars areoid** (MOLA convention). The "IAU sphere" wording describes the horizontal frame. The UI label was updated accordingly.

## 2. HiRISE Orthorectified Image Mosaic, Mars 2020 TRN — ✅ in use (Milestone 1)

| Field | Value | Source |
|---|---|---|
| Product ID | `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first` | USGS index |
| DOI | [10.5066/P9QJDP48](https://doi.org/10.5066/P9QJDP48) | usgs.gov data release |
| URL | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif | USGS index |
| Projection / body / lat-lon | identical to the DTM (Equirectangular, lat_ts 0, lon_0 0, R 3,396,190 m, planetocentric, east-positive) | ISIS label |
| Grid | 85,600 × 85,952 px, 0.25 m/px, same upper-left corner as the DTM (4,577,366 / 1,106,618 m) | ISIS label |
| Data type | 8-bit unsigned, single band | ISIS label |
| NoData | 0 | GeoTIFF header |
| Processing | Orthorectified onto the HiRISE DTM in SOCET SET, then 2D affine-registered to the CTX LVS map | FGDC metadata |

## 3. CTX DTM and Orthomosaic, Mars 2020 TRN — 🕓 fallback / wider context
- DTM: `JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0`, DOI [10.5066/P906QQT8](https://doi.org/10.5066/P906QQT8). 1,512 × 1,596 px at 20 m. Range −2,710.41 … −1,522.23 m. Vertical reference: "Mars 2020 IAU Sphere with a radius of 3396190m". Absolutely aligned to the HRSC Level-5 DTM (DLR / Mars Express).
- Ortho: `JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0`, 6 m.

## 4. Science globe layers — ✅ in use (built by `pipeline/build_globe.py`)
All layers are resampled onto one global grid: planetocentric, east-positive, −180…+180°, north up, pixel-is-area. Every check below runs in the pipeline, which aborts on failure. The results are stored in `web/public/globe/globe.json → validation` and summarized as a badge in the UI.

| Layer | Product / mission | Facts from the official documentation | Automatic check |
|---|---|---|---|
| Elevation, hillshade, regional slope | **PDS MGS MOLA MEGDR** `megt90n000fb` ([data](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg032/megt90n000fb.img), [docs](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/document/)) | 1/32°, SignedMSB2, metres, 5760 × 11520, lon 0–360 E (converted to ±180), planetocentric. *"Topography is the planetary radius minus the areoid radius"*, areoid GMM3 (mgm1025) to degree/order 50. Label states min/max −8206 / 21181 m. | Maximum lies on Olympus Mons; minimum lies inside Hellas; values are within the label range; agrees with NASA M20 `elev_geoid` at the landing point and with the HiRISE tile mean. |
| Surface albedo | **MGS TES** albedo `GLOBAL_ALBEDO_8PPD` (P. Christensen, ASU; USGS GeoTIFF `Mars_MGS_TES_Albedo_mosaic_global_7410m`) | 8 px/deg, float32, −180…180, planetocentric, label radius 3396.0 km. Values span 0.06–0.32 (clipped in the product). | Syrtis Major is darker than Arabia Terra; Viking brightness correlates best with TES albedo at zero longitude shift. |
| Colour base map | **Viking Orbiter** colour mosaic `Mars_Viking_ClrMosaic_global_925m` (USGS) | 3-band 8-bit, 64.05 px/deg, −180…180, planetocentric, R 3396.19 km. | Correlation with TES albedo peaks at zero shift. |
| Water ice (0–1 m, 1–5 m, >5 m) | **SWIM4MIM** combined ice-consistency maps (PSI / NASA JPL), `SWIM4MIM_Ci_0_1`, `_Ci_1_5`, `_Ci_5` ([products page](https://swim.psi.edu/SWIM4MIMProducts.php)) | Consistency of multi-mission datasets (neutron, thermal, geomorphology, SHARAD radar) with buried ice; positive = consistent, negative = inconsistent. Simple cylindrical, 3 km pixels, 60 S–60 N, NoData −30. The page text says "Longitude = 0 - 360E", but the GeoTIFF header says −180…180. | **Longitude convention proven** by correlating each GeoTIFF with SWIM's own browse image (graticule detected automatically): r ≈ 0.78 at zero shift vs ≤ 0.54 at 90/180/270°. The −180…180 header is correct. |
| Landing sites | **PDS ODE "Existing Landing Sites"** ([page](https://ode.rsl.wustl.edu/mars/pagehelp/Content/Missions_Instruments/Landing_Sites.htm)): Viking 1 & 2, Pathfinder, Spirit, Opportunity, Phoenix, Curiosity, with the primary reference cited per site. Perseverance comes from NASA MMGIS (first localized waypoint, sol 13). | Transcribed verbatim in `pipeline/globe_sites.yaml`. MER uses the cartographic-triangulation solution. | — |
| Perseverance traverse + Jezero tile outline | NASA MMGIS `M20_waypoints.json` (layer "M20_waypoints_sol2022_all"); tile bounds from `terrain/jezero/meta.json` | — | — |

**SWIM display mask.** SWIM's GeoTIFFs contain values everywhere from 60 S to 60 N. SWIM's own browse products black out high terrain. We measured this against MOLA: 91–98 % of browse pixels above +1 km elevation are masked, versus ≈ 4 % below +0.5 km. RED ATLAS reproduces that mask (terrain > +1 km) on the ice overlays, and the readout says "masked" there. The threshold was measured by us, not stated by SWIM.

**Derived layer (labelled "derived" in the UI).** Regional slope is computed from MOLA 1/32° topography with true metric spacing (1.85 km baseline). It is regional context only; astronaut-scale slopes come from the 1 m HiRISE DTM.

**Visual aids (not data).** The MOLA hillshade (sun from the NW at 45°), the optional "sun shading" and relief exaggeration (default 1×; the UI warns when it isn't 1×).

### Still to add (must be verified the same way before use)
| Layer | Product | Things to confirm from docs |
|---|---|---|
| Thermal inertia | MGS TES / Odyssey THEMIS | official global grid, units (J m⁻² K⁻¹ s⁻½) |
| Geology | Tanaka et al. 2014, USGS SIM 3292 | unit symbology, vector → raster |
| Minerals (Jezero) | MRO CRISM MTRDR (candidate `FRT00005C5E`) | parameter definitions (Viviano-Beck et al. 2014) |
| Human landing site candidates | NASA Human Landing Sites / Exploration Zones | official coordinates source |
| InSight landing site | — | official NASA/PDS coordinate source |
| Conditions | Mars 2020 MEDA (PDS Atmospheres) | sol, LMST/UTC timestamps, units |

---

## 4b. Climate filters: dust, temperature, wind — ✅ in use (built by `pipeline/build_climate.py`)
Globe scale only. All three cover one Mars year without a global dust storm: Ls 19° of MY30 to Ls 19° of MY31.
The globe's filter list is: elevation, slope, water ice (three SWIM depths under one entry), dust, temperature, wind.

| Filter | Product | Facts checked | What it is |
|---|---|---|---|
| Dust | Montabone et al. kriged daily maps, `dustscenario_MY30_v2-0.nc` (LMD, v2.0) | 669 daily maps, 120 × 60 points at 3°, variables `cdodtot` (total column) and `cdod610` (normalised to 610 Pa), absorption optical depth at 9.3 µm; file title names MRO/MCS and Odyssey/THEMIS | Retrievals from orbit; gaps interpolated by kriging. Shown: annual mean of `cdodtot`. Visible optical depth ≈ 2.6 × this value (per the product page). CC BY-SA 3.0. Cite Montabone et al. (2015), Icarus 251, 65–95 |
| Temperature | OpenMARS MY28–32 standard database (Open University) | HDF5, 72 × 36 points at 5°, 2-hourly, `tsurf` in K; first latitude 87.5° N, first longitude 180° W | **Reanalysis**: MCS temperature and dust retrievals assimilated into a Mars global circulation model. Surface temperature is computed by the model, not measured. Shown: annual mean; readout also gives the coldest and warmest sampled values |
| Wind | same files | `u`, `v` in m/s on 35 sigma levels; lowest level σ = 0.9995 (about 5 m above ground) | **Reanalysis**. Wind has never been measured globally on Mars. Shown: annual mean wind speed on the lowest level; arrows give the mean vector direction |

OpenMARS licence is CC BY-NC-ND 4.0 (no derivatives), so the derived files are **not committed**; each computer
rebuilds them. Cite Holmes, Lewis & Patel (2020), Planet. Space Sci. 188, 104962, doi:10.21954/ou.rd.7352579.v1.

Processing:
- OpenMARS files are 407 MB each but uncompressed, so only the needed slices are fetched by HTTP range request
  (about 5 MB per file, 117 MB in total). Sampling: every third sol, all 12 two-hourly steps (2,676 steps on 223 sols).
- Product values sit on grid points; they are interpolated bilinearly (periodic in longitude) to 1° readout grids and
  to the overlay textures. Values are regional, not local, and the UI says so.

Checks run by the build (it aborts on failure; results join the data-check badge):
- Grid orientation of both products: ln(surface pressure), or ln(`cdodtot`/`cdod610`) for dust, against MOLA
  elevation. r = −0.99 as documented; north–south flipped or longitude-shifted grids give |r| < 0.5.
- Dust is higher in Ls 180–360° than in Ls 0–180° (the known dusty season).
- Surface temperature: global mean 205 K, equator warmer than the poles, extremes within 120–320 K.
- Mean wind speed within 0–30 m/s; sampling covers the whole year; total download under 500 MB.
`pipeline/audit.py` check 12 re-derives the published readouts from the reduced product grids with independent code.

## 5. HRSC–MOLA Blended DEM Global 200 m v2 — ✅ in use ("Land here" sites, elevation)
- **Product:** `Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif`, USGS Astrogeology (Fergason, Hare & Laura 2018). Product page: https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m (FGDC XML at the same URL + `.xml`).
- **Files:** `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/` (`.tif` 11.4 GB, `.lbl`, `_pds3.lbl`, `.tif.aux.xml`, `.lbl.aux.xml`).
- **Verified 2026-11-14 from the labels and the live GeoTIFF header:**
  | Fact | Value | Where |
  |---|---|---|
  | Size, type | 106694 × 53347, SignedWord (int16) LSB, 1 band | ISIS `.lbl`, PDS3 label |
  | Projection | SimpleCylindrical, Mars sphere R = 3,396,190 m, planetocentric, east-positive, −180..180 | ISIS `.lbl` |
  | Pixel | 199.99999 m = 1/296.3735° | ISIS `.lbl`; GeoTIFF transform 0.003374120830641° from (−180, 90), `+proj=longlat +R=3396190` |
  | Layout | uncompressed, one row per strip, core at byte 854273 (1-based) | ISIS `StartByte`, PDS3 `^IMAGE`; GDAL `block_shapes` |
  | NoData | −32768 | `.lbl.aux.xml`, GeoTIFF tag |
  | Range | −8528 .. 21226 m | `.tif.aux.xml` statistics |
  | Inputs | MOLA 463 m + HRSC ~50 m, bilinear, 5 km blend at HRSC edges | FGDC process description |
- **Vertical reference: areoid.** The FGDC `<vertdef>` is empty. The metadata quotes the MOLA areoid error budget (±1.8 m global), and we checked 20 km means at 7 sites against MOLA MEGDR (areoid-relative): |Δ| < 20 m, except the Olympus summit slope. Every site re-checks this (below), and the audit compares one site with the HiRISE 1 m DTM: +7.3 m mean, 14 m rms.
- **Caveat (FGDC):** "areas where the blending of the HRSC on top of MOLA did not always work well."

## 6. CTX global mosaic beta01 (uncontrolled), Caltech Murray Lab — ✅ in use ("Land here" sites, imagery)
- **Service:** NASA Trek WMTS capabilities `https://trek.nasa.gov/tiles/Mars/EQ/CTX_beta01_uncontrolled_5m_Caltech/1.0.0/WMTSCapabilities.xml`. Its `ResourceURL` points to the Esri-hosted tiles `https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{row}/{col}`.
- **Geometry (from the ArcGIS service JSON `?f=json`, used as authoritative):** GCS_Mars_2000_Sphere (R = 3,396,190 m), origin (−180°, 90°), **512 × 512 px tiles**, level z resolution = 0.3515625° / 2^z. Level 12 = 8.583e-5° ≈ 5.09 m/px is the finest; level 13 returns HTTP 400.
  - ⚠ The Trek capabilities list 256 px tiles. The live tiles and the service JSON are 512 px, and we use 512.
- **Description (service):** "preliminary uncontrolled" mosaic, served as "lossy Jpeg compression at an 8 bit data range". Credit: **NASA/JPL/MSSS/The Murray Lab**.
- **Service defects found and handled** (each is reported per site):
  - Regional holes in the level 11–12 cache, e.g. Arcadia 45° N 150° W returns 404 while level 10 has real CTX. The pipeline steps down a level and shows a "lower imagery resolution" warning.
  - Tiles stored truncated on the server: full Content-Length, the PNG stream ends early, and the bytes are identical on every fetch, e.g. around Gale. They are treated as NoData.
  - Tiles with the wrong scene, e.g. 12/2154/7223. These are detected because they disagree with the 4×-coarser overview (good tiles r ≥ 0.77, this one r = −0.22) and are rejected.
  - Gaps are filled from the 4×-coarser level, and the fill fraction is shown.

## Processing for on-demand sites (`build_terrain.py --lat/--lon`, `site_server.py`)
1. The site centre is rounded to 0.01°; tiles are 10/20/40 km square. The same local eqc frame and `meta.json` contract are used as for Jezero, plus `resolution`, `sources` and `validation.checks`.
2. Elevation: parallel HTTP byte-range reads of just the needed samples of each row (layout from the label). The middle row is cross-checked against GDAL's own read. Bilinear interpolation onto a 1024² grid, labelled "200 m resolution, interpolated".
3. Imagery: CTX tiles at the finest level within a 220-tile budget, reprojected (area average) onto ≤ 4096² pixels.
   - **180° meridian:** sites may straddle it. All warps run in longitude relative to the site centre and the readers wrap columns. The DEM file's last column (179.998° E) is NoData padding in places and is interpolated from its two neighbours; positions within one DEM pixel of the seam are exact to < 100 m.
   - **Imagery holes:** filled from coarser CTX levels (down the pyramid). Ground CTX never imaged is shown as shaded relief of the DEM, and the share is reported in the HUD. Imagery gaps no longer fail a site.
4. Checks. These **fail** the build (the site is not opened):
   - documented header/tiling mismatch;
   - DEM NoData;
   - elevation outside the documented range;
   - lat/lon formula ≠ PROJ;
   - heights ≠ source;
   - DEM mean vs MOLA MEGDR over the same footprint > 100 m.

   These **warn** (the site opens, the warning is shown in the HUD):
   - filled or coarser imagery;
   - imagery-to-DEM registration offset > 200 m;
   - registration inconclusive.
5. **Registration check:** for a Lambertian surface, brightness ≈ a·∂z/∂x + b·∂z/∂y + c for any sun direction. Both the image and the DEM slopes are high-passed (> 1 km removed) on a 50 m grid. The ±600 m shift with the best least-squares R² is the measured image offset.
   - Synthetic shifts of +300 m E, +300 m N, and (−200 E, +150 N) are recovered to within one 50 m cell.
   - When R² < 0.05 (flat or smooth terrain), or the peak sits on the search edge, the result is "inconclusive". This happens often, because the DEM is only 200 m.

## Context ring (all 3D views, orientation only)
The context ring is built in the site's own local eqc frame, so it lines up with the site by construction.
- **Extent:** 8 × the site edge, clamped to 64–320 km.
- **Elevation:** the blended DEM, sampled every 200 m × step (step = 1, 3 or 6) onto a 256² grid. Same header checks as the site.
- **Imagery:** CTX at the finest level within 100 tiles, from level 10 (20 m) down to level 6. It steps down where more than 20 % is missing, and holes are filled from the 4× coarser level.
- **Measured agreement with the site tile:** Jezero +7.5 m mean (14 m rms) against HiRISE; Gale −0.1 m (same DEM).
- **In the viewer:** the ring is tucked 3 m under the site tile, so the site always shows on top. Readouts use only the site tile, and the sky colour and haze are visual only.

## Colour in the 3D views ("Mars colour", on by default; visual product)
- **Colour source:** the same USGS Viking colour mosaic (`Mars_Viking_ClrMosaic_global_925m`, 925 m) as the globe base map. It is cut to each site and context frame (`color.jpg` 256², `context_color.jpg` 512²).
- **Audit:** at Jezero the colour pixels equal the GeoTIFF at the same lat/lon (≤ 2 DN, JPEG).
- **Fusion, done in the shader:** rgb = Viking × (image / image averaged over ~925 m). The ~925 m average is the image's own mipmap at lod = log2(925 / pixel size).
  - Colour and large-scale brightness come from Viking, so they match the globe; detail comes from CTX/HiRISE at full resolution.
  - Brightness steps between CTX strips at scales above ~1 km are also evened out.
- **Not measured colour at image resolution.** The Viking mosaic's colour stretch renders dark basaltic regions (e.g. Syrtis/Isidis, around Jezero) blue-grey, exactly as on the globe.
- The HUD toggle switches back to the original grayscale image.

## Processing applied by RED ATLAS (Milestone 1)
1. Read only the tile window from the official GeoTIFFs over HTTP. No data values are modified before resampling.
2. Reproject to a local Equirectangular centred on the tile: `+proj=eqc +lat_ts=18.455 +lat_0=18.455 +lon_0=77.425 +R=3396190`. This makes east-west metres true at the tile latitude. The source uses lat_ts = 0, which stretches E-W distances by 1/cos(18.455°) ≈ 1.054.
3. Area-average downsampling: DTM 1 m → 2 m, ortho 0.25 m → 1 m. Both use the same grid edges, so they align by construction.
4. Validation, which fails the build if not met:
   - No NoData in the tile.
   - Elevations within the documented range.
   - The browser's closed-form lat/lon formulas match PROJ to < 1 mm.
   - Heights at 25 random points agree with the original 1 m DTM (median |Δ| ≤ 0.25 m, 95th percentile ≤ 1 m; the difference comes only from 2 m averaging).
   - The results are written to `meta.json → validation`.

## Filters on a 3D site and station placement (`web/src/siteFilters.ts`)
- **Elevation, slope: local.** Computed in the browser from the site's own elevation grid. Slope = central
  differences over one baseline, and the baseline is never finer than the data (2 m on the Jezero tile, 200 m on
  HRSC–MOLA sites, where rocks, small craters and dunes are not resolved). Elevation colours are stretched to the
  site's own range.
- **Water ice, dust, temperature, wind: regional.** The globe grids (sections 4 and 4b) sampled at each point of the
  site: 0.125° ice cells (about 7 km), 3° dust maps, 5° reanalysis. On a site they are nearly uniform; the UI marks
  them "regional" and they must not be read as local detail.
- **Station placement.** The user picks a point; the station is refused where the local slope exceeds a limit.
  The limit (default 5°) is **our assumption**, adjustable and labelled in the UI, not a NASA value.
  The station model is the team's own file, `web/public/models/station.glb` with settings in `station.json`
  (`scale`, `rotation_y_deg`, `y_offset_m`, `hide` = object names not to draw, `footprint_m`). It is a design by the
  team, not NASA data: habitat MSH-01, airlock, cargo containers, a pressurised rover, a utility rover and a cargo
  transporter, in true metres. Its own ground plane is hidden; the model is tilted to the mean ground plane under its
  footprint. Without the file a stand-in marker is shown.
- Check: `node web/check-site-filters.mjs` compares the painted colours with values recomputed independently
  from `heightmap.bin`, and the regional values with the globe grids at the same latitude and longitude.

## Assumptions (not NASA data; labelled as such in the UI)
- Tile centre and size, chosen by the team (Jezero) or by the user ("Land here": click point rounded to 0.01°, 10/20/40 km).
- Vertical exaggeration (default 1×, true scale; the UI warns when ≠ 1).
- The sky colour and distance haze in the 3D view are visual only (they hide the edge of the context ring).
- Optional relief lighting is a visual aid. The orthoimage already contains the real sun shading from acquisition.

## Local dust, temperature and wind on a 3D site

These three filters vary inside a site. None of them uses random numbers.

| Filter | Input | What it is | What it is not |
|---|---|---|---|
| Dust on the ground | THEMIS night infrared mosaic (Mars Odyssey, ASU / USGS), 100 m, 60° N to 60° S | Loose fines index: fine dust and sand cool fast and are dark at night, rock stays warm. Scaled between the site's 2nd and 98th brightness percentiles. | A dust amount, or dust in the air (that stays the regional Montabone value in the readout). |
| Temperature, day / night | THEMIS day (global) and night infrared mosaics, 100 m | Where the ground is warmer or colder than the rest of the site. | Kelvin: the mosaics are relative brightness. The regional OpenMARS temperature in kelvin stays in the readout. |
| Wind exposure | Site elevation grid + OpenMARS mean wind vector (`wind_u`, `wind_v`) | ESTIMATE: minus the maximum upwind slope (Sx, Winstral et al. 2002) within 1/8 of the site (at least 300 m). Upwind rise = sheltered, upwind drop = exposed. | A measured wind speed. Gusts and slope winds are not modelled. Steadiness (mean vector length / mean speed) is shown; below 0.3 the app warns that the direction varies a lot. |

Files: `ir_night.u8`, `ir_day.u8` per site (256 x 256, row 0 = north, 0 = no data), written by
`pipeline/build_terrain.py` (`add_thermal`; `--thermal-only SITE_DIR` for existing sites). Sites beyond 60° latitude
have no night infrared, so Dust falls back to the regional layer there. Checks: `web/check-site-filters.mjs`.

## Routes from the station to a target

`web/src/routes.ts`. Dijkstra's shortest path on a 160 x 160 cost grid over a window around the station and the
target. Route A is the least-cost path; B to D are the least-cost paths after the corridors already found are made
1.6 times more expensive, kept only when they share under 60 % of their way with earlier routes. All are then
scored with the real cost and sorted. Deterministic; checks in `web/check-routes.mjs`.

Cost per metre = 1 + 6 (slope / limit)^2 + 1.5 ground dust + 1 wind exposure + 0.5 cold ground by day. Cells steeper
than the limit are closed. Inputs are the local site layers above (measured slope, THEMIS dust index and day
infrared, estimated wind exposure).

ASSUMPTIONS (ours, not NASA values, shown as such in the app): the weights; on foot when the target is under 1 km
in a straight line, otherwise by rover; slope limit 20 degrees on foot and 15 degrees by rover; 2 km/h on foot and
8 km/h by rover for the travel time.
