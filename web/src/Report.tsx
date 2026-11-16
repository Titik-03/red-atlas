import { useEffect } from "react";
import type { TerrainMeta } from "./geo";
import { Chart } from "./CrewView";
import { HR_MAX } from "./body";
import type { TripReport } from "./report";

const dur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.max(1, Math.round(min))} min`);
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const TONE = { safe: "good", waited: "warn", walked: "warn", refuge: "warn", rescued: "warn", lost: "bad", ended: "plain" } as const;

/** The trip report: opens by itself when a trip ends, and again from the trip log. */
export function Report({ r, meta, base, fresh, onClose }: { r: TripReport; meta: TerrainMeta; base: string; fresh: boolean; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const e = meta.extent_m, W = e.east - e.west, H = e.north - e.south, n = r.numbers, T = r.series.t[r.series.t.length - 1] || 1;
  const X = (x: number) => x - e.west, Y = (y: number) => e.north - y, mark = W / 55;
  const save = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `trip-report-${r.when.slice(0, 19).replace(/[:T]/g, "-")}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const versus: [string, string, string][] = [
    ["Time", dur(r.plan.minutes), dur(n.minutes)], ["Distance", km(r.plan.distanceM), km(n.distanceM)],
    ["Energy used", `${Math.round(r.plan.kcal)} kcal`, `${Math.round(n.kcal)} kcal`], ["Highest heart rate", `${Math.round(r.plan.peakBpm)}`, `${Math.round(n.peakBpm)} beats a minute`],
  ];
  return <div className="report-veil" role="dialog" aria-modal="true" aria-label="Trip report" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
    <article className={`report ${TONE[r.outcome]}`}>
      <header>
        <p className="report-kind">Trip report{fresh && <b> new</b>}<span>{new Date(r.when).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span></p>
        <h2>{r.headline}</h2>
        <p className="report-sum">{r.summary} <span className="warn">Body numbers are simulated.</span></p>
      </header>

      <dl className="report-big">
        <div><dt>Time out</dt><dd>{dur(n.minutes)}</dd></div>
        <div><dt>Distance</dt><dd>{km(n.distanceM)}</dd></div>
        <div className={n.peakBpm > 0.7 * HR_MAX ? "hot" : undefined}><dt>Highest heart rate</dt><dd>{Math.round(n.peakBpm)}<small> beats a minute</small></dd></div>
        <div><dt>Energy used</dt><dd>{Math.round(n.kcal)}<small> kcal</small></dd></div>
        <div className={n.suitLeft < 0.2 ? "hot" : undefined}><dt>Suit oxygen left</dt><dd>{Math.round(n.suitLeft * 100)}<small>%</small></dd></div>
        <div className={n.dust > 0.7 ? "hot" : undefined}><dt>Dust on the suit</dt><dd>{Math.round(n.dust * 100)}<small>%</small></dd></div>
      </dl>

      <div className="report-cols">
        <section className="report-learn">
          <h3>What we learned</h3>
          <ol>{r.lessons.map((l) => <li key={l}>{l}</li>)}</ol>
          <p className="muted small">These lessons are used when the next trip is planned on this site.</p>
        </section>
        <figure className="report-map">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the trip">
            <image href={`${base}/${meta.texture.file}`} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
            <polyline points={r.path.map(([x, y]) => `${X(x).toFixed(0)},${Y(y).toFixed(0)}`).join(" ")} fill="none" stroke="#fff" strokeWidth={mark * 0.9} strokeLinejoin="round" />
            <polyline points={r.path.map(([x, y]) => `${X(x).toFixed(0)},${Y(y).toFixed(0)}`).join(" ")} fill="none" stroke="#1d4e9e" strokeWidth={mark * 0.45} strokeLinejoin="round" />
            {r.alerts.map((a) => <circle key={a.t + a.text} cx={X(a.x)} cy={Y(a.y)} r={mark * 0.7} fill="#ad2218" stroke="#fff" strokeWidth={mark * 0.2} />)}
            {r.emergency && <path d={`M${X(r.emergency.at[0]) - mark} ${Y(r.emergency.at[1]) - mark}l${2 * mark} ${2 * mark}m0 ${-2 * mark}l${-2 * mark} ${2 * mark}`} stroke="#ad2218" strokeWidth={mark * 0.5} />}
            <rect x={X(r.start[0]) - mark * 0.8} y={Y(r.start[1]) - mark * 0.8} width={mark * 1.6} height={mark * 1.6} fill="#14171a" stroke="#fff" strokeWidth={mark * 0.2} />
            <circle cx={X(r.target[0])} cy={Y(r.target[1])} r={mark} fill="none" stroke="#fff" strokeWidth={mark * 0.35} />
          </svg>
          <figcaption>Square: base. Ring: the place to reach. Red dots: warnings{r.emergency ? ". Red cross: the breakdown" : ""}.</figcaption>
        </figure>
      </div>

      {r.emergency && <section className="report-rescue">
        <h3>{r.emergency.title}</h3>
        <p>{r.emergency.message}</p>
        <table className="values"><tbody>{r.emergency.options.map((o) => <tr key={o.name} className={o.chosen ? "chosen" : undefined}>
          <td>{o.name}{o.chosen && <b> (chosen)</b>}</td><td>{o.why}</td></tr>)}</tbody></table>
        {r.outcome === "lost" && <p className="error">{r.emergency.fix}</p>}
      </section>}

      <div className="report-cols">
        <section>
          <h3>Plan and what happened</h3>
          <table className="values versus"><thead><tr><th /><th>Planned</th><th>Happened</th></tr></thead>
            <tbody>{versus.map(([a, p, h]) => <tr key={a}><td>{a}</td><td>{p}</td><td>{h}</td></tr>)}
              <tr><td>Oxygen breathed</td><td /><td>{Math.round(n.o2Used)} L</td></tr>
              <tr><td>Cooling water used</td><td /><td>{n.waterKg.toFixed(2)} kg</td></tr>
              <tr><td>Radiation</td><td /><td>{(n.doseMsv * 1000).toFixed(1)} µSv</td></tr>
              <tr><td>Tiredness</td><td /><td>{Math.round(n.fatigue * 100)}% of a day's budget</td></tr>
            </tbody></table>
        </section>
        <section>
          <h3>Warnings during the trip</h3>
          {r.alerts.length ? <ol className="report-alerts">{r.alerts.map((a) => <li key={a.t + a.text}><span>{clock(a.t)}</span>{a.text}</li>)}</ol>
            : <p className="muted">None. Every body number stayed in its normal range.</p>}
        </section>
      </div>

      <div className="report-charts">
        <Chart name="Heart rate" now={`highest ${Math.round(n.peakBpm)}`} unit="beats a minute" values={r.series.bpm} times={r.series.t} t={T} limit={0.7 * HR_MAX} />
        <Chart name="Effort" now={`${Math.round(n.kcal)} kcal in all`} unit="W" values={r.series.watts} times={r.series.t} t={T} />
        <Chart name="Suit oxygen left" now={`${Math.round(n.suitLeft * 100)}% at the end`} unit="%" values={r.series.suit} times={r.series.t} t={T} />
        <Chart name="Dust on the suit" now={`${Math.round(n.dust * 100)}% at the end`} unit="%" values={r.series.dust} times={r.series.t} t={T} limit={70} />
      </div>

      <footer>
        <button className="primary" onClick={onClose} ref={(b) => b?.focus({ preventScroll: true })}>Close the report</button>
        <button className="secondary" onClick={save}>Save as a file</button>
      </footer>
    </article>
  </div>;
}

/** List of earlier trips on this site; a click reopens the report. */
export function TripLog({ reports, open, clear }: { reports: TripReport[]; open: (r: TripReport) => void; clear: () => void }) {
  if (!reports.length) return null;
  return <section className="block trip-log">
    <div className="block-head"><h2>Trip reports ({reports.length})</h2><button className="link" onClick={clear}>Clear</button></div>
    <ol>{[...reports].reverse().slice(0, 8).map((r) => <li key={r.id}>
      <button className={TONE[r.outcome]} onClick={() => open(r)}>
        <b>{r.headline}</b>
        <span>{r.mode === "foot" ? "On foot" : "Rover"}, {km(r.numbers.distanceM)}, {new Date(r.when).toLocaleTimeString("en-GB", { timeStyle: "short" })}</span>
      </button></li>)}</ol>
  </section>;
}
