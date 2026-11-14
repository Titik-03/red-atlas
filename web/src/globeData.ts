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
}
export interface ScalarDef {
  id: string; file: string; scale: number; units: string; label: string; note: string;
  mask_above_elev_m?: number;
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
  /** Value of the 0.125-degree cell containing (lat, lon), in physical units; null where no data. */
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

export async function loadGlobeMeta(): Promise<GlobeMeta> {
  const res = await fetch(`${GLOBE_BASE}/globe.json`);
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<"))
    throw new Error("globe.json not found. Build it first: `.venv/bin/python pipeline/build_globe.py`.");
  return JSON.parse(text);
}

export async function loadScalar(meta: GlobeMeta, def: ScalarDef): Promise<ScalarGrid> {
  const res = await fetch(`${GLOBE_BASE}/${def.file}`);
  if (!res.ok) throw new Error(`${def.file}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const n = meta.grid.width * meta.grid.height;
  if (buf.byteLength !== n * 2) throw new Error(`${def.file}: ${buf.byteLength} bytes, expected ${n * 2}`);
  const dv = new DataView(buf), out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return new ScalarGrid(def, out, meta.grid.width, meta.grid.height, meta.grid.nodata);
}

export const fmtLat = (v: number) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? "N" : "S"}`;
export const fmtLonE = (v: number) => `${(((v % 360) + 360) % 360).toFixed(3)}° E`;
