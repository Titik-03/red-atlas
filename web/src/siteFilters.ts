// The six globe filters projected onto a 3D surface site.
//
// LOCAL layers vary inside the site and come from data at the site's own scale:
//   elevation, slope    the site's elevation grid
//   dust (ground)       THEMIS night infrared, 100 m: fine dust and sand cool fast and are dark at night,
//                       rock and bedrock stay warm and are bright (relative, not a dust amount)
//   temperature         THEMIS day / night infrared, 100 m: where the ground is warmer or colder than its
//                       surroundings (relative brightness, not kelvin)
//   wind                ESTIMATE: shelter or exposure of each point to the regional mean wind, computed from the
//                       site's measured terrain (maximum upwind slope, the "Sx" parameter of Winstral et al. 2002)
// REGIONAL layers are the globe grids sampled over the site (water ice; and dust, temperature, wind when the
// local inputs are missing). Nothing here is random, and nothing invents detail the inputs do not have.
import { localToLatLon, sampleElevation, type Terrain } from "./geo";
import type { GlobeMeta, LayerDef, ScalarGrid } from "./globeData";

export const SITE_FILTERS = [
  { id: "elev", name: "Elevation" }, { id: "slope", name: "Slope" }, { id: "ice", name: "Water ice" },
  { id: "dust", name: "Dust" }, { id: "temp", name: "Temperature" }, { id: "wind", name: "Wind" },
  { id: "walk", name: "Can we walk home?" },
] as const;
export const ICE_DEPTHS: [string, string][] = [["ice_0_1", "0–1 m"], ["ice_1_5", "1–5 m"], ["ice_5", "> 5 m"]];

export interface SiteLayer {
  id: string; name: string; units: string; min: number; max: number; legend: string[];
  /** Labels for the two ends of the legend when the scale is relative (no physical unit). */
  ends?: [string, string];
  /** Named classes instead of a continuous scale: [colour, label]. */
  classes?: [string, string][];
  /** local = varies inside the site; regional = globe data sampled over the site. */
  local: boolean; kind: string; note: string;
}
export interface Globe { meta: GlobeMeta; scalars: Record<string, ScalarGrid> }
export interface SiteOpts { tempMode: "day" | "night" }

/** Baseline for slopes: never finer than the elevation data really is (200 m on HRSC-MOLA sites). */
export function slopeBaseline(t: Terrain) {
  return Math.max(t.meta.resolution?.dem_native_m ?? t.meta.heightmap.spacing_m, t.meta.heightmap.spacing_m);
}

/** Slope in degrees at local x/y: central differences of the elevation over one baseline; null at the edge. */
export function siteSlope(t: Terrain, x: number, y: number, baseline = slopeBaseline(t)): number | null {
  const h = baseline / 2;
  const e = sampleElevation(t, x + h, y), w = sampleElevation(t, x - h, y);
  const n = sampleElevation(t, x, y + h), s = sampleElevation(t, x, y - h);
  if (e === null || w === null || n === null || s === null) return null;
  return (Math.atan(Math.hypot((e - w) / baseline, (n - s) / baseline)) * 180) / Math.PI;
}

/** Regional value of a globe grid at a site point. Climate grids are smooth (bilinear); ice keeps its cells. */
export function regional(t: Terrain, g: ScalarGrid, x: number, y: number): number | null {
  const { lat, lon } = localToLatLon(t.meta, x, y);
  return g.def.id.startsWith("ice") ? g.at(lat, lon) : g.smooth(lat, lon);
}

/** THEMIS infrared brightness at a site point, 0..1 between the site's 2nd and 98th percentiles; null = no data. */
export function infrared(t: Terrain, band: "night" | "day", x: number, y: number): number | null {
  const d = t.thermal?.[band], m = t.meta.thermal, b = m?.[band];
  if (!d || !m || !b) return null;
  const { west, east, south, north } = t.meta.extent_m, n = m.size;
  const c = ((x - west) / (east - west)) * n - 0.5, r = ((north - y) / (north - south)) * n - 0.5;
  if (c < -0.5 || r < -0.5 || c > n - 0.5 || r > n - 0.5) return null;
  const c0 = Math.min(n - 2, Math.max(0, Math.floor(c))), r0 = Math.min(n - 2, Math.max(0, Math.floor(r)));
  const fc = Math.min(1, Math.max(0, c - c0)), fr = Math.min(1, Math.max(0, r - r0));
  const v = [d[r0 * n + c0], d[r0 * n + c0 + 1], d[(r0 + 1) * n + c0], d[(r0 + 1) * n + c0 + 1]];
  if (v.some((q) => q === 0)) return null;
  const dn = v[0] * (1 - fc) * (1 - fr) + v[1] * fc * (1 - fr) + v[2] * (1 - fc) * fr + v[3] * fc * fr;
  return Math.min(1, Math.max(0, (dn - b.dn_p2) / Math.max(1, b.dn_p98 - b.dn_p2)));
}

/** Ground dust and fines index, 0 (rock, warm at night) .. 1 (fine dust or sand, cold at night). */
export const groundFines = (t: Terrain, x: number, y: number) => {
  const v = infrared(t, "night", x, y);
  return v === null ? null : 1 - v;
};

export interface RegionalWind { u: number; v: number; speed: number; fromDeg: number; steadiness: number }
/** Regional mean wind at the site centre (reanalysis): vector, speed, the direction it blows FROM, steadiness. */
export function regionalWind(t: Terrain, globe: Globe | null): RegionalWind | null {
  const gu = globe?.scalars.wind_u, gv = globe?.scalars.wind_v, gs = globe?.scalars.wind;
  if (!gu || !gv || !gs) return null;
  const { lat, lon } = t.meta.center;
  const u = gu.smooth(lat, lon), v = gv.smooth(lat, lon), speed = gs.smooth(lat, lon);
  const mag = Math.hypot(u, v);
  if (mag < 0.05) return null;
  return { u, v, speed, fromDeg: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360, steadiness: Math.min(1, mag / Math.max(speed, 1e-6)) };
}

/** Search distance for upwind shelter: an eighth of the site, at least 300 m. */
export const shelterDistance = (t: Terrain) => Math.max(300, (t.meta.extent_m.east - t.meta.extent_m.west) / 8);

/**
 * Wind exposure at a point, in degrees: minus the maximum upwind slope (Sx). Terrain rising upwind shelters the
 * point (negative); terrain falling away upwind leaves it exposed (positive). Deterministic, from measured terrain
 * and the reanalysis wind direction. It is an estimate of shelter, not a measured wind speed.
 */
export function windExposure(t: Terrain, w: RegionalWind, x: number, y: number, dmax = shelterDistance(t)): number | null {
  const z0 = sampleElevation(t, x, y);
  if (z0 === null) return null;
  const step = Math.max(slopeBaseline(t) / 2, dmax / 32), mag = Math.hypot(w.u, w.v);
  const ux = -w.u / mag, uy = -w.v / mag;            // unit vector pointing upwind
  let sx = -Infinity;
  for (let d = step; d <= dmax + 1e-6; d += step) {
    const z = sampleElevation(t, x + ux * d, y + uy * d);
    if (z === null) break;
    sx = Math.max(sx, Math.atan((z - z0) / d));
  }
  return sx === -Infinity ? null : (-sx * 180) / Math.PI;
}

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
function ramp(stops: string[]) {
  const rgb = stops.map(hex);
  return (f: number) => {
    const p = Math.min(1, Math.max(0, f)) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(p)), k = p - i;
    return [0, 1, 2].map((c) => rgb[i][c] * (1 - k) + rgb[i + 1][c] * k);
  };
}
const nice = (v: number, step: number, up: boolean) => (up ? Math.ceil(v / step) : Math.floor(v / step)) * step;
const compass = (deg: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(deg / 45) % 8];

/**
 * Colour texture (RGBA, n x n, row 0 = SOUTH edge so it matches the terrain UVs without flipping) and legend for
 * one filter. `id`: "elev", "slope", "dust", "temp", "wind" or a globe ice id ("ice_0_1", ...).
 */
export function buildSiteLayer(t: Terrain, id: string, globe: Globe | null, opts: SiteOpts = { tempMode: "night" }):
    { layer: SiteLayer; rgba: Uint8ClampedArray; size: number } | null {
  const { west, east, south, north } = t.meta.extent_m;
  const def = (lid: string) => globe?.meta.layers.find((l) => l.id === lid) as LayerDef | undefined;
  const fallback = ["#011959", "#1c5460", "#5a7244", "#b08a37", "#f6a57c", "#faccfa"];
  const at = (i: number, n: number, a: number, b: number) => a + ((i + 0.5) / n) * (b - a);
  const paint = (size: number, value: (x: number, y: number) => number | null, min: number, max: number, stops: string[]) => {
    const rgba = new Uint8ClampedArray(size * size * 4), col = ramp(stops);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const v = value(at(c, size, west, east), at(r, size, south, north)), o = (r * size + c) * 4;
      if (v === null) continue;                        // transparent: no data
      const [R, G, B] = col((v - min) / (max - min));
      rgba[o] = R; rgba[o + 1] = G; rgba[o + 2] = B; rgba[o + 3] = 255;
    }
    return rgba;
  };

  if (id === "elev") {
    const span = t.meta.heightmap.max - t.meta.heightmap.min;
    const step = span > 2000 ? 500 : span > 400 ? 100 : span > 80 ? 20 : 5;
    const min = nice(t.meta.heightmap.min, step, false), max = nice(t.meta.heightmap.max, step, true);
    const legend = def("mola")?.legend ?? fallback;
    return { size: 512, rgba: paint(512, (x, y) => sampleElevation(t, x, y), min, max, legend),
      layer: { id, name: "Elevation", units: "m", min, max, legend, local: true,
        kind: t.meta.site.profile === "global" ? "Measured (laser altimeter and stereo images)" : "Measured (stereo images)",
        note: "From this site's elevation grid. Colours are stretched to the site's own range, not the globe's." } };
  }
  if (id === "slope") {
    const b = slopeBaseline(t), max = b >= 100 ? 15 : 30, legend = def("slope")?.legend ?? fallback;
    return { size: 512, rgba: paint(512, (x, y) => siteSlope(t, x, y, b), 0, max, legend),
      layer: { id, name: "Slope", units: "deg", min: 0, max, legend, local: true, kind: "Derived from the measured elevation",
        note: `Computed from this site's elevation grid over a ${b >= 10 ? b.toFixed(0) : b} m baseline`
          + (b >= 100 ? "; rocks, small craters and dunes are below that resolution." : ".") } };
  }
  if (id === "dust" && t.thermal?.night) {
    const legend = def("dust")?.legend ?? fallback;
    return { size: 256, rgba: paint(256, (x, y) => groundFines(t, x, y), 0, 1, legend),
      layer: { id, name: "Dust on the ground", units: "", min: 0, max: 1, legend, ends: ["rock", "fine dust, sand"], local: true,
        kind: "Measured from orbit (relative)",
        note: "THEMIS night infrared (a heat picture of the ground), 100 m. Fine dust and sand cool fast and are dark at night; rock stays warm. "
          + "The scale runs between this site's darkest and brightest ground. It indicates loose fines, not a dust amount, "
          + "and is separate from the dust in the air (a regional value in the readout)." } };
  }
  if (id === "temp" && t.thermal?.[opts.tempMode]) {
    const legend = def("temp")?.legend ?? fallback, m = opts.tempMode;
    return { size: 256, rgba: paint(256, (x, y) => infrared(t, m, x, y), 0, 1, legend),
      layer: { id, name: m === "day" ? "Daytime ground temperature" : "Night ground temperature", units: "", min: 0, max: 1, legend,
        ends: ["colder", "warmer"], local: true, kind: "Measured from orbit (relative)",
        note: `THEMIS ${m} infrared (a heat picture of the ground), 100 m: where the ground is ${m === "day" ? "warmer in daylight (sunlit slopes, dark ground)" : "warmer at night (rock) or colder (dust, sand)"}. `
          + "Relative to this site only; the mosaic is not calibrated in kelvin. The regional temperature in kelvin is in the readout." } };
  }
  if (id === "wind") {
    const w = regionalWind(t, globe);
    if (w) {
      const dmax = shelterDistance(t), size = 192;
      const vals = new Float32Array(size * size).fill(NaN);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        const v = windExposure(t, w, at(c, size, west, east), at(r, size, south, north), dmax);
        if (v !== null) vals[r * size + c] = v;
      }
      const abs = Array.from(vals).filter((v) => !Number.isNaN(v)).map(Math.abs).sort((a, b) => a - b);
      const lim = Math.max(2, Math.ceil(abs[Math.floor(abs.length * 0.98)] ?? 2));
      const legend = def("wind")?.legend ?? fallback, col = ramp(legend), rgba = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < vals.length; i++) {
        if (Number.isNaN(vals[i])) continue;
        const [R, G, B] = col((vals[i] + lim) / (2 * lim));
        rgba[i * 4] = R; rgba[i * 4 + 1] = G; rgba[i * 4 + 2] = B; rgba[i * 4 + 3] = 255;
      }
      return { size, rgba, layer: { id, name: "Wind exposure", units: "deg", min: -lim, max: lim, legend, ends: ["sheltered", "exposed"],
        local: true, kind: "Estimate from measured terrain and weather model wind",
        note: `How open each point is to the regional mean wind, which blows from the ${compass(w.fromDeg)} (${w.fromDeg.toFixed(0)}°) at ${w.speed.toFixed(1)} m/s `
          + `on average (weather model; steadiness ${w.steadiness.toFixed(2)} of 1). Value = minus the steepest upwind rise within ${dmax.toFixed(0)} m `
          + "(maximum upwind slope, Winstral et al. 2002). Terrain shelter only: not a measured wind, and gusts or slope winds are not modelled."
          + (w.steadiness < 0.3 ? " The wind direction changes a lot here over the day and year, so treat this map as a weak guide." : "") } };
    }
  }
  // Regional fallback (and water ice): the globe grid sampled over the site.
  const gid = id, g = globe?.scalars[gid], l = def(gid);
  if (!g || !l || l.min === undefined || l.max === undefined || !l.legend) return null;
  const kind = l.data_kind ?? (id.startsWith("ice") ? "Analysis combining several instruments" : "");
  const cell = id.startsWith("ice") ? "0.125° cells (about 7 km)" : id === "dust" ? "3° maps (about 180 km)" : "a 5° weather model (about 300 km)";
  return { size: 128, rgba: paint(128, (x, y) => regional(t, g, x, y), l.min, l.max, l.legend),
    layer: { id, name: l.name, units: l.units ?? "", min: l.min, max: l.max, legend: l.legend, local: false, kind,
      note: `Regional value from ${cell}, the same data as on the globe. It does not show detail inside this site.` } };
}
