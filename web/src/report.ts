// Trip reports: what a finished trip cost the crew, kept per site so that later trips are planned better.
// A report is built only from the simulated body log of the trip (body.ts) and the route. Nothing is random.
// The "lessons" rules below (what a past trip changes in the next plan) are OURS and shown as assumptions.
import { HR_MAX, RULES, type Vitals, type VitalsLog } from "./body";
import type { Mode } from "./routes";

export type Outcome = "safe" | "waited" | "walked" | "refuge" | "rescued" | "lost" | "ended";
export interface TripReport {
  id: string; when: string; site: string; mode: Mode; route: string; outcome: Outcome;
  headline: string; summary: string;
  numbers: { distanceM: number; minutes: number; kcal: number; peakBpm: number; o2Used: number; suitLeft: number; dust: number; doseMsv: number; waterKg: number; fatigue: number };
  plan: { distanceM: number; minutes: number; kcal: number; peakBpm: number };
  series: { t: number[]; bpm: number[]; watts: number[]; suit: number[]; dust: number[] };
  path: [number, number][]; start: [number, number]; target: [number, number];
  alerts: { t: number; text: string; x: number; y: number }[];
  emergency: { title: string; message: string; fix: string; at: [number, number]; options: { name: string; why: string; chosen: boolean }[] } | null;
  lessons: string[];
}
/** One stretch of a trip: its body log and how far into it the trip went (seconds). */
export interface Leg { log: VitalsLog; until: number }

export const HEADLINE: Record<Outcome, string> = {
  safe: "Back safe", waited: "Rescued: waited in the rover", walked: "Walked home after a breakdown", refuge: "Safe at the refuge",
  rescued: "Rescued by the standby rover", lost: "Trip failed: oxygen ran out", ended: "Trip stopped early",
};
const dur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.max(1, Math.round(min))} min`);
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export function buildReport(a: {
  site: string; mode: Mode; route: string; outcome: Outcome; legs: Leg[]; planLog: VitalsLog; planDistanceM: number; tank: number;
  target: [number, number]; alternatives: { route: string; kcal: number }[]; when: Date;
  emergency: TripReport["emergency"];
}): TripReport {
  // Stitch the legs into one run of rows with a continuous clock.
  const rows: (Vitals & { T: number })[] = [];
  let offset = 0, distance = 0;
  for (const leg of a.legs) {
    const part = leg.log.rows.filter((r) => r.t <= leg.until + 1e-6);
    for (const r of part) rows.push({ ...r, T: offset + r.t });
    distance += part.length ? part[part.length - 1].state.travelled : 0;
    offset += leg.until;
  }
  const end = rows[rows.length - 1], peak = rows.reduce((m, r) => (r.bpm > m.bpm ? r : m), rows[0]);
  const planEnd = a.planLog.rows[a.planLog.rows.length - 1], suitLeft = Math.max(0, 1 - end.suitO2 / a.tank);
  const step = Math.max(1, Math.ceil(rows.length / 160)), pick = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  const alerts: TripReport["alerts"] = [], seen = new Set<string>();
  for (const r of rows) for (const text of r.alerts) {
    const key = text.split(":")[0];
    if (!seen.has(key)) { seen.add(key); alerts.push({ t: r.T, text, x: r.state.x, y: r.state.y }); }
  }

  const lessons: string[] = [];
  lessons.push(`The heart worked hardest (${Math.round(peak.bpm)} beats a minute, ${Math.round((peak.bpm / HR_MAX) * 100)}% of the maximum) ${km(peak.state.dist)} from the base, on a ${peak.state.slope.toFixed(0)}° slope.`);
  const mine = a.alternatives.find((x) => x.route === a.route), cheaper = a.alternatives.filter((x) => mine && x.kcal < mine.kcal * 0.97).sort((x, y) => x.kcal - y.kcal)[0];
  if (a.outcome === "safe" && mine) lessons.push(cheaper ? `Route ${cheaper.route} would have cost ${Math.round((1 - cheaper.kcal / mine.kcal) * 100)}% less energy than route ${a.route}.`
    : `No other route would have cost less energy than route ${a.route}.`);
  lessons.push(end.dustLoad >= 0.5 ? `Dust on the suit reached ${Math.round(end.dustLoad * 100)}%: clean the suit before the next trip.`
    : `Dust on the suit stayed low (${Math.round(end.dustLoad * 100)}%).`);
  lessons.push(suitLeft < 0.3 ? `The suit came back with only ${Math.round(suitLeft * 100)}% of its oxygen: take a longer-lasting suit or go less far.`
    : `The suit came back with ${Math.round(suitLeft * 100)}% of its oxygen.`);
  if (end.fatigue > 0.5) lessons.push(`The crew used ${Math.round(end.fatigue * 100)}% of a day's energy budget: rest before the next trip.`);
  if (alerts[0]) lessons.push(`First warning after ${dur(alerts[0].t / 60)}: ${alerts[0].text}`);
  if (a.emergency) lessons.push(a.outcome === "lost" ? a.emergency.fix : a.outcome === "ended" ? "The trip was stopped during the emergency. The ground of the breakdown will count as risky in the next plans."
    : "The rescue plan worked. The ground of the breakdown will count as risky in the next plans.");

  const minutes = end.T / 60;
  return {
    id: `${a.when.getTime()}`, when: a.when.toISOString(), site: a.site, mode: a.mode, route: a.route, outcome: a.outcome,
    headline: `${HEADLINE[a.outcome]}${a.outcome === "lost" || a.outcome === "ended" ? "" : ` in ${dur(minutes)}`}`,
    summary: `${a.mode === "foot" ? "On foot" : "By rover"}, route ${a.route}, ${km(distance)} covered.`,
    numbers: { distanceM: distance, minutes, kcal: end.kcal, peakBpm: peak.bpm, o2Used: end.o2Litres, suitLeft, dust: end.dustLoad, doseMsv: end.doseMsv, waterKg: end.waterKg, fatigue: end.fatigue },
    plan: { distanceM: a.planDistanceM, minutes: planEnd.t / 60, kcal: planEnd.kcal, peakBpm: a.planLog.peakBpm },
    series: { t: pick.map((r) => r.T), bpm: pick.map((r) => r.bpm), watts: pick.map((r) => r.watts), suit: pick.map((r) => Math.max(0, (1 - r.suitO2 / a.tank) * 100)), dust: pick.map((r) => r.dustLoad * 100) },
    path: pick.map((r) => [r.state.x, r.state.y]), start: [rows[0].state.x, rows[0].state.y], target: a.target,
    alerts, emergency: a.emergency, lessons,
  };
}

// ---- storage (this computer only) -------------------------------------------------------------------------------
const key = (site: string) => `red-atlas-trips:${site}`, restKey = (site: string) => `red-atlas-rested:${site}`;
export function loadReports(site: string): TripReport[] {
  try { const v = JSON.parse(localStorage.getItem(key(site)) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveReport(site: string, r: TripReport): TripReport[] {
  const all = [...loadReports(site), r].slice(-30);
  try { localStorage.setItem(key(site), JSON.stringify(all)); } catch { /* storage full or private mode: the report still shows */ }
  return all;
}
export function clearReports(site: string) { try { localStorage.removeItem(key(site)); localStorage.removeItem(restKey(site)); } catch { /* ignore */ } }
export const markRested = (site: string, when: Date) => { try { localStorage.setItem(restKey(site), when.toISOString()); } catch { /* ignore */ } };
export const restedAt = (site: string) => { try { return localStorage.getItem(restKey(site)); } catch { return null; } };

// ---- what earlier trips change in the next plan (ASSUMPTIONS) ---------------------------------------------------
export const LESSON_RULES = { knownFactor: 0.85, troubleFactor: 1.5, slopeBoost: 0.25 };
export interface Lessons {
  count: number;
  known: [number, number][];        // ground crossed on trips that ended well: preferred
  trouble: [number, number][];      // where a warning or a breakdown happened: avoided
  slopeBoost: number;               // slopes weigh more when an earlier trip ran the heart high
  carry: { kcal: number; dustLoad: number; doseMsv: number } | null;   // tiredness, dust and radiation from earlier today
  notes: string[];
}
export function lessonsFrom(reports: TripReport[], now: Date, rested: string | null): Lessons {
  const known: [number, number][] = [], trouble: [number, number][] = [], notes: string[] = [];
  let hot = 0;
  for (const r of reports) {
    if (r.outcome === "safe") known.push(...r.path);
    for (const a of r.alerts) trouble.push([a.x, a.y]);
    if (r.emergency) trouble.push(r.emergency.at);
    if (r.numbers.peakBpm > 0.7 * HR_MAX) hot++;
  }
  const good = reports.filter((r) => r.outcome === "safe").length;
  if (good) notes.push(`Ground crossed safely on ${good} earlier trip${good > 1 ? "s" : ""} counts as ${Math.round((1 - LESSON_RULES.knownFactor) * 100)}% less risky.`);
  if (trouble.length) notes.push(`${trouble.length} place${trouble.length > 1 ? "s" : ""} where a warning or a breakdown happened count as ${Math.round((LESSON_RULES.troubleFactor - 1) * 100)}% more risky.`);
  if (hot) notes.push(`The heart ran high on ${hot} earlier trip${hot > 1 ? "s" : ""}: slopes weigh ${Math.round(LESSON_RULES.slopeBoost * 100)}% more.`);
  // Carry-over: trips of the same calendar day that came after the last rest.
  const today = reports.filter((r) => r.when.slice(0, 10) === now.toISOString().slice(0, 10) && (!rested || r.when > rested));
  const carry = today.length ? { kcal: today.reduce((s, r) => s + r.numbers.kcal, 0), dustLoad: Math.min(1, today.reduce((s, r) => s + r.numbers.dust, 0)), doseMsv: today.reduce((s, r) => s + r.numbers.doseMsv, 0) } : null;
  if (carry) notes.push(`The crew starts with ${Math.round(carry.kcal)} kcal already used today (${Math.round(Math.min(1, carry.kcal / RULES.budgetKcal) * 100)}% tired) and ${Math.round(carry.dustLoad * 100)}% dust on the suit.`);
  return { count: reports.length, known, trouble, slopeBoost: hot ? LESSON_RULES.slopeBoost : 0, carry, notes };
}
