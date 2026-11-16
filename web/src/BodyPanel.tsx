import { CREW, HR_MAX, RULES, type Vitals, type VitalsLog } from "./body";
import { fmtVal } from "./globeData";

/** Where each simulated sensor sits on the body outline (viewBox 0 0 100 210). */
const SENSORS = { head: [50, 20], chest: [44, 62], lungs: [58, 70], skin: [24, 92], dose: [56, 96], thigh: [41, 136], boot: [40, 198] } as const;

/** Crew monitor shown during a trip: a body outline with sensor points and the values they would report.
 *  All values are simulated from the route and the ground under the crew (see body.ts). */
export function BodyPanel({ v, log, tempK, groundWarm, tank, homeNow }: { v: Vitals; log: VitalsLog; tempK: number | null; groundWarm: number | null;
  /** Suit oxygen when full (litres) and the walk home from where the crew is now. */
  tank: number; homeNow: { o2: number; time: number } | null }) {
  const left = Math.max(0, tank - v.suitO2), home = homeNow ? homeNow.o2 / Math.max(left, 1e-6) : null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const hot = { chest: v.bpm > 0.7 * HR_MAX, head: v.stress > 0.7, thigh: v.fatigue > 0.8, skin: v.dustLoad > 0.7, lungs: false, dose: false, boot: v.state.slope > 12 };
  const rows: [keyof typeof SENSORS, string, string, string][] = [
    ["chest", "Heart rate", `${Math.round(v.bpm)} beats/min`, `Peak so far in this trip plan: ${Math.round(log.peakBpm)} bpm. Maximum for age ${CREW.ageYears}: ${HR_MAX.toFixed(0)} bpm.`],
    ["thigh", "Effort", `${Math.round(v.watts)} W, ${Math.round(v.kcal)} kcal used`, "Metabolic power now and energy used since departure."],
    ["thigh", "Fatigue", pct(v.fatigue), `Share of a ${RULES.budgetKcal} kcal outing budget (assumption).`],
    ["head", "Stress", pct(v.stress), "Index from heart rate, slope, wind exposure and distance from the base (assumption)."],
    ["lungs", "Oxygen used", `${v.o2Litres.toFixed(0)} L`, "From the energy used, 20.9 kJ per litre of oxygen."],
    ["skin", v.outside ? "Dust on the suit" : "Dust on the suit (in the cabin)", pct(v.dustLoad), "Index from the ground dust and wind exposure along the way (assumption). 100% = clean the suit."],
    ["boot", "Ground now", `${v.grain}, slope ${v.state.slope.toFixed(0)}°`, "Grain class from the night-infrared dust index (relative to this site)."],
    ["dose", "Radiation", `${(v.doseMsv * 1000).toFixed(1)} µSv`, `Time outside x ${RULES.doseMsvPerDay} mSv/day, the rate Curiosity measured at Gale crater.`],
  ];
  return <section className="block body">
    <div className="block-head"><h2>Body check</h2><span className="warn">simulated</span></div>
    <div className="body-grid">
      <svg viewBox="0 0 100 210" role="img" aria-label="Body outline with sensor points">
        <g fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
          <circle cx="50" cy="20" r="13" />
          <path d="M38 36 H62 L74 46 V100 H68 V58 H66 V110 H34 V58 H32 V100 H26 V46 Z" />
          <path d="M34 110 V196 H47 V122 H53 V196 H66 V110" />
          <path d="M30 196 H47 V204 H28 Z M53 196 H70 L72 204 H53 Z" />
          <rect x="62" y="40" width="10" height="34" strokeDasharray="2 2" />
        </g>
        {(Object.keys(SENSORS) as (keyof typeof SENSORS)[]).map((k) =>
          <circle key={k} cx={SENSORS[k][0]} cy={SENSORS[k][1]} r={hot[k] ? 5 : 3.2} fill={hot[k] ? "var(--red)" : "var(--blue)"} stroke="var(--paper)" strokeWidth="1" />)}
      </svg>
      <table className="values"><tbody>
        {rows.map(([k, name, val, tip]) => <tr key={name} title={tip} className={hot[k] && (name === "Heart rate" || name === "Stress" || name === "Fatigue" || name.startsWith("Dust")) ? "alert" : undefined}>
          <td>{name}</td><td>{val}</td></tr>)}
        <tr title="Oxygen left in the suit; it is only used outside the rover cabin" className={left / tank < 0.2 ? "alert" : undefined}><td>Suit oxygen</td><td>{pct(left / tank)} left</td></tr>
        {homeNow && <tr title="Cheapest walk to the station or a refuge from here, as a share of the suit oxygen left" className={home! > 0.9 ? "alert" : undefined}>
          <td>Walk home</td><td>{Math.round(homeNow.time / 60)} min, {pct(home!)} of the oxygen left{home! > 0.9 ? ": not possible alone" : ""}</td></tr>}
        {tempK !== null && <tr title="Regional mean surface temperature (weather model), not a suit sensor"><td>Outside</td><td>{fmtVal("temp", tempK)}{groundWarm !== null && `, ground ${groundWarm > 0.65 ? "warmer" : groundWarm < 0.35 ? "colder" : "average"} here`}</td></tr>}
      </tbody></table>
    </div>
    {v.alerts.length > 0 ? v.alerts.map((a) => <p key={a} className="error">{a}</p>) : <p className="muted">No alerts.</p>}
    <p className="note">Airborne Mars dust is about {RULES.dustMicrometres} µm across: fine enough to be breathed in if it gets into the cabin
      (under 10 µm reaches the airways, under 2.5 µm the deep lung). Coarse grains stay on the suit.</p>
    <details className="fold">
      <summary>How these are computed</summary>
      <p className="note">Not real sensors: values are computed from the route (speed, climb, ground dust, wind exposure, time outside).
        Walking power: Pandolf et al. 1977, with body ({CREW.bodyKg} kg) and suit ({CREW.suitKg} kg) weights scaled to Mars gravity,
        plus {RULES.suitW} W for the suit. For comparison, Apollo Moon walks averaged 272 W. Maximum heart rate: Tanaka et al. 2001.
        Radiation rate: Hassler et al. 2014. Dust size: Lemmon et al. 2004.</p>
      <p className="note"><span className="warn">Assumptions</span> (ours): the crew member, suit mass, rover and work power ({RULES.rideW} W, {RULES.workW + RULES.suitW} W),
        and the stress, fatigue and dust-load indices.</p>
    </details>
  </section>;
}
