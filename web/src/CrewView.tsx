import { useMemo } from "react";
import { CREW, HR_MAX, RULES, type Vitals, type VitalsLog } from "./body";
import { fmtVal } from "./globeData";

const pct = (x: number) => `${Math.round(Math.max(0, x) * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One small time chart: the whole trip, a cursor at "now", the current value in the title. */
export function Chart({ name, now, values, times, t, limit, unit }: {
  name: string; now: string; values: (number | null)[]; times: number[]; t: number; limit?: number; unit: string;
}) {
  const W = 240, H = 64, ok = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const lo = Math.min(0, ...ok), hi = Math.max(limit ?? 0, ...ok, lo + 1e-9), T = times[times.length - 1] || 1;
  const X = (x: number) => (x / T) * W, Y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 6);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${X(times[i]).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true;
  });
  return <figure className="chart">
    <figcaption><b>{name}</b><span>{now}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${name} over the trip, in ${unit}`}>
      {limit !== undefined && <line x1={0} x2={W} y1={Y(limit)} y2={Y(limit)} stroke="var(--red)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      <path d={d} fill="none" stroke="var(--ink)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      <line x1={X(t)} x2={X(t)} y1={0} y2={H} stroke="var(--blue)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="chart-axis"><span>{lo.toFixed(0)} to {hi.toFixed(0)} {unit}</span><span>{clock(T)}</span></div>
  </figure>;
}

/**
 * Crew view: the human layout that replaces the map during a trip. A large body figure with the simulated sensors
 * by body system, the full list of values, time charts of the whole trip and the event log.
 * Every value is simulated from the route and the ground under the crew (body.ts); there are no real sensors.
 */
export function CrewView({ v, log, t, tank, home, tempK, missionDoseMsv, notes }: {
  v: Vitals; log: VitalsLog; t: number; tank: number;
  /** Walk home from every moment of the trip: litres of oxygen and seconds, or null where there is no way. */
  home: ({ o2: number; time: number } | null)[];
  tempK: number | null; missionDoseMsv: number; notes: { t: number; text: string; bad?: boolean }[];
}) {
  const left = Math.max(0, tank - v.suitO2), i = Math.min(log.rows.length - 1, Math.round(t / log.dt)), hNow = home[i];
  const times = useMemo(() => log.rows.map((r) => r.t), [log]);
  const events = useMemo(() => {
    const out: { t: number; text: string; bad?: boolean }[] = [...notes], seen = new Set<string>();
    const PH = { out: "Departure.", work: "Arrived at the target: work starts.", back: "Work done: leaving the target.", wait: "Waiting for help.", done: "Arrived." } as const;
    let last = "", turned = false;
    log.rows.forEach((r, k) => {
      if (r.state.phase !== last) { last = r.state.phase; out.push({ t: r.t, text: PH[r.state.phase] }); }
      for (const a of r.alerts) { const key = a.split(":")[0]; if (!seen.has(key)) { seen.add(key); out.push({ t: r.t, text: a, bad: true }); } }
      const h = home[k];
      if (!turned && h && r.outside && h.o2 > (tank - r.suitO2) * 0.9) { turned = true; out.push({ t: r.t, text: "Point of no return: the walk home no longer fits in the suit oxygen.", bad: true }); }
    });
    return out.sort((a, b) => a.t - b.t);
  }, [log, home, tank, notes]);

  const flag = { heart: v.bpm > 0.7 * HR_MAX, lungs: left / tank < 0.2, muscle: v.fatigue > 0.8, heat: false, suit: v.dustLoad > 0.7, dose: false, head: v.stress > 0.7 };
  const dot = (k: keyof typeof flag, x: number, y: number) =>
    <circle cx={x} cy={y} r={flag[k] ? 6 : 4} fill={flag[k] ? "var(--red)" : "var(--blue)"} stroke="var(--paper)" strokeWidth="1.2" />;
  const systems: [keyof typeof flag, string, [string, string, string?][]][] = [
    ["heart", "Heart and circulation", [
      ["Heart rate", `${Math.round(v.bpm)} beats/min`, `Maximum for age ${CREW.ageYears}: ${HR_MAX.toFixed(0)} bpm (Tanaka et al. 2001).`],
      ["Share of maximum", pct(v.bpm / HR_MAX)], ["Highest in this trip", `${Math.round(log.peakBpm)} beats/min`]]],
    ["lungs", "Lungs and breathing", [
      ["Breathing", `${Math.round(v.breaths)} breaths/min`, "Assumption: rises in a straight line with effort."],
      ["Air breathed", `${v.ventLmin.toFixed(0)} L/min`, `About ${RULES.airPerO2} L of air per litre of oxygen used (typical value).`],
      ["Oxygen used", `${v.o2Litres.toFixed(0)} L`, "Energy used / 20.9 kJ per litre."],
      ["CO2 breathed out", `${v.co2Litres.toFixed(0)} L`, `${RULES.rer} L per litre of oxygen (typical mixed diet).`],
      ["Suit oxygen left", pct(left / tank), "Only used outside the rover cabin."]]],
    ["muscle", "Muscles and energy", [
      ["Effort now", `${Math.round(v.watts)} W`, "Pandolf et al. 1977 at Mars gravity, plus the suit."],
      ["Energy used", `${Math.round(v.kcal)} kcal`], ["Fatigue", pct(v.fatigue), `Share of a ${RULES.budgetKcal} kcal outing (assumption).`]]],
    ["heat", "Body heat and water", [
      ["Heat to remove", `${Math.round(v.watts)} W`, "Nearly all the effort ends as heat the suit must carry away."],
      ["Cooling water used", `${v.waterKg.toFixed(2)} kg`, `Water evaporated to remove that heat, ${RULES.latentMJkg} MJ per kg.`],
      ["Outside", tempK === null ? "not built" : fmtVal("temp", tempK), "Regional mean surface temperature (weather model), not a sensor."]]],
    ["suit", "Suit and dust", [
      ["Dust on the suit", pct(v.dustLoad), "Index from ground dust and wind exposure along the way (assumption)."],
      ["Fine, breathable share", pct(v.fineShare), "Mean night-infrared dust index over the ground walked: the higher, the finer the grains."],
      ["Ground now", `${v.state.dust > 0.65 ? "fine dust" : v.state.dust > 0.35 ? "sand" : "rock, coarse"}, slope ${v.state.slope.toFixed(0)}°`],
      ["Walk home", hNow ? `${Math.round(hNow.time / 60)} min, ${pct(hNow.o2 / Math.max(left, 1e-6))} of oxygen left` : "no way on foot"]]],
    ["dose", "Radiation", [
      ["This outing", `${(v.doseMsv * 1000).toFixed(1)} µSv`, `${RULES.doseMsvPerDay} mSv/day, measured by Curiosity at Gale crater (Hassler et al. 2014).`],
      ["Outings this session", `${((missionDoseMsv + v.doseMsv) * 1000).toFixed(1)} µSv`]]],
    ["head", "Stress", [["Stress index", pct(v.stress), "From heart rate, slope, wind exposure and distance from the base (assumption)."]]],
  ];
  return <div className="crew-view">
    <div className="crew-figure">
      <svg viewBox="0 0 100 210" role="img" aria-label="Body figure with sensor points">
        <g fill="none" stroke="var(--ink)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
          <circle cx="50" cy="20" r="13" />
          <path d="M38 36 H62 L74 46 V100 H68 V58 H66 V110 H34 V58 H32 V100 H26 V46 Z" />
          <path d="M34 110 V196 H47 V122 H53 V196 H66 V110" />
          <path d="M30 196 H47 V204 H28 Z M53 196 H70 L72 204 H53 Z" />
          <rect x="62" y="40" width="10" height="34" strokeDasharray="2 2" />
        </g>
        {dot("head", 50, 20)}{dot("heart", 44, 60)}{dot("lungs", 57, 68)}{dot("heat", 50, 88)}{dot("dose", 60, 100)}{dot("muscle", 41, 140)}{dot("suit", 29, 80)}
      </svg>
      <p className="warn">Simulated: no real sensors.</p>
      <p className="muted small">Crew member: {CREW.ageYears} years, {CREW.bodyKg} kg, suit {CREW.suitKg} kg (assumptions).</p>
      {v.alerts.length ? v.alerts.map((a) => <p key={a} className="error">{a}</p>) : <p className="muted">No alerts.</p>}
    </div>
    <div className="crew-systems">
      {systems.map(([k, name, rows]) => <section key={name} className={flag[k] ? "alert" : undefined}>
        <h3>{name}</h3>
        <table className="values"><tbody>{rows.map(([a, b, tip]) => <tr key={a} title={tip}><td>{a}</td><td>{b}</td></tr>)}</tbody></table>
      </section>)}
    </div>
    <div className="crew-charts">
      <Chart name="Heart rate" now={`${Math.round(v.bpm)} beats/min`} unit="beats/min" values={log.rows.map((r) => r.bpm)} times={times} t={t} limit={0.7 * HR_MAX} />
      <Chart name="Effort" now={`${Math.round(v.watts)} W`} unit="W" values={log.rows.map((r) => r.watts)} times={times} t={t} />
      <Chart name="Suit oxygen left" now={pct(left / tank)} unit="%" values={log.rows.map((r) => Math.max(0, (1 - r.suitO2 / tank) * 100))} times={times} t={t} />
      <Chart name="Dust on the suit" now={pct(v.dustLoad)} unit="%" values={log.rows.map((r) => r.dustLoad * 100)} times={times} t={t} limit={70} />
      <Chart name="Walk home" now={hNow ? `${Math.round(hNow.time / 60)} min` : "none"} unit="min" values={home.map((h) => (h ? h.time / 60 : null))} times={times} t={t} />
    </div>
    <div className="crew-log">
      <h3>Events</h3>
      <ol>{events.map((e, k) => <li key={k} className={`${e.t <= t ? "past" : "later"}${e.bad ? " bad" : ""}`}><span>{clock(e.t)}</span>{e.text}</li>)}</ol>
    </div>
  </div>;
}
