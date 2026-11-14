// Geodesy + heightmap sampling for a terrain tile produced by pipeline/build_terrain.py.
//
// Local frame (from meta.json "projection"):
//   +proj=eqc +lat_ts=LAT0 +lat_0=LAT0 +lon_0=LON0 +R=R   (Mars 2000 sphere)
//   x = east metres, y = north metres, origin at the tile centre.
// Inverse (closed form, verified against PROJ by the pipeline to < 1 mm):
//   lat = LAT0 + deg(y / R)
//   lon = LON0 + deg(x / (R cos LAT0))
//
// Scene frame (three.js, Y up): X = x (east), Z = -y (north is -Z), Y = (elev - min) * exaggeration.

export interface Credit {
  id: string; title: string; mission: string; instrument: string; doi: string | null; url: string;
}

export interface SourceInfo {
  role: string; id: string; title: string; mission: string; instrument: string;
  doi: string | null; citation?: string | null; info?: string | null; url: string;
}

export interface ValidationCheck { name: string; ok: boolean; level: "pass" | "warn" | "fail"; value: string }

export interface TerrainMeta {
  site: { id: string; name: string; profile?: "global" | "hirise_jezero" };
  body: { name: string; radius_m: number };
  center: { lat: number; lon: number; latitude_type: string; longitude_direction: string };
  projection: string;
  extent_m: { west: number; north: number; east: number; south: number };
  bounds_deg: { west: number; east: number; south: number; north: number };
  heightmap: {
    file: string; width: number; height: number; spacing_m: number;
    units: string; min: number; max: number; vertical_reference: string; resampling: string;
  };
  texture: { file: string; width: number; height: number; pixel_m: number; resampling: string; bands: string };
  products: { dtm: Credit; ortho: Credit };
  resolution?: { dem_native_m: number; image_native_m: number; image_level?: number };
  sources?: SourceInfo[];
  context?: ContextMeta;
  color?: { file: string | null; context_file: string | null; native_m: number; source: string; method: string };
  validation: { status?: "pass" | "warn"; checks?: ValidationCheck[] } & Record<string, unknown>;
  generated_utc: string;
}

export interface ContextMeta {
  heightmap: { file: string; width: number; height: number; spacing_m: number; min: number; max: number };
  texture: { file: string; width: number; height: number; pixel_m: number };
  extent_m: { west: number; north: number; east: number; south: number };
  dem_sample_m: number; image_native_m: number; image_level: number; note: string;
}

export interface Terrain {
  meta: TerrainMeta;
  context?: Float32Array; // low-res surroundings (meta.context), same local frame, row 0 = north
  heights: Float32Array; // row-major, row 0 = north, values in metres at cell centres
}

const DEG = 180 / Math.PI;

export function localToLatLon(meta: TerrainMeta, x: number, y: number) {
  const R = meta.body.radius_m;
  const lat0 = meta.center.lat, lon0 = meta.center.lon;
  return {
    lat: lat0 + (y / R) * DEG,
    // wrapped to [-180, 180): a site may straddle the 180 deg meridian
    lon: ((lon0 + (x / (R * Math.cos(lat0 / DEG))) * DEG + 540) % 360) - 180,
  };
}

/** Great-circle distance on the Mars sphere (metres). */
export function greatCircle(R: number, lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 / DEG, p2 = lat2 / DEG, dp = p2 - p1, dl = (lon2 - lon1) / DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** True elevation (metres, product datum) at local x/y by bilinear interpolation; null outside the grid. */
export function sampleElevation(t: Terrain, x: number, y: number): number | null {
  const { width: W, height: H, spacing_m: d } = t.meta.heightmap;
  const c = (x - t.meta.extent_m.west) / d - 0.5;
  const r = (t.meta.extent_m.north - y) / d - 0.5;
  if (c < 0 || r < 0 || c > W - 1 || r > H - 1) return null;
  const c0 = Math.min(Math.floor(c), W - 2), r0 = Math.min(Math.floor(r), H - 2);
  const fc = c - c0, fr = r - r0, h = t.heights, i = r0 * W + c0;
  return h[i] * (1 - fc) * (1 - fr) + h[i + 1] * fc * (1 - fr)
       + h[i + W] * (1 - fc) * fr + h[i + W + 1] * fc * fr;
}

/**
 * Intersect a scene-space ray with the heightfield by marching + bisection.
 * Returns local metres (x east, y north) and the true elevation, or null on miss.
 */
export function pickHeightfield(
  t: Terrain, exaggeration: number,
  origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number },
) {
  const min = t.meta.heightmap.min;
  const sceneY = (lx: number, ly: number) => {
    const e = sampleElevation(t, lx, ly);
    return e === null ? null : (e - min) * exaggeration;
  };
  const step = t.meta.heightmap.spacing_m * 0.5;
  const maxDist = 40000;
  let prevS = 0;
  for (let s = 0; s < maxDist; s += step) {
    const px = origin.x + dir.x * s, py = origin.y + dir.y * s, pz = origin.z + dir.z * s;
    const g = sceneY(px, -pz);
    if (g !== null && py <= g) {
      let lo = prevS, hi = s; // bisection for sub-step precision
      for (let k = 0; k < 20; k++) {
        const m = (lo + hi) / 2;
        const mx = origin.x + dir.x * m, my = origin.y + dir.y * m, mz = origin.z + dir.z * m;
        const gm = sceneY(mx, -mz);
        if (gm !== null && my <= gm) hi = m; else lo = m;
      }
      const x = origin.x + dir.x * hi, y = -(origin.z + dir.z * hi);
      const elev = sampleElevation(t, x, y);
      return elev === null ? null : { x, y, elev };
    }
    prevS = s;
    // Stop early once the ray is below the lowest terrain and heading down.
    if (py < 0 && dir.y <= 0) break;
  }
  return null;
}

export async function loadTerrain(base: string, onProgress?: (f: number) => void): Promise<Terrain> {
  const metaRes = await fetch(`${base}/meta.json`);
  const metaText = await metaRes.text();
  if (!metaRes.ok || metaText.trimStart().startsWith("<")) {
    throw new Error(
      `${base}/meta.json not found. Build the terrain first: ` +
      "`.venv/bin/python pipeline/build_terrain.py` (from the project root), then reload.");
  }
  const meta: TerrainMeta = JSON.parse(metaText);
  const res = await fetch(`${base}/${meta.heightmap.file}`);
  if (!res.ok || !res.body) throw new Error(`heightmap fetch failed: ${res.status}`);
  const total = meta.heightmap.width * meta.heightmap.height * 4;
  const buf = new Uint8Array(total);
  const reader = res.body.getReader();
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, off);
    off += value.length;
    onProgress?.(off / total);
  }
  if (off !== total) throw new Error(`heightmap size ${off} != expected ${total}`);
  // File is little-endian Float32; decode explicitly so big-endian hosts are also correct.
  const dv = new DataView(buf.buffer);
  const heights = new Float32Array(total / 4);
  for (let i = 0; i < heights.length; i++) heights[i] = dv.getFloat32(i * 4, true);
  // Optional low-res surroundings; a missing/broken context never blocks the site.
  let context: Float32Array | undefined;
  if (meta.context) {
    const c = meta.context.heightmap;
    const r = await fetch(`${base}/${c.file}`).catch(() => null);
    const ab = r && r.ok ? await r.arrayBuffer() : null;
    if (ab && ab.byteLength === c.width * c.height * 4) {
      const cv = new DataView(ab);
      context = new Float32Array(c.width * c.height);
      for (let i = 0; i < context.length; i++) context[i] = cv.getFloat32(i * 4, true);
    }
  }
  return { meta, heights, context };
}
