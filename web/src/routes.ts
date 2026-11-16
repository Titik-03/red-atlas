// Routes from the station to a research target: Dijkstra's shortest path on a cost grid built from the site layers.
//
// Inputs per grid cell (all from siteFilters.ts, nothing random):
//   slope      measured terrain (the steepest of five samples in the cell)           most important
//   dust       ground fines index from THEMIS night infrared (0 rock .. 1 fines)
//   wind       positive part of the wind exposure estimate (0 sheltered .. 1 exposed at 10 degrees or more)
//   cold       1 - daytime infrared brightness (0 warmest ground of the site .. 1 coldest)
// ASSUMPTIONS (ours, not NASA values; shown as such in the app): the weights, the slope limits, the travel speeds
// and the 1 km walking range below.
import { sampleElevation, type Terrain } from "./geo";
import { groundFines, infrared, siteSlope, slopeBaseline, windExposure, type RegionalWind } from "./siteFilters";

/** Straight-line distance under which the crew walks; beyond it they drive. */
export const FOOT_RANGE_M = 1000;
export const TRAVEL = {
  foot: { label: "On foot", maxSlopeDeg: 20, speedKmh: 2 },
  rover: { label: "Rover", maxSlopeDeg: 15, speedKmh: 8 },
} as const;
export type Mode = keyof typeof TRAVEL;
/** Speed on a slope, m/s. ASSUMPTION: full speed on flat ground, falling in a straight line to half speed at the slope limit. */
export const speedAt = (mode: Mode, slopeDeg: number) =>
  (TRAVEL[mode].speedKmh / 3.6) * (1 - 0.5 * Math.min(1, Math.max(0, slopeDeg) / TRAVEL[mode].maxSlopeDeg));
/** Cost of one metre = 1 + slope * (slope / limit)^2 + dust * fines + wind * exposure + cold * coldness. */
export const WEIGHTS = { slope: 6, dust: 1.5, wind: 1, cold: 0.5 };
export const GRID_N = 160;
const WANTED = 4, SPREAD_CELLS = 5, PENALTY = 1.6, MAX_OVERLAP = 0.6;

export interface CostGrid {
  n: number; west: number; south: number; cellX: number; cellY: number;
  slope: Float32Array; fines: Float32Array; expo: Float32Array; cold: Float32Array;   // row 0 = south; slope NaN = unknown
  has: { dust: boolean; wind: boolean; cold: boolean };
}
export interface Route {
  points: [number, number, number][];   // local x, y (metres) and elevation, station first
  lengthM: number; climbM: number; maxSlopeDeg: number; meanSlopeDeg: number;
  dust: number | null; wind: number | null;     // length-weighted means, 0..1
  minutes: number; score: number; cost: number; // score = mean cost per metre (1 = flat, firm, sheltered ground)
  /** Values at every point of the route: distance from the station (m, along the ground), slope (deg), dust and wind (0..1). */
  profile: { d: number[]; slope: number[]; dust: number[]; wind: number[] };
}
export interface Trip { mode: Mode; straightM: number; routes: Route[]; error: string | null; has: CostGrid["has"]; cellM: number }
export interface XY { x: number; y: number }

/** Cost inputs on a GRID_N x GRID_N grid over a window around the two end points (clipped to the site). */
export function buildCostGrid(t: Terrain, wind: RegionalWind | null, a: XY, b: XY, n = GRID_N): CostGrid {
  const e = t.meta.extent_m, d = Math.hypot(b.x - a.x, b.y - a.y), pad = Math.max(d * 0.75, 300);
  const half = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 2 + pad, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const west = Math.max(e.west, cx - half), east = Math.min(e.east, cx + half);
  const south = Math.max(e.south, cy - half), north = Math.min(e.north, cy + half);
  const cellX = (east - west) / n, cellY = (north - south) / n, q = Math.min(cellX, cellY) / 4;
  const base = Math.max(slopeBaseline(t), Math.min(cellX, cellY) / 2);
  const g: CostGrid = { n, west, south, cellX, cellY, slope: new Float32Array(n * n), fines: new Float32Array(n * n),
    expo: new Float32Array(n * n), cold: new Float32Array(n * n), has: { dust: !!t.thermal?.night, wind: !!wind, cold: !!t.thermal?.day } };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const x = west + (c + 0.5) * cellX, y = south + (r + 0.5) * cellY, i = r * n + c;
    let s = -1;
    for (const [dx, dy] of [[0, 0], [q, q], [-q, q], [q, -q], [-q, -q]]) {
      const v = siteSlope(t, x + dx, y + dy, base);
      if (v === null) { s = NaN; break; }
      s = Math.max(s, v);
    }
    g.slope[i] = s;
    g.fines[i] = groundFines(t, x, y) ?? 0;
    const day = infrared(t, "day", x, y);
    g.cold[i] = day === null ? 0 : 1 - day;
    const ex = wind ? windExposure(t, wind, x, y) : null;
    g.expo[i] = ex === null ? 0 : Math.min(1, Math.max(0, ex / 10));
  }
  return g;
}

/** Cost per metre of every cell for a travel mode; Infinity where the slope is over the limit or unknown. */
export function cellCosts(g: CostGrid, mode: Mode, slopeBoost = 0): Float32Array {
  const lim = TRAVEL[mode].maxSlopeDeg, out = new Float32Array(g.n * g.n);
  for (let i = 0; i < out.length; i++) {
    const s = g.slope[i];
    out[i] = !(s <= lim) ? Infinity
      : 1 + WEIGHTS.slope * (1 + slopeBoost) * (s / lim) ** 2 + WEIGHTS.dust * g.fines[i] + WEIGHTS.wind * g.expo[i] + WEIGHTS.cold * g.cold[i];
  }
  return out;
}

/**
 * Dijkstra on the 8-connected grid from one or several source cells. Edge cost = length x mean cost of its two
 * cells; no cutting past blocked corners. Stops early at `dst` when given; otherwise fills the whole grid.
 */
export function dijkstraField(cost: Float32Array, g: CostGrid, sources: number[], dst = -1): { dist: Float64Array; prev: Int32Array } {
  const n = g.n, N = n * n, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap: number[] = [], key: number[] = [];                    // binary min-heap of (key, cell)
  const push = (k: number, v: number) => {
    let i = heap.length; heap.push(v); key.push(k);
    while (i > 0) { const p = (i - 1) >> 1; if (key[p] <= k) break; heap[i] = heap[p]; key[i] = key[p]; i = p; }
    heap[i] = v; key[i] = k;
  };
  const pop = () => {
    const top = heap[0], v = heap.pop()!, k = key.pop()!, len = heap.length;
    if (len) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= len) break;
        if (c + 1 < len && key[c + 1] < key[c]) c++;
        if (key[c] >= k) break;
        heap[i] = heap[c]; key[i] = key[c]; i = c;
      }
      heap[i] = v; key[i] = k;
    }
    return top;
  };
  const diag = Math.hypot(g.cellX, g.cellY);
  for (const s of sources) { dist[s] = 0; push(0, s); }
  while (heap.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === dst) break;
    const ur = (u / n) | 0, uc = u - ur * n;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = ur + dr, c = uc + dc;
      if (r < 0 || c < 0 || r >= n || c >= n) continue;
      const v = r * n + c;
      if (done[v] || cost[v] === Infinity) continue;
      if (dr && dc && (cost[ur * n + c] === Infinity || cost[r * n + uc] === Infinity)) continue;
      const nd = dist[u] + (dr && dc ? diag : dr ? g.cellY : g.cellX) * (cost[u] + cost[v]) / 2;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
    }
  }
  return { dist, prev };
}

/** Least-cost path between two cells, or null when there is none. */
export function dijkstra(cost: Float32Array, g: CostGrid, src: number, dst: number): number[] | null {
  const { dist, prev } = dijkstraField(cost, g, [src], dst);
  if (dist[dst] === Infinity) return null;
  const path: number[] = [];
  for (let v = dst; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

export const cellOf = (g: CostGrid, p: XY) => {
  const c = Math.min(g.n - 1, Math.max(0, Math.floor((p.x - g.west) / g.cellX)));
  const r = Math.min(g.n - 1, Math.max(0, Math.floor((p.y - g.south) / g.cellY)));
  return r * g.n + c;
};

function dilate(g: CostGrid, path: number[], radius: number, visit: (i: number) => void) {
  const n = g.n, seen = new Uint8Array(n * n);
  for (const p of path) {
    const pr = (p / n) | 0, pc = p - pr * n;
    for (let r = Math.max(0, pr - radius); r <= Math.min(n - 1, pr + radius); r++)
      for (let c = Math.max(0, pc - radius); c <= Math.min(n - 1, pc + radius); c++) {
        const i = r * n + c;
        if (!seen[i]) { seen[i] = 1; visit(i); }
      }
  }
  return seen;
}

export function measure(t: Terrain, g: CostGrid, cost: Float32Array, path: number[], a: XY, b: XY, mode: Mode): Route {
  const n = g.n, pts: [number, number, number][] = path.map((i, k) => {
    const r = (i / n) | 0, c = i - r * n;
    const p = k === 0 ? a : k === path.length - 1 ? b : { x: g.west + (c + 0.5) * g.cellX, y: g.south + (r + 0.5) * g.cellY };
    return [p.x, p.y, sampleElevation(t, p.x, p.y) ?? 0];
  });
  let len = 0, flat = 0, climb = 0, total = 0, sl = 0, du = 0, wi = 0, maxS = 0, secs = 0;
  const profile = { d: [0], slope: path.map((i) => g.slope[i]), dust: path.map((i) => g.fines[i]), wind: path.map((i) => g.expo[i]) };
  for (let k = 1; k < pts.length; k++) {
    const h = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]), dz = pts[k][2] - pts[k - 1][2];
    const i = path[k], j = path[k - 1], mid = (x: Float32Array) => (x[i] + x[j]) / 2;
    len += Math.hypot(h, dz); flat += h; climb += Math.max(0, dz); secs += Math.hypot(h, dz) / speedAt(mode, mid(g.slope));
    total += h * mid(cost); sl += h * mid(g.slope); du += h * mid(g.fines); wi += h * mid(g.expo);
    maxS = Math.max(maxS, g.slope[i], g.slope[j]);
    profile.d.push(flat);
  }
  flat = Math.max(flat, 1e-9);
  return { profile, points: pts, lengthM: len, climbM: climb, maxSlopeDeg: maxS, meanSlopeDeg: sl / flat,
    dust: g.has.dust ? du / flat : null, wind: g.has.wind ? wi / flat : null,
    minutes: secs / 60, score: total / flat, cost: total };
}

/** What earlier trips change in a plan (see report.ts): safer known ground, riskier trouble spots, heavier slopes. */
export interface RouteLessons { known: [number, number][]; trouble: [number, number][]; slopeBoost: number; knownFactor: number; troubleFactor: number }
function applyLessons(g: CostGrid, cost: Float32Array, l: RouteLessons) {
  const inside = (x: number, y: number) => x >= g.west && y >= g.south && x < g.west + g.n * g.cellX && y < g.south + g.n * g.cellY;
  const k = new Set<number>(), bad = new Set<number>();
  for (const [x, y] of l.known) if (inside(x, y)) k.add(cellOf(g, { x, y }));
  for (const [x, y] of l.trouble) if (inside(x, y)) {
    const c = cellOf(g, { x, y }), r = (c / g.n) | 0, col = c - r * g.n;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (r + dr >= 0 && r + dr < g.n && col + dc >= 0 && col + dc < g.n) bad.add((r + dr) * g.n + col + dc);
  }
  for (const c of k) if (!bad.has(c)) cost[c] *= l.knownFactor;
  for (const c of bad) cost[c] *= l.troubleFactor;
}

/**
 * Up to four different routes from the station to the target, best first. The mode (foot or rover) follows from the
 * straight distance between the station and the target; `starts` gives where each mode really sets off from.
 * The first is the true least-cost path (Dijkstra). Each further one is the least-cost path after the corridor of
 * the routes already found has been made more expensive, kept only if it shares under 60 % of its way with every
 * earlier route. All routes are then scored with the real, unpenalised cost and sorted.
 */
export function planRoutes(t: Terrain, wind: RegionalWind | null, station: XY, to: XY, starts?: Record<Mode, XY>,
    blocked: (XY & { r: number })[] = [], lessons?: RouteLessons): Trip {
  const straightM = Math.hypot(to.x - station.x, to.y - station.y), mode: Mode = straightM < FOOT_RANGE_M ? "foot" : "rover";
  const from = starts?.[mode] ?? station;     // the airlock door on foot, the parked rover when driving
  const g = buildCostGrid(t, wind, from, to), cost = cellCosts(g, mode, lessons?.slopeBoost ?? 0), src = cellOf(g, from), dst = cellOf(g, to);
  if (lessons) applyLessons(g, cost, lessons);
  const trip: Trip = { mode, straightM, routes: [], error: null, has: g.has, cellM: Math.max(g.cellX, g.cellY) };
  // Station buildings and parked vehicles are closed ground (except the one the trip starts from).
  const walls = blocked.filter((b) => Math.hypot(from.x - b.x, from.y - b.y) > b.r);
  if (walls.some((b) => Math.hypot(to.x - b.x, to.y - b.y) <= b.r)) return { ...trip, error: "The target is inside the station area." };
  if (walls.length) for (let i = 0; i < cost.length; i++) {
    const x = g.west + ((i % g.n) + 0.5) * g.cellX, y = g.south + (Math.floor(i / g.n) + 0.5) * g.cellY;
    if (i !== src && walls.some((b) => Math.hypot(x - b.x, y - b.y) <= b.r)) cost[i] = Infinity;
  }
  if (src === dst) return { ...trip, error: "The target is right at the station." };
  if (cost[dst] === Infinity) return { ...trip, error: Number.isNaN(g.slope[dst])
    ? "The target is too close to the edge of the site."
    : `The target is on a ${g.slope[dst].toFixed(1)}° slope; the limit ${mode === "foot" ? "on foot" : "for the rover"} is ${TRAVEL[mode].maxSlopeDeg}°.` };
  if (cost[src] === Infinity) cost[src] = 1 + WEIGHTS.slope;      // the station stands there already
  const work = cost.slice(), kept: number[][] = [];
  for (let k = 0; k < WANTED * 3 && kept.length < WANTED; k++) {
    const p = dijkstra(work, g, src, dst);
    if (!p) break;
    const near = dilate(g, p, 1, () => {});
    if (kept.every((q) => q.filter((i) => near[i]).length / q.length < MAX_OVERLAP
        && p.filter((i) => dilate(g, q, 1, () => {})[i]).length / p.length < MAX_OVERLAP)) kept.push(p);
    dilate(g, p, SPREAD_CELLS, (i) => { work[i] *= PENALTY; });
  }
  if (!kept.length) return { ...trip, error: `No way through: slopes over ${TRAVEL[mode].maxSlopeDeg}° block every route.` };
  trip.routes = kept.map((p) => measure(t, g, cost, p, from, to, mode)).sort((x, y) => x.cost - y.cost);
  return trip;
}

const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m / 10) * 10} m`);

/**
 * One plain sentence per route saying why it ranks where it does, built only from the route's own numbers.
 * Route A is the reference (lowest total cost); the others are described by what they gain and what they cost.
 */
export function explainRoutes(trip: Trip): string[] {
  const [a, ...rest] = trip.routes;
  if (!a) return [];
  const all = trip.routes, best = (f: (r: Route) => number) => all.every((r) => f(a) <= f(r) + 1e-9);
  const also = [best((r) => r.lengthM) && "the shortest", best((r) => r.maxSlopeDeg) && "the gentlest at its steepest point",
    a.dust !== null && best((r) => r.dust!) && "the least dusty"].filter(Boolean) as string[];
  const list = (x: string[]) => (x.length > 1 ? `${x.slice(0, -1).join(", ")} and ${x[x.length - 1]}` : x[0]);
  const out = [`Lowest total risk of the ${all.length === 1 ? "routes found" : all.length + " routes"}`
    + (also.length ? `; it is also ${list(also)}.` : ": it is not the best on every count, but the best balance of slope, dust, wind and distance.")];
  for (const r of rest) {
    const gain: string[] = [], lose: string[] = [];
    const cmp = (delta: number, min: number, better: string, worse: string) => {
      if (delta <= -min) gain.push(better); else if (delta >= min) lose.push(worse);
    };
    const dl = r.lengthM - a.lengthM;
    cmp(dl, Math.max(20, a.lengthM * 0.03), `${dist(-dl)} shorter`, `${dist(dl)} longer`);
    const ds = r.maxSlopeDeg - a.maxSlopeDeg;
    cmp(ds, 1.5, `its steepest point is ${r.maxSlopeDeg.toFixed(0)}° instead of ${a.maxSlopeDeg.toFixed(0)}°`, `it climbs up to ${r.maxSlopeDeg.toFixed(0)}° (A: ${a.maxSlopeDeg.toFixed(0)}°)`);
    const dm = r.meanSlopeDeg - a.meanSlopeDeg;
    cmp(dm, 0.7, `gentler on average (${r.meanSlopeDeg.toFixed(1)}° against ${a.meanSlopeDeg.toFixed(1)}°)`, `steeper on average (${r.meanSlopeDeg.toFixed(1)}° against ${a.meanSlopeDeg.toFixed(1)}°)`);
    if (r.dust !== null && a.dust !== null) { const d = Math.round((r.dust - a.dust) * 100); cmp(d, 4, `${-d} points less dust`, `${d} points more dust`); }
    if (r.wind !== null && a.wind !== null) { const d = Math.round((r.wind - a.wind) * 100); cmp(d, 4, "more sheltered from the wind", "more exposed to the wind"); }
    const more = Math.round((r.cost / a.cost - 1) * 100);
    out.push((gain.length ? `Compared with A: ${list(gain)}` + (lose.length ? `, but ${list(lose)}.` : ".")
      : lose.length ? `No advantage over A: ${list(lose)}.` : "Very close to A on every count; it only takes a different way.")
      + ` Total risk ${more}% higher.`);
  }
  return out;
}
