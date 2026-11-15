// Crew body monitor: SIMULATED vital signs along a trip. There are no real sensors; every value below is computed
// from the trip timeline (speed, climb, ground dust, wind exposure, time outside). Pure functions, nothing random.
//
// Published inputs:
//   Walking energy   Pandolf, Givoni & Goldman (1977), J. Appl. Physiol. 43:577. M [W] = 1.5 W + 2.0 (W + L)(L / W)^2
//                    + eta (W + L)(1.5 V^2 + 0.35 V G); W body mass kg, L load kg, V m/s, G grade %, eta terrain factor.
//   Maximum heart rate  Tanaka, Monahan & Seals (2001), J. Am. Coll. Cardiol. 37:153: 208 - 0.7 x age.
//   Apollo reference    lunar surface EVAs averaged 234 kcal/h (272 W) (NASA Apollo metabolic reports).
//   Radiation           0.67 mSv/day galactic cosmic ray dose equivalent on the surface, measured by Curiosity RAD
//                       at Gale crater, Aug 2012 to Jun 2013 (Hassler et al. 2014, Science 343). Not measured here.
//   Dust grain size     airborne Mars dust has an effective radius near 1.5 micrometres (Lemmon et al. 2004, Science
//                       306; Lemmon et al. 2019), i.e. about 3 micrometres across: small enough to be breathed in
//                       (the usual limits are 10 micrometres for the airways and 2.5 for the deep lung).
// ASSUMPTIONS (ours, shown as such in the app): everything in CREW and RULES below, the use of the Pandolf
// equation with weights scaled to Mars gravity, and the stress, fatigue and dust-load indices.
import { TRAVEL } from "./routes";
import { stateAt, type SimState, type Timeline } from "./sim";

export const CREW = { ageYears: 35, bodyKg: 75, suitKg: 60, restBpm: 60, vo2maxMlKgMin: 40 };
export const RULES = {
  gravity: 3.71 / 9.81,         // Mars / Earth surface gravity
  restW: 100,                   // resting metabolic rate in the suit
  suitW: 100,                   // extra work against a pressurised suit while moving or working
  rideW: 140,                   // seated in the rover (Apollo: riding the rover was the least demanding activity)
  workW: 250,                   // sampling at the target
  etaFirm: 1.1, etaLoose: 2.1,  // Pandolf terrain factor from firm ground to loose fines, by the ground dust index
  kJPerLitreO2: 20.9,           // energy released per litre of oxygen used
  hrLagS: 45,                   // heart rate follows the effort with this delay
  budgetKcal: 1500,             // energy of a long EVA: fatigue reaches 100 % here
  dustFullM: 2000,              // metres of walking on pure fines in full wind exposure x 0.5 that fill the dust load
  doseMsvPerDay: 0.67,
  dustMicrometres: 3,
};
export const HR_MAX = 208 - 0.7 * CREW.ageYears;
const MAX_W = (CREW.vo2maxMlKgMin * CREW.bodyKg / 1000 / 60) * RULES.kJPerLitreO2 * 1000;     // aerobic ceiling, watts

/** Pandolf walking power in watts on Mars: body and suit weights scaled by gravity. Downhill counts as flat. */
export function walkingWatts(speed: number, gradePct: number, dust: number) {
  const W = CREW.bodyKg * RULES.gravity, L = CREW.suitKg * RULES.gravity, eta = RULES.etaFirm + (RULES.etaLoose - RULES.etaFirm) * dust;
  return 1.5 * W + 2 * (W + L) * (L / W) ** 2 + eta * (W + L) * (1.5 * speed * speed + 0.35 * speed * Math.max(0, gradePct));
}

export interface Vitals {
  t: number; state: SimState;
  watts: number; bpm: number; kcal: number; o2Litres: number; doseMsv: number;
  fatigue: number; stress: number; dustLoad: number;       // 0..1 indices (assumptions)
  grain: "rock or coarse ground" | "sand" | "fine dust";  // relative class from the night-infrared index
  outside: boolean;                                        // in the suit (true) or inside the rover cabin
  alerts: string[];
}
export interface VitalsLog { dt: number; rows: Vitals[]; peakBpm: number }

/** The whole trip in steps of `dt` simulated seconds. */
export function buildVitals(tl: Timeline, dt = 5): VitalsLog {
  const rows: Vitals[] = [], lim = TRAVEL[tl.mode].maxSlopeDeg, far = tl.mode === "foot" ? 1000 : 5000;
  let bpm = CREW.restBpm, kcal = 0, o2 = 0, dose = 0, dust = 0, peak = bpm;
  const steps = Math.ceil(tl.totalS / dt);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(tl.totalS, i * dt), s = stateAt(tl, t), ahead = stateAt(tl, Math.min(tl.totalS, t + dt));
    const run = Math.hypot(ahead.x - s.x, ahead.y - s.y), grade = run > 0.01 && s.phase === ahead.phase ? ((ahead.z - s.z) / run) * 100 : 0;
    const outside = tl.mode === "foot" || s.phase === "work";
    const watts = s.phase === "done" ? RULES.restW : s.phase === "work" ? RULES.workW + RULES.suitW
      : tl.mode === "rover" ? RULES.rideW : walkingWatts(s.speed, grade, s.dust) + RULES.suitW;
    const target = CREW.restBpm + (HR_MAX - CREW.restBpm) * Math.min(1, Math.max(0, (watts - RULES.restW) / (MAX_W - RULES.restW)));
    if (i) {
      bpm += (target - bpm) * (1 - Math.exp(-dt / RULES.hrLagS));
      kcal += (watts * dt) / 4184; o2 += (watts * dt) / (RULES.kJPerLitreO2 * 1000);
      if (outside) dose += (RULES.doseMsvPerDay * dt) / 86400;
      if (outside) dust += (s.phase === "work" ? 0.3 * dt : s.speed * dt) * s.dust * (0.5 + 0.5 * s.wind) / (RULES.dustFullM * 0.5);
    }
    peak = Math.max(peak, bpm);
    const fatigue = Math.min(1, kcal / RULES.budgetKcal), reserve = (bpm - CREW.restBpm) / (HR_MAX - CREW.restBpm);
    const away = Math.min(1, s.dist / far);
    const stress = Math.min(1, 0.4 * reserve + 0.25 * Math.min(1, s.slope / lim) + 0.15 * s.wind + 0.2 * away);
    const alerts: string[] = [];
    if (bpm > 0.85 * HR_MAX) alerts.push("Heart rate very high: stop and rest.");
    else if (bpm > 0.7 * HR_MAX) alerts.push("Heart rate high: slow down.");
    if (s.speed > 0 && s.slope > 0.8 * lim) alerts.push(`Steep ground: ${s.slope.toFixed(0)}° of the ${lim}° limit.`);
    if (dust > 0.7) alerts.push("Dust load high: clean the suit at the airlock.");
    if (fatigue > 0.8) alerts.push("Fatigue high: energy budget almost used.");
    if (stress > 0.7) alerts.push("Stress high.");
    rows.push({ t, state: s, watts, bpm, kcal, o2Litres: o2, doseMsv: dose, fatigue, stress, dustLoad: Math.min(1, dust),
      grain: s.dust > 0.65 ? "fine dust" : s.dust > 0.35 ? "sand" : "rock or coarse ground", outside, alerts });
  }
  return { dt, rows, peakBpm: peak };
}

export const vitalsAt = (log: VitalsLog, t: number) => log.rows[Math.min(log.rows.length - 1, Math.max(0, Math.round(t / log.dt)))];
