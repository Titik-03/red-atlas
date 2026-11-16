// Trip timeline: where the crew is at every moment of a trip along a chosen route. Pure functions, no rendering.
// Out along the route, work at the target, back the same way. Speeds come from routes.speedAt (assumption).
import { speedAt, type Mode, type Route } from "./routes";

/** Time spent working at the target, minutes. ASSUMPTION. */
export const WORK_MIN: Record<Mode, number> = { foot: 20, rover: 30 };

export interface Timeline {
  mode: Mode; route: Route;
  t: number[];              // seconds after departure at each route point (outbound)
  outS: number; workS: number; totalS: number;
  /** One way only (an emergency walk or a rescue drive): no work, no return. */
  oneWay?: boolean;
  /** Seconds before this actor sets off (the rescue rover leaves after the call). */
  delayS?: number;
  /** Seconds spent waiting at the end of a one-way leg (for help), and whether that is inside a rover cabin. */
  holdS?: number; holdInside?: boolean;
  /** Walking or driving slower than normal (a crew member in trouble): 1 = normal. */
  speedFactor?: number;
}
export type Phase = "out" | "work" | "back" | "wait" | "done";
export interface SimState {
  phase: Phase; x: number; y: number; z: number;     // site-local metres and elevation
  hx: number; hy: number;                            // unit heading in site-local x (east), y (north)
  speed: number;                                     // m/s over the ground right now
  dist: number;                                      // metres from the station along the route
  travelled: number;                                 // metres covered since departure
  slope: number; dust: number; wind: number;         // route values at this point (deg, 0..1, 0..1)
}

export function buildTimeline(route: Route, mode: Mode, oneWay = false, delayS = 0, extra: { holdS?: number; holdInside?: boolean; speedFactor?: number } = {}): Timeline {
  const k = extra.speedFactor ?? 1, holdS = extra.holdS ?? 0;
  const p = route.points, t = [0], factor = k;
  for (let k = 1; k < p.length; k++) {
    const len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1], p[k][2] - p[k - 1][2]);
    t.push(t[k - 1] + len / (speedAt(mode, (route.profile.slope[k] + route.profile.slope[k - 1]) / 2) * factor));
  }
  const outS = t[t.length - 1], workS = oneWay ? 0 : WORK_MIN[mode] * 60;
  return { mode, route, t, outS, workS, totalS: oneWay ? outS + delayS + holdS : 2 * outS + workS, oneWay, delayS, ...extra };
}

export function stateAt(tl: Timeline, time: number): SimState {
  const { route: r, t, outS, workS, totalS } = tl, p = r.points, n = p.length, pr = r.profile;
  const span = totalS - (tl.delayS ?? 0), now = Math.min(span, Math.max(0, time - (tl.delayS ?? 0)));
  const phase: Phase = now >= span ? "done" : now < outS ? "out" : tl.oneWay ? "wait" : now < outS + workS ? "work" : "back";
  const back = !tl.oneWay && (phase === "back" || phase === "done");
  const tt = phase === "work" || phase === "wait" || (tl.oneWay && phase === "done") ? outS : back ? span - now : now;       // equivalent outbound time
  let k = 1;
  while (k < n - 1 && t[k] < tt) k++;
  const f = t[k] > t[k - 1] ? Math.min(1, Math.max(0, (tt - t[k - 1]) / (t[k] - t[k - 1]))) : 0;
  const mix = (a: number, b: number) => a + (b - a) * f;
  const dx = p[k][0] - p[k - 1][0], dy = p[k][1] - p[k - 1][1], h = Math.hypot(dx, dy) || 1, s = back ? -1 : 1;
  const slope = mix(pr.slope[k - 1], pr.slope[k]), dist = mix(pr.d[k - 1], pr.d[k]), full = pr.d[n - 1];
  return {
    phase, x: mix(p[k - 1][0], p[k][0]), y: mix(p[k - 1][1], p[k][1]), z: mix(p[k - 1][2], p[k][2]),
    hx: (s * dx) / h, hy: (s * dy) / h,
    speed: phase === "work" || phase === "wait" || phase === "done" || time < (tl.delayS ?? 0) ? 0 : speedAt(tl.mode, slope) * (tl.speedFactor ?? 1),
    dist, travelled: back ? 2 * full - dist : dist,
    slope, dust: mix(pr.dust[k - 1], pr.dust[k]), wind: mix(pr.wind[k - 1], pr.wind[k]),
  };
}
