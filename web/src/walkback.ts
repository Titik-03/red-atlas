// Walk-back safety: can the crew walk home alive from any point of the site if the rover fails there?
//
// NASA plans surface outings around this question. Apollo rover traverses were limited by the walk back to the
// lander, and NASA's Lunar Walkback Test (Norcross et al. 2007, SAE 2007-01-3133) studied a 10 km suited walk as
// the assumed maximum excursion. Here the answer is computed for a real Mars site: one Dijkstra run outward from
// the homes (station airlock, refuges) gives every cell its cheapest walk home in suit oxygen.
//
// Oxygen per metre = walking power / speed / 20.9 kJ per litre, with the walking power of body.ts (Pandolf 1977),
// the slope counted as uphill (worst case) and the speed of routes.speedAt.
// ASSUMPTIONS (ours): the suit holds `hours` of life support sized at the Apollo average of 272 W (Apollo PLSS:
// 4 h, later 8 h), a 10 % reserve is kept, the rescue rover leaves 10 minutes after the call, and a last-resort
// emergency supply lasts 30 minutes (the Apollo emergency oxygen gave about 30 minutes).
// Two rovers: NASA's pressurised rover concept (Space Exploration Vehicle) plans for two vehicles so that one can
// help the other and hold both crews in an emergency; a rover whose cabin still holds air is a shelter.
import type { Terrain } from "./geo";
import { RULES, walkingWatts } from "./body";
import { buildCostGrid, cellCosts, dijkstraField, measure, speedAt, TRAVEL, type CostGrid, type Route, type XY } from "./routes";
import type { RegionalWind } from "./siteFilters";

export const SUIT_HOURS = [2, 4, 8] as const;
export const SUIT = { refW: 272, reserve: 0.1, rescueDelayS: 600, emergencyH: 0.5 };
/** Litres of oxygen in a suit that lasts `hours` at the reference power. */
export const tankLitres = (hours: number) => (hours * 3600 * SUIT.refW) / (RULES.kJPerLitreO2 * 1000);

export interface HomeField {
  g: CostGrid; cost: Float32Array;               // walking grid over the whole site; risk cost per cell (for route stats)
  o2: Float64Array; time: Float64Array;          // litres of oxygen and seconds to walk home from each cell (Infinity = no way)
  prev: Int32Array; homes: XY[]; homeCells: number[];
  walls: (XY & { r: number })[];
}
export type Zone = "walk" | "rescue" | "out" | "closed";

const cellAt = (g: CostGrid, p: XY) => Math.min(g.n - 1, Math.max(0, Math.floor((p.y - g.south) / g.cellY))) * g.n
  + Math.min(g.n - 1, Math.max(0, Math.floor((p.x - g.west) / g.cellX)));
const cx = (g: CostGrid, i: number) => g.west + ((i % g.n) + 0.5) * g.cellX, cy = (g: CostGrid, i: number) => g.south + (Math.floor(i / g.n) + 0.5) * g.cellY;

/** Time along the paths of a Dijkstra result: each cell after the one it leads to. */
function timeAlong(g: CostGrid, dist: Float64Array, prev: Int32Array, secPerM: Float32Array) {
  const N = g.n * g.n, time = new Float64Array(N).fill(Infinity), diag = Math.hypot(g.cellX, g.cellY);
  const order = Array.from({ length: N }, (_, i) => i).filter((i) => dist[i] < Infinity).sort((a, b) => dist[a] - dist[b]);
  for (const i of order) {
    const p = prev[i];
    if (p < 0) { time[i] = 0; continue; }
    const dr = Math.abs(((i / g.n) | 0) - ((p / g.n) | 0)), dc = Math.abs((i % g.n) - (p % g.n));
    time[i] = time[p] + (dr && dc ? diag : dr ? g.cellY : g.cellX) * (secPerM[i] + secPerM[p]) / 2;
  }
  return time;
}

/**
 * Cheapest walk in suit oxygen from the source cells to every cell (the same in both directions).
 * `factor` below 1 is a slower walker (a crew member in trouble).
 */
export function walkField(g: CostGrid, sources: number[], walls: (XY & { r: number })[], factor = 1) {
  const N = g.n * g.n, perM = new Float32Array(N), secPerM = new Float32Array(N), lim = TRAVEL.foot.maxSlopeDeg;
  for (let i = 0; i < N; i++) {
    const s = g.slope[i], x = cx(g, i), y = cy(g, i);
    const shut = !(s <= lim) || walls.some((b) => Math.hypot(x - b.x, y - b.y) <= b.r);
    if (shut && !sources.includes(i)) { perM[i] = Infinity; secPerM[i] = Infinity; continue; }
    const v = speedAt("foot", Math.min(s || 0, lim)) * factor, grade = Math.tan(((s || 0) * Math.PI) / 180) * 100;
    perM[i] = (walkingWatts(v, grade, g.fines[i]) + RULES.suitW) / v / (RULES.kJPerLitreO2 * 1000);
    secPerM[i] = 1 / v;
  }
  const { dist, prev } = dijkstraField(perM, g, sources);
  return { o2: dist, prev, time: timeAlong(g, dist, prev, secPerM) };
}

/** Cheapest walk (in oxygen) from every cell of the site to the nearest home. The first home is the station. */
export function buildHomeField(t: Terrain, wind: RegionalWind | null, homes: XY[], blocked: (XY & { r: number })[] = []): HomeField {
  const e = t.meta.extent_m, g = buildCostGrid(t, wind, { x: e.west, y: e.south }, { x: e.east, y: e.north });
  const homeCells = homes.map((h) => cellAt(g, h)), w = walkField(g, homeCells, blocked);
  const cost = cellCosts(g, "foot");
  for (const i of homeCells) if (cost[i] === Infinity) cost[i] = 1;
  return { g, cost, ...w, homes, homeCells, walls: blocked };
}

/** Oxygen (litres) and time (seconds) to walk home from a point; null when there is no way on foot. */
export function walkHome(f: HomeField, p: XY): { o2: number; time: number } | null {
  const i = cellAt(f.g, p);
  return f.o2[i] < Infinity ? { o2: f.o2[i], time: f.time[i] } : null;
}

/**
 * Oxygen needed until the rescue rover reaches a crew walking home (ESTIMATE for the map): the crew walks during
 * the dispatch delay, then closes the rest together with the rover, which is `ratio` times faster.
 */
export function rescueO2(o2Home: number, timeHome: number) {
  const ratio = TRAVEL.rover.speedKmh / TRAVEL.foot.speedKmh, rate = timeHome > 0 ? o2Home / timeHome : 0;
  if (timeHome <= SUIT.rescueDelayS) return o2Home;
  return rate * (SUIT.rescueDelayS + (timeHome - SUIT.rescueDelayS) / (1 + ratio));
}

/** Which zone a point is in for a given amount of suit oxygen (litres) still available. */
export function zoneOf(f: HomeField, i: number, available: number): Zone {
  if (f.o2[i] === Infinity) return "closed";
  const usable = available * (1 - SUIT.reserve);
  return f.o2[i] <= usable ? "walk" : rescueO2(f.o2[i], f.time[i]) <= usable ? "rescue" : "out";
}
export const zoneAt = (f: HomeField, p: XY, available: number) => zoneOf(f, cellAt(f.g, p), available);

/** The walk home from a point as a route (for the emergency replay), or null when there is no way. */
export function routeHome(t: Terrain, f: HomeField, from: XY): Route | null {
  let i = cellAt(f.g, from);
  if (f.o2[i] === Infinity) return null;
  const path = [i];
  while (f.prev[i] >= 0) { i = f.prev[i]; path.push(i); }
  if (path.length < 2) path.push(i);
  const home = f.homes.reduce((a, b) => (Math.hypot(b.x - cx(f.g, i), b.y - cy(f.g, i)) < Math.hypot(a.x - cx(f.g, i), a.y - cy(f.g, i)) ? b : a));
  return measure(t, f.g, f.cost, path, from, home, "foot");
}

/** The hardest walk home along a route: the point that costs the most oxygen to get home from. */
export function worstWalkHome(f: HomeField, r: Route) {
  let o2 = 0, time = 0, blocked = false;
  for (const [x, y] of r.points) {
    const w = walkHome(f, { x, y });
    if (!w) { blocked = true; continue; }
    if (w.o2 > o2) { o2 = w.o2; time = w.time; }
  }
  return { o2, time, blocked };
}

export const ZONE_COLORS: Record<Zone, string> = { walk: "#2f7d4f", rescue: "#d9a21b", out: "#ad2218", closed: "#3a3d40" };
/** Map overlay (RGBA, n x n, row 0 = south): the three zones, the walk zone shaded by the oxygen margin left. */
export function zoneTexture(f: HomeField, available: number) {
  const n = f.g.n, rgba = new Uint8ClampedArray(n * n * 4), hex = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
  const usable = available * (1 - SUIT.reserve), light = hex("#cfe6c6"), cols = { walk: hex(ZONE_COLORS.walk), rescue: hex(ZONE_COLORS.rescue), out: hex(ZONE_COLORS.out), closed: hex(ZONE_COLORS.closed) };
  for (let i = 0; i < n * n; i++) {
    const z = zoneOf(f, i, available), c = cols[z], k = z === "walk" ? Math.min(1, f.o2[i] / usable) : 1;
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = z === "walk" ? light[j] + (c[j] - light[j]) * k : c[j];
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, size: n };
}

/** Part of a route between two distances from its start (dA < dB), as a route of its own; reversed when asked. */
export function sliceRoute(r: Route, dA: number, dB: number, reverse = false): Route {
  const { d, slope, dust, wind } = r.profile, n = d.length;
  const at = (x: number) => {
    let k = 1; while (k < n - 1 && d[k] < x) k++;
    const f = d[k] > d[k - 1] ? Math.min(1, Math.max(0, (x - d[k - 1]) / (d[k] - d[k - 1]))) : 0, m = (a: number, b: number) => a + (b - a) * f;
    return { p: [0, 1, 2].map((c) => m(r.points[k - 1][c], r.points[k][c])) as [number, number, number], s: m(slope[k - 1], slope[k]), u: m(dust[k - 1], dust[k]), w: m(wind[k - 1], wind[k]) };
  };
  const cut = [at(dA), ...r.points.map((p, k) => ({ p, s: slope[k], u: dust[k], w: wind[k], d: d[k] })).filter((q) => q.d > dA && q.d < dB), at(dB)];
  if (reverse) cut.reverse();
  const dd = [0];
  for (let k = 1; k < cut.length; k++) dd.push(dd[k - 1] + Math.hypot(cut[k].p[0] - cut[k - 1].p[0], cut[k].p[1] - cut[k - 1].p[1]));
  return { ...r, points: cut.map((q) => q.p), lengthM: dd[dd.length - 1], profile: { d: dd, slope: cut.map((q) => q.s), dust: cut.map((q) => q.u), wind: cut.map((q) => q.w) } };
}

/**
 * Rescue along the trip route: the crew walks back toward the base from `s0` metres along the route while the
 * rescue rover drives out from the base after the dispatch delay. Returns where and when they meet (both arrive at
 * the same moment), and the two part-routes to play.
 */
export function rescuePlan(r: Route, s0: number) {
  const { d, slope } = r.profile, n = d.length, step = Math.max(1, s0 / 400);
  const sl = (x: number) => { let k = 1; while (k < n - 1 && d[k] < x) k++; const f = d[k] > d[k - 1] ? (x - d[k - 1]) / (d[k] - d[k - 1]) : 0; return slope[k - 1] + (slope[k] - slope[k - 1]) * Math.min(1, Math.max(0, f)); };
  // March both along the route in small steps until they meet.
  let crew = s0, rover = 0, time = 0;
  while (crew - rover > 1e-6) {
    const vc = speedAt("foot", sl(crew)), vr = time < SUIT.rescueDelayS ? 0 : speedAt("rover", sl(rover));
    const dt = Math.min(step / vc, vr ? step / vr : SUIT.rescueDelayS - time || step / vc, (crew - rover) / (vc + vr));
    crew -= vc * dt; rover += vr * dt; time += dt;
  }
  const meet = Math.min(s0, Math.max(0, (crew + rover) / 2));
  return { meetM: meet, meetS: time, crew: sliceRoute(r, meet, s0, true), rover: meet > 1 ? sliceRoute(r, 0, meet) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// What to do when something goes wrong: every option is worked out, and the one that costs the least suit oxygen
// is chosen. Nothing is assumed about the trip route: the rescue rover takes its own fastest drive, and the meeting
// point is the cell where meeting costs the crew the least oxygen (walk there, then wait if the rover is later).

/** Fastest drive of the rescue rover from the base to every cell it can reach (slopes up to the rover limit). */
export interface RoverField { time: Float64Array; prev: Int32Array; base: XY; cost: Float32Array }
export function buildRoverField(f: HomeField, base: XY): RoverField {
  const g = f.g, N = g.n * g.n, secPerM = new Float32Array(N), src = cellAt(g, base), lim = TRAVEL.rover.maxSlopeDeg;
  for (let i = 0; i < N; i++) {
    const s = g.slope[i], x = cx(g, i), y = cy(g, i);
    const shut = !(s <= lim) || f.walls.some((b) => Math.hypot(x - b.x, y - b.y) <= b.r && Math.hypot(base.x - b.x, base.y - b.y) > b.r);
    secPerM[i] = shut && i !== src ? Infinity : 1 / speedAt("rover", Math.min(s || 0, lim));
  }
  const { dist, prev } = dijkstraField(secPerM, g, [src]), cost = cellCosts(g, "rover");
  for (let i = 0; i < N; i++) if (dist[i] < Infinity && cost[i] === Infinity) cost[i] = 1;
  return { time: dist, prev, base, cost };
}

/** drive = the rover cannot drive but its cabin holds air; leak = the cabin is lost; crew = a walker is in trouble. */
export type Trouble = "drive" | "leak" | "crew";
export interface Option {
  id: "wait" | "home" | "refuge" | "meet"; name: string;
  possible: boolean; emergency: boolean;      // emergency = only with the last-resort oxygen
  o2: number; seconds: number;                // suit oxygen (litres) and time until the crew is safe
  crew: Route | null; holdS: number; holdInside: boolean; rover: Route | null;
  why: string;
}
export interface Decision { options: Option[]; chosen: Option | null; fallback: Option | null; o2Left: number; fix: string }
export const emergencyLitres = () => tankLitres(SUIT.emergencyH);

function chain(prev: Int32Array, from: number) { const p = [from]; let i = from; while (prev[i] >= 0) { i = prev[i]; p.push(i); } return p; }
const two = (p: number[]) => (p.length < 2 ? [p[0], p[0]] : p);

export function decide(t: Terrain, f: HomeField, rf: RoverField, pos: XY, o2Left: number, trouble: Trouble): Decision {
  const g = f.g, here = cellAt(g, pos), cf = walkField(g, [here], f.walls, trouble === "crew" ? 0.5 : 1);
  const usable = o2Left * (1 - SUIT.reserve), most = o2Left + emergencyLitres(), waitRate = RULES.waitW / (RULES.kJPerLitreO2 * 1000);
  const pctOf = (x: number) => `${Math.round((x / Math.max(o2Left, 1e-6)) * 100)}% of the air they have left`;
  const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
  const opt = (id: Option["id"], name: string, o2: number, seconds: number, rest: Pick<Option, "crew" | "holdS" | "holdInside" | "rover">, note = ""): Option => {
    const possible = o2 <= most, emergency = possible && o2 > usable;
    return { id, name, o2, seconds, possible, emergency, ...rest,
      why: !possible ? `Not possible: needs ${pctOf(o2)}.` : `${mins(seconds)}, ${o2 < 1e-9 ? "uses no suit air" : `uses ${pctOf(o2)}`}${emergency ? ", only with the emergency oxygen" : ""}.${note}` };
  };
  const none = (id: Option["id"], name: string, why: string): Option =>
    ({ id, name, o2: Infinity, seconds: Infinity, possible: false, emergency: false, crew: null, holdS: 0, holdInside: false, rover: null, why });
  const walkTo = (cell: number, to: XY) => measure(t, g, f.cost, two(chain(cf.prev, cell).reverse()), pos, to, "foot");
  const driveTo = (cell: number, to: XY) => measure(t, g, rf.cost, two(chain(rf.prev, cell).reverse()), rf.base, to, "rover");
  const options: Option[] = [];

  // Stay in the rover: only when its cabin still holds air and the rescue rover can drive there.
  if (trouble === "drive") options.push(rf.time[here] < Infinity
    ? opt("wait", "Stay in the rover and wait", 0, SUIT.rescueDelayS + rf.time[here], { crew: null, holdS: SUIT.rescueDelayS + rf.time[here], holdInside: true, rover: driveTo(here, pos) })
    : none("wait", "Stay in the rover and wait", "Not possible: the rescue rover has no drivable way to this point."));
  if (trouble === "leak") options.push(none("wait", "Stay in the rover and wait", "Not possible: the cabin no longer holds air."));

  // Walk to the station.
  const door = f.homeCells[0];
  options.push(cf.o2[door] < Infinity ? opt("home", "Walk home", cf.o2[door], cf.time[door], { crew: walkTo(door, f.homes[0]), holdS: 0, holdInside: false, rover: null })
    : none("home", "Walk home", "Not possible: there is no way home on foot (ground steeper than 20°)."));

  // Walk to the nearest refuge.
  if (f.homeCells.length > 1) {
    let best = -1;
    for (let k = 1; k < f.homeCells.length; k++) if (cf.o2[f.homeCells[k]] < (best < 0 ? Infinity : cf.o2[f.homeCells[best]])) best = k;
    options.push(best > 0 ? opt("refuge", "Walk to the refuge and wait there", cf.o2[f.homeCells[best]], cf.time[f.homeCells[best]], { crew: walkTo(f.homeCells[best], f.homes[best]), holdS: 0, holdInside: false, rover: null })
      : none("refuge", "Walk to the refuge and wait there", "Not possible: no refuge can be reached on foot."));
  }

  // Meet the rescue rover: the cell where walking there and waiting for the rover costs the least oxygen.
  let cell = -1, o2 = Infinity, safe = Infinity;
  for (let c = 0; c < cf.o2.length; c++) {
    if (cf.o2[c] === Infinity || rf.time[c] === Infinity) continue;
    const tr = SUIT.rescueDelayS + rf.time[c], need = cf.o2[c] + waitRate * Math.max(0, tr - cf.time[c]), at = Math.max(tr, cf.time[c]);
    if (need < o2 - 1e-9 || (Math.abs(need - o2) <= 1e-9 && at < safe)) { cell = c; o2 = need; safe = at; }
  }
  if (cell < 0) options.push(none("meet", "Meet the rescue rover", "Not possible: the rescue rover cannot get anywhere the crew can walk to."));
  else {
    const to = cell === here ? pos : { x: cx(g, cell), y: cy(g, cell) }, tr = SUIT.rescueDelayS + rf.time[cell];
    const crew = walkTo(cell, to);
    options.push(opt("meet", "Meet the rescue rover", o2, safe, { crew, holdS: Math.max(0, tr - cf.time[cell]), holdInside: false, rover: driveTo(cell, to) },
      cell === here ? " The crew waits here." : ` The crew walks ${Math.round(crew.lengthM)} m toward it.`));
  }

  const rank = (a: Option, b: Option) => a.o2 - b.o2 || a.seconds - b.seconds;
  const calm = options.filter((o) => o.possible && !o.emergency).sort(rank), tight = options.filter((o) => o.possible).sort(rank);
  const chosen = calm[0] ?? tight[0] ?? null, fallback = chosen ? null : options.filter((o) => o.o2 < Infinity).sort(rank)[0] ?? null;
  const fix = chosen ? "" : fallback
    ? `What would have saved them: a refuge near this point, a suit with more oxygen (the best option needed ${pctOf(fallback.o2)}, emergency supply included), or a route that stays closer to the base.`
    : "What would have saved them: a refuge near this point. From here there is no way on foot and no way for the rescue rover.";
  return { options, chosen, fallback, o2Left, fix };
}

/**
 * Test before departure: break the trip at points all along the route and see whether an option always exists.
 * By rover the test is the hard case (the cabin leaks, after the work at the target has used suit oxygen);
 * on foot it is a crew member in trouble, with the oxygen already used to walk there.
 */
export function preflight(t: Terrain, f: HomeField, rf: RoverField, r: Route, mode: "foot" | "rover", tank: number, workO2: number) {
  const n = r.points.length, idx = Array.from(new Set(Array.from({ length: 10 }, (_, k) => Math.round(((k + 1) / 10) * (n - 1)))));
  let worst: { d: Decision; at: number; margin: number } | null = null;
  for (const k of idx) {
    const pos = { x: r.points[k][0], y: r.points[k][1] }, used = workO2 + (mode === "foot" ? (walkHome(f, pos)?.o2 ?? 0) : 0);
    const d = decide(t, f, rf, pos, Math.max(0, tank - used), mode === "foot" ? "crew" : "leak");
    const margin = d.chosen ? (tank - used - d.chosen.o2) / tank - (d.chosen.emergency ? 1 : 0) : -Infinity;
    if (!worst || margin < worst.margin) worst = { d, at: r.profile.d[k], margin };
  }
  return worst!;
}
