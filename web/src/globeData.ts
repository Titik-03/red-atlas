// Data model + geodesy for the scientific globe (outputs of pipeline/build_globe.py).
//
// Frame: planetocentric latitude, east-positive longitude in [-180, 180].
// Scene mapping (unit sphere, Y = north pole):
//   x = cos(lat) cos(lon),  y = sin(lat),  z = -cos(lat) sin(lon)
// Texture mapping (equirectangular, left edge 180 W, top 90 N):
//   u = (lon + 180) / 360,  v = (lat + 90) / 180   (three.js flipY: v = 1 is the image top)

export interface LayerDef {
  id: string; kind: "base" | "overlay"; name: string; texture: string;
  units?: string; min?: number; max?: number; legend?: string[];
  description: string; mission: string; instrument: string; product: string;
  source: string; url: string; doc: string; derived?: boolean;
  /** What kind of data this is (measured, reanalysis, ...); set by build_climate.py. */
  data_kind?: string;
}
export interface ScalarDef {
  id: string; file: string; scale: number; units: string; label: string; note: string;
  mask_above_elev_m?: number;
  /** Grid size when it differs from meta.grid (the climate grids are 1 degree). */
  width?: number; height?: number;
  /** false = helper grid (wind components), not shown as a readout row. */
  readout?: boolean;
}
export interface Site {
  id: string; name: string; year: number; lat: number; lon: number; lon_e: number;
  mola_elev_m: number; note?: string; source: string; url: string;
}
export interface GlobeMeta {
  frame: { radius_m: number };
  grid: { width: number; height: number; ppd: number; nodata: number };
  layers: LayerDef[]; scalars: ScalarDef[]; sites: Site[];
  jezero_tile: { bounds_deg: { west: number; east: number; south: number; north: number }; name: string };
  m20_traverse: { points: [number, number, number][]; source: string; layer_name: string };
  validation: { ok: boolean; check: string }[];
  generated_utc: string;
  /** Period of the climate layers (dust, temperature, wind); absent when build_climate.py has not been run. */
  climate_period?: string;
}

export const GLOBE_BASE = "/globe";
const DEG = Math.PI / 180;

export function latLonToUnit(lat: number, lon: number): [number, number, number] {
  const p = lat * DEG, l = lon * DEG, c = Math.cos(p);
  return [c * Math.cos(l), Math.sin(p), -c * Math.sin(l)];
}

export function unitToLatLon(x: number, y: number, z: number) {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(y / r) / DEG, lon: Math.atan2(-z, x) / DEG };
}

export class ScalarGrid {
  constructor(public def: ScalarDef, private data: Int16Array, private w: number, private h: number, private nodata: number) {}
  /** Value of the grid cell containing (lat, lon), in physical units; null where no data. */
  at(lat: number, lon: number): number | null {
    const lo = ((((lon + 180) % 360) + 360) % 360);
    const c = Math.min(Math.floor((lo / 360) * this.w), this.w - 1);
    const r = Math.min(Math.max(Math.floor(((90 - lat) / 180) * this.h), 0), this.h - 1);
    const v = this.data[r * this.w + c];
    return v === this.nodata ? null : v / this.def.scale;
  }
  /** Bilinear value for smooth geometry (no-data treated as 0). */
  smooth(lat: number, lon: number): number {
    const fc = ((lon + 180) / 360) * this.w - 0.5, fr = ((90 - lat) / 180) * this.h - 0.5;
    const c0 = Math.floor(fc), r0 = Math.max(0, Math.min(this.h - 2, Math.floor(fr)));
    const tc = fc - c0, tr = Math.max(0, Math.min(1, fr - r0));
    const g = (r: number, c: number) => {
      const v = this.data[r * this.w + ((c % this.w) + this.w) % this.w];
      return v === this.nodata ? 0 : v / this.def.scale;
    };
    return g(r0, c0) * (1 - tc) * (1 - tr) + g(r0, c0 + 1) * tc * (1 - tr)
         + g(r0 + 1, c0) * (1 - tc) * tr + g(r0 + 1, c0 + 1) * tc * tr;
  }
}

let metaCache: Promise<GlobeMeta> | null = null;
const scalarCache = new Map<string, Promise<ScalarGrid>>();

/** Cached: the globe and the surface view share one copy of the metadata and of each readout grid. */
export function loadGlobeMeta(): Promise<GlobeMeta> {
  metaCache ??= fetchGlobeMeta().catch((e) => { metaCache = null; throw e; });
  return metaCache;
}

async function fetchGlobeMeta(): Promise<GlobeMeta> {
  const res = await fetch(`${GLOBE_BASE}/globe.json`);
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<"))
    throw new Error("globe.json not found. Build it first: `.venv/bin/python pipeline/build_globe.py`.");
  const meta: GlobeMeta = JSON.parse(text);
  // Optional climate layers (pipeline/build_climate.py). They are rebuilt per computer, so they may be absent.
  const c = await fetch(`${GLOBE_BASE}/climate.json`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  if (c && !c.trimStart().startsWith("<")) {
    const clim = JSON.parse(c);
    meta.layers.push(...clim.layers);
    meta.scalars.push(...clim.scalars);
    meta.validation.push(...clim.validation);
    meta.climate_period = clim.period;
  }
  return meta;
}

export function loadScalar(meta: GlobeMeta, def: ScalarDef): Promise<ScalarGrid> {
  let p = scalarCache.get(def.id);
  if (!p) {
    p = fetchScalar(meta, def).catch((e) => { scalarCache.delete(def.id); throw e; });
    scalarCache.set(def.id, p);
  }
  return p;
}

async function fetchScalar(meta: GlobeMeta, def: ScalarDef): Promise<ScalarGrid> {
  const res = await fetch(`${GLOBE_BASE}/${def.file}`);
  if (!res.ok) throw new Error(`${def.file}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const w = def.width ?? meta.grid.width, h = def.height ?? meta.grid.height;
  const n = w * h;
  if (buf.byteLength !== n * 2) throw new Error(`${def.file}: ${buf.byteLength} bytes, expected ${n * 2}`);
  const dv = new DataView(buf), out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return new ScalarGrid(def, out, w, h, meta.grid.nodata);
}

export const fmtLat = (v: number) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? "N" : "S"}`;
export const fmtLonE = (v: number) => `${(((v % 360) + 360) % 360).toFixed(3)}° E`;

/** Readout text for one scalar value (shared by the globe and the surface view). */
export function fmtVal(id: string, v: number | null) {
  if (v === null) return "no data";
  if (id === "elev") return `${Math.round(v).toLocaleString("en-US")} m`;
  if (id === "slope") return `${v.toFixed(1)}°`;
  if (id === "albedo" || id === "dust") return v.toFixed(3);
  if (id.startsWith("temp")) return `${v.toFixed(0)} K (${(v - 273.15).toFixed(0)} °C)`;
  if (id === "wind") return `${v.toFixed(1)} m/s`;
  if (v === 0) return "0.00";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)} (${v > 0 ? "consistent" : "inconsistent"} with ice)`;
}
