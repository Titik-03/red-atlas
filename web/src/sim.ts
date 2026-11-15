// Trip timeline: where the crew is at every moment of a trip along a chosen route. Pure functions, no rendering.
// Out along the route, work at the target, back the same way. Speeds come from routes.speedAt (assumption).
import { speedAt, type Mode, type Route } from "./routes";

/** Time spent working at the target, minutes. ASSUMPTION. */
export const WORK_MIN: Record<Mode, number> = { foot: 20, rover: 30 };

export interface Timeline {
  mode: Mode; route: Route;
  t: number[];              // seconds after departure at each route point (outbound)
  outS: number; workS: number; totalS: number;
}
export type Phase = "out" | "work" | "back" | "done";
export interface SimState {
  phase: Phase; x: number; y: number; z: number;     // site-local metres and elevation
  hx: number; hy: number;                            // unit heading in site-local x (east), y (north)
  speed: number;                                     // m/s over the ground right now
  dist: number;                                      // metres from the station along the route
  travelled: number;                                 // metres covered since departure
  slope: number; dust: number; wind: number;         // route values at this point (deg, 0..1, 0..1)
}

export function buildTimeline(route: Route, mode: Mode): Timeline {
  const p = route.points, t = [0];
  for (let k = 1; k < p.length; k++) {
    const len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1], p[k][2] - p[k - 1][2]);
    t.push(t[k - 1] + len / speedAt(mode, (route.profile.slope[k] + route.profile.slope[k - 1]) / 2));
  }
  const outS = t[t.length - 1], workS = WORK_MIN[mode] * 60;
  return { mode, route, t, outS, workS, totalS: 2 * outS + workS };
}

export function stateAt(tl: Timeline, time: number): SimState {
  const { route: r, t, outS, workS, totalS } = tl, p = r.points, n = p.length, pr = r.profile;
  const now = Math.min(totalS, Math.max(0, time));
  const phase: Phase = now >= totalS ? "done" : now < outS ? "out" : now < outS + workS ? "work" : "back";
  const back = phase === "back" || phase === "done";
  const tt = phase === "work" ? outS : back ? totalS - now : now;       // equivalent outbound time
  let k = 1;
  while (k < n - 1 && t[k] < tt) k++;
  const f = t[k] > t[k - 1] ? Math.min(1, Math.max(0, (tt - t[k - 1]) / (t[k] - t[k - 1]))) : 0;
  const mix = (a: number, b: number) => a + (b - a) * f;
  const dx = p[k][0] - p[k - 1][0], dy = p[k][1] - p[k - 1][1], h = Math.hypot(dx, dy) || 1, s = back ? -1 : 1;
  const slope = mix(pr.slope[k - 1], pr.slope[k]), dist = mix(pr.d[k - 1], pr.d[k]), full = pr.d[n - 1];
  return {
    phase, x: mix(p[k - 1][0], p[k][0]), y: mix(p[k - 1][1], p[k][1]), z: mix(p[k - 1][2], p[k][2]),
    hx: (s * dx) / h, hy: (s * dy) / h,
    speed: phase === "work" || phase === "done" ? 0 : speedAt(tl.mode, slope),
    dist, travelled: back ? 2 * full - dist : dist,
    slope, dust: mix(pr.dust[k - 1], pr.dust[k]), wind: mix(pr.wind[k - 1], pr.wind[k]),
  };
}
