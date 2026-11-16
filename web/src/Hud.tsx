import type { TerrainMeta } from "./geo";
import type { SimState, Timeline } from "./sim";
import type { CamMode } from "./Trip";
import { HR_MAX, type Vitals, type VitalsLog } from "./body";
import { BodyPanel } from "./BodyPanel";
import { fmtVal, type ScalarDef } from "./globeData";
import { ICE_DEPTHS, SITE_FILTERS, type SiteLayer } from "./siteFilters";
import { ROUTE_COLORS, type Emergency, type Safety, type StationSpot } from "./Region";
import { SUIT_HOURS, type Trouble } from "./walkback";
import type { Lessons, TripReport } from "./report";
import { TripLog } from "./Report";
import { useMemo, useState } from "react";
import { explainRoutes, FOOT_RANGE_M, TRAVEL, WEIGHTS, type Route, type Trip } from "./routes";

export interface Readout { x: number; y: number; elev: number; lat: number; lon: number }

const fmtLat = (v: number) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "N" : "S"}`;
const fmtLon = (v: number) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "E" : "W"}`;
const fmtElev = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
const PHASE = { out: "On the way to the target.", work: "Working at the target: taking samples.", back: "On the way back to the station.", wait: "Waiting for help.", done: "Back at the station." } as const;
/** What each filter means for a person, in one line. */
const MEANING: Record<string, string> = {
  elev: "How high the ground is. Climbing costs energy.",
  slope: "How steep the ground is. Steep ground is slow, tiring, and can tip a rover.",
  ice: "Where frozen water may lie under the ground: water to drink and to make oxygen from.",
  dust: "Loose dust and sand. It slows walking, sticks to suits and is unhealthy to breathe.",
  temp: "Where the ground is warmer or colder than around it.",
  wind: "Where the wind hits hardest. Wind carries dust onto the crew.",
  walk: "If the rover breaks down here, can the crew still get home alive?",
};
const LEVEL = { pass: "Pass", warn: "Warn", fail: "Fail" } as const;

/** A 0..1 value relative to the site's own range, as a percentage with the nearer end named. */
const rel = (v: number, low: string, high: string) => `${Math.round(v * 100)}% (${v < 0.35 ? low : v > 0.65 ? high : "middle"})`;

/** Route comparison: one column per route (click to choose), one row per criterion, the best value of each row marked. */
function Compare({ trip, chosen, setChosen, km, dur, walkBack }: {
  walkBack: { o2: number; time: number; blocked: boolean }[] | null; trip: Trip; chosen: number; setChosen: (i: number) => void; km: (m: number) => string; dur: (m: number) => string;
}) {
  const rs = trip.routes, pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  const rows: [string, string, (r: Route) => number | null, (r: Route) => string][] = [
    ["Length", "Along the ground, with the climbs", (r) => r.lengthM, (r) => km(r.lengthM)],
    ["Steepest", "Steepest slope on the way", (r) => r.maxSlopeDeg, (r) => `${r.maxSlopeDeg.toFixed(0)}°`],
    ["Dust", "Mean ground dust index, percent of the site's range", (r) => r.dust, (r) => pct(r.dust)],
    ["Wind", "Mean wind exposure (estimate), 100% = fully exposed", (r) => r.wind, (r) => pct(r.wind)],
    ["Time", "At the assumed speed", (r) => r.minutes, (r) => dur(r.minutes)],
    ["Risk", "Total cost, route A = 100", (r) => r.cost, (r) => `${Math.round((r.cost / rs[0].cost) * 100)}`],
  ];
  const wb = (r: Route) => walkBack?.[rs.indexOf(r)];
  if (walkBack) rows.push(["Walk back", "Longest walk home if the rover fails at the worst point of the route",
    (r) => (wb(r)?.blocked ? Infinity : wb(r)?.time ?? null), (r) => (wb(r)?.blocked ? "none" : dur((wb(r)?.time ?? 0) / 60))]);
  return <table className="compare">
    <thead><tr><th />{rs.map((_, i) => <th key={i}>
      <button aria-pressed={chosen === i} onClick={() => setChosen(i)} title={`Choose route ${"ABCD"[i]}`}>
        <span className="swatch" style={{ background: ROUTE_COLORS[i] }} />{"ABCD"[i]}</button></th>)}</tr></thead>
    <tbody>{rows.filter(([, , f]) => rs.some((r) => f(r) !== null)).map(([name, tip, f, show]) => {
      const lo = Math.min(...rs.map((r) => f(r) ?? Infinity));
      return <tr key={name} title={tip}><td>{name}</td>
        {rs.map((r, i) => <td key={i} className={`${chosen === i ? "on" : ""}${rs.length > 1 && f(r) === lo ? " best" : ""}`}>{show(r)}</td>)}</tr>;
    })}</tbody>
  </table>;
}

/** Elevation profile of a route with three strips under it: slope, dust and wind along the way. */
function Profile({ r, limit, color, km, setProbe }: {
  r: Route; limit: number; color: string; km: (m: number) => string; setProbe: (p: [number, number, number] | null) => void;
}) {
  const [at, setAt] = useState<number | null>(null);
  const { d, slope, dust, wind } = r.profile, n = d.length, total = d[n - 1] || 1, W = 300, H = 56;
  const zs = r.points.map((p) => p[2]), z0 = Math.min(...zs), z1 = Math.max(...zs), span = Math.max(z1 - z0, 1);
  const X = (k: number) => (d[k] / total) * W, Y = (z: number) => H - 3 - ((z - z0) / span) * (H - 8);
  const line = zs.map((z, k) => `${k ? "L" : "M"}${X(k).toFixed(1)} ${Y(z).toFixed(1)}`).join("");
  const strip = (v: number[], y: number, fill: string, scale: number) => v.slice(1).map((_, k) =>
    <rect key={k} x={X(k)} y={y} width={Math.max(0.5, X(k + 1) - X(k))} height={6} fill={fill}
      opacity={Math.min(1, Math.max(0, ((v[k] + v[k + 1]) / 2) * scale))} />);
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect(), want = ((e.clientX - b.left) / b.width) * total;
    let k = 0; for (let i = 1; i < n; i++) if (Math.abs(d[i] - want) < Math.abs(d[k] - want)) k = i;
    setAt(k); setProbe(r.points[k]);
  };
  return <div className="profile">
    <div className="profile-rows"><span>{z1.toFixed(0)} m</span><span>{z0.toFixed(0)} m</span><span>Slope</span><span>Dust</span><span>Wind</span></div>
    <svg viewBox={`0 0 ${W} ${H + 30}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={() => { setAt(null); setProbe(null); }}
      role="img" aria-label="Elevation, slope, dust and wind along the chosen route">
      <path d={`${line}L${W} ${H}L0 ${H}Z`} fill="var(--ink)" opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {strip(slope, H + 3, "var(--red)", 1 / limit)}
      {strip(dust, H + 12, "var(--haze)", 1)}
      {strip(wind, H + 21, "var(--blue)", 1)}
      {at !== null && <line x1={X(at)} x2={X(at)} y1={0} y2={H + 30} stroke="var(--ink)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
    </svg>
    <p className="profile-at">{at === null ? `Station to target, ${km(total)}. Darker strip = steeper, dustier, more exposed.`
      : `${km(d[at])} from the station: ${zs[at].toFixed(0)} m, slope ${slope[at].toFixed(0)}°, dust ${Math.round(dust[at] * 100)}%, wind ${Math.round(wind[at] * 100)}%`}</p>
  </div>;
}

function niceLength(target: number) {
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
}

/** Sheet margins of the surface view: title block and display controls (left), readouts and sources (right),
 *  scale bar and north arrow under the map window. */
export function Hud(props: {
  meta: TerrainMeta; hover: Readout | null; pick: Readout | null;
  azimuthDeg: number; metresPerPx: number;
  exaggeration: number; setExaggeration: (v: number) => void;
  relief: boolean; setRelief: (v: boolean) => void;
  fullDetail: boolean; setFullDetail: (v: boolean) => void;
  clearPick: () => void;
  colorOn: boolean; setColorOn: (v: boolean) => void;
  visible: boolean;
  filter: string | null; setFilter: (v: string | null) => void;
  iceDepth: string; setIceDepth: (v: string) => void;
  opacity: number; setOpacity: (v: number) => void;
  layer: SiteLayer | null; available: (id: string) => boolean; climateBuilt: boolean;
  /** Local slope and the regional globe values at a point of the site. */
  values: (r: Readout) => { slope: number | null; fines: number | null; irDay: number | null; irNight: number | null;
    exposure: number | null; regional: { def: ScalarDef; v: number | null }[] };
  tempMode: "day" | "night"; setTempMode: (m: "day" | "night") => void; tempModes: ("day" | "night")[];
  station: StationSpot | null; placeStation: (r: Readout | null) => void;
  slopeLimit: number; setSlopeLimit: (v: number) => void; hasModel: boolean; viewStation: () => void;
  target: Readout | null; setTarget: (r: Readout | null) => void; trip: Trip | null; chosen: number; setChosen: (i: number) => void;
  /** Point of the chosen route under the cursor on the profile (shown on the terrain). */
  setProbe: (p: [number, number, number] | null) => void;
  /** A trip in progress: its timeline, the crew's state now, and the playback controls. */
  run: Timeline | null; sim: SimState | null; simT: number; startTrip: () => void; endTrip: () => void;
  playing: boolean; setPlaying: (v: boolean) => void; rate: number; setRate: (v: number) => void;
  camMode: CamMode; setCamMode: (m: CamMode) => void;
  vitals: Vitals | null; vitalsLog: VitalsLog | null; tempK: number | null; groundWarm: number | null;
  /** Walk-back safety: go / no-go for the chosen route, the worst walk home per route, a breakdown in progress. */
  safety: Safety | null; walkBack: { o2: number; time: number; blocked: boolean }[] | null; emergency: Emergency | null; trouble: (kind: Trouble) => void;
  reports: TripReport[]; openReport: (r: TripReport) => void; clearReports: () => void;
  lessons: Lessons; useLessons: boolean; setUseLessons: (v: boolean) => void; lessonEffect: string | null; rested: () => void; notice: string | null;
  tank: number; suitHours: number; setSuitHours: (h: number) => void; homeNow: { o2: number; time: number } | null;
  refuges: number; addRefuge: (r: Readout) => void; clearRefuges: () => void;
  crewView: boolean; setCrewView: (v: boolean) => void;
}) {
  const { meta, hover, pick } = props;
  const len = niceLength(props.metresPerPx * 110);
  const barPx = len / props.metresPerPx;
  const { dtm, ortho } = meta.products;
  const res = meta.resolution;
  const ctx = meta.context;
  const checks = meta.validation.checks ?? [];
  const status = meta.validation.status ?? "pass";
  const global = meta.site.profile === "global";
  const fmtM = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2));
  const nWarn = checks.filter((c) => c.level === "warn").length;
  const at = pick ? props.values(pick) : null;
  const tooSteep = at?.slope != null && at.slope > props.slopeLimit;
  const lay = props.layer, trip = props.trip;
  const why = useMemo(() => (trip ? explainRoutes(trip) : []), [trip]);
  const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
  const dur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.max(1, Math.round(min))} min`);

  const stepNow = !props.station ? 0 : !props.target ? 1 : !props.run ? 2 : 3;
  // The few things everyone must see are shown large over the map; the panels keep the detail.
  const v = props.vitals, airLeft = v ? Math.max(0, 1 - v.suitO2 / props.tank) : 1;
  const tone = (bad: boolean, warn: boolean) => (bad ? "bad" : warn ? "warn" : "good");
  const cannotWalk = !!v && (!props.homeNow || props.homeNow.o2 > props.tank - v.suitO2);
  const verdict = trip?.error ? { tone: "bad", head: "No way to get there", text: trip.error }
    : props.safety ? { tone: !props.safety.go ? "bad" : props.safety.zone === "walk" ? "good" : "warn",
        head: !props.safety.go ? "Do not go" : props.safety.zone === "walk" ? "Safe to go" : "Safe to go, with a rescue plan", text: props.safety.text }
    : { tone: "plain", head: "Choose a route", text: "Compare the routes in the panel on the right, then start the trip." };
  const prompt = stepNow === 0 ? { tone: "plain", head: "Choose where to build the station", text: "Click a flat place on the ground, then press “Place the station here”." }
    : stepNow === 1 ? { tone: "plain", head: "Where do you want to go?", text: "Click a place on the ground, then press “Go here”. Under 1 km the crew walks. Further, they take the rover." }
    : verdict;

  return (
    <div className={`hud${props.visible ? " in" : ""}`}>
      {props.visible && !props.crewView && <div className="stage">
        {props.run && props.sim ? <>
          <div className={`stage-card ${props.emergency ? (props.emergency.result === "lost" ? "bad" : "warn") : "plain"}${props.emergency ? " alarm" : ""}`} key={props.emergency ? "e" : props.sim.phase} role="status">
            <p className="stage-step">{props.emergency ? "Emergency" : `Trip under way, route ${"ABCD"[props.chosen]}`}</p>
            <h2>{props.emergency ? props.emergency.title : PHASE[props.sim.phase].replace(/\.$/, "")}</h2>
            <p>{props.emergency ? props.emergency.message : v?.alerts[0] ?? "Everything is normal."}</p>
          </div>
          {v && <dl className="gauges">
            <div className={tone(airLeft < 0.2, airLeft < 0.4)}><dt>Air left in the suit</dt><dd>{Math.round(airLeft * 100)}<small>%</small></dd>
              <i style={{ width: `${airLeft * 100}%` }} /></div>
            <div className={tone(v.bpm > 0.85 * HR_MAX, v.bpm > 0.7 * HR_MAX)}><dt>Heart</dt><dd>{Math.round(v.bpm)}<small> beats/min</small></dd>
              <i style={{ width: `${Math.min(100, (v.bpm / HR_MAX) * 100)}%` }} /></div>
            <div className={tone(v.fatigue > 0.8, v.fatigue > 0.5)}><dt>Tiredness</dt><dd>{Math.round(v.fatigue * 100)}<small>%</small></dd>
              <i style={{ width: `${Math.min(100, v.fatigue * 100)}%` }} /></div>
            <div className={tone(cannotWalk, false)}><dt>Walk home from here</dt><dd>{props.homeNow ? dur(props.homeNow.time / 60) : "No way"}</dd>
              <span>{cannotWalk ? "Not enough air: needs a rescue" : "Enough air to walk"}</span></div>
            <div className="plain"><dt>Trip time left</dt><dd>{dur(Math.max(0, props.run.totalS - props.simT) / 60)}</dd>
              <i style={{ width: `${(props.simT / props.run.totalS) * 100}%` }} /></div>
          </dl>}
        </> : <div className={`stage-card ${prompt.tone}`} key={`${stepNow}${prompt.head}`} role="status">
          <p className="stage-step">Step {stepNow + 1} of 4</p>
          <h2>{prompt.head}</h2>
          <p>{prompt.text}</p>
        </div>}
        {props.notice && <p className="stage-toast" role="alert">{props.notice}</p>}
      </div>}
      <header className="sheet-head">
        <span className="wordmark">RED ATLAS</span>
        <span className="sheet-name">Surface site</span>
        {props.run && <div className="sizes view-switch" role="group" aria-label="View">
          <button aria-pressed={!props.crewView} onClick={() => props.setCrewView(false)}>Map</button>
          <button aria-pressed={props.crewView} onClick={() => props.setCrewView(true)}>Crew</button>
        </div>}
      </header>

      <section className="col col-left">
        <div className="title-block">
          <h1 className={meta.site.name.length > 14 ? "long" : undefined}>{meta.site.name}</h1>
          <p>{(meta.extent_m.east - meta.extent_m.west) / 1000} km tile</p>
        </div>

        <ol className="guide" aria-label="How to use this page">
          {(["Place the station", "Pick a place to go", "Choose a route", "Start the trip and read its report"] as const).map((name, i) => {
            return <li key={name} className={i < stepNow ? "done" : i === stepNow ? "now" : undefined} aria-current={i === stepNow ? "step" : undefined}>{name}</li>;
          })}
        </ol>

        <fieldset className="group">
          <legend>Show on the map</legend>
          <label className="radio"><input type="radio" name="sflt" checked={!props.filter} onChange={() => props.setFilter(null)} /> None (image only)</label>
          {SITE_FILTERS.map((f) => {
            const ok = props.available(f.id);
            return <label key={f.id} className={`radio${ok ? "" : " off"}`}>
              <input type="radio" name="sflt" disabled={!ok} checked={props.filter === f.id} onChange={() => props.setFilter(f.id)} /> {f.name}
            </label>;
          })}
          {props.filter === "ice" && <div className="sizes depth" role="group" aria-label="Ice depth">
            {ICE_DEPTHS.map(([id, label]) =>
              <button key={id} aria-pressed={props.iceDepth === id} onClick={() => props.setIceDepth(id)}>{label}</button>)}
          </div>}
          {props.filter === "temp" && props.tempModes.length > 1 && <div className="sizes depth two" role="group" aria-label="Time of day">
            {props.tempModes.map((m) =>
              <button key={m} aria-pressed={props.tempMode === m} onClick={() => props.setTempMode(m)}>{m === "day" ? "Day" : "Night"}</button>)}
          </div>}
          {props.filter && MEANING[props.filter] && <p className="meaning">{MEANING[props.filter]}</p>}
          {lay && <label className="slider">Opacity <b>{Math.round(props.opacity * 100)}%</b>
            <input type="range" min={0.1} max={1} step={0.05} value={props.opacity} onChange={(e) => props.setOpacity(+e.target.value)} />
          </label>}
          {lay && <details className="fold layer-info">
            <summary>{lay.kind || "About this layer"}{!lay.local && <span className="warn"> (regional)</span>}</summary>
            <p className="muted">{lay.note}</p>
          </details>}
          {!props.climateBuilt && <p className="note">Dust, temperature and wind are built on each computer.
            Run <code>.venv/bin/python pipeline/build_climate.py</code>, then reload.</p>}
        </fieldset>

        <details className="fold group">
          <summary>Resolution</summary>
          <table className="values"><tbody>
            {res ? <>
              <tr><td>Elevation</td><td>{fmtM(res.dem_native_m)} m{res.dem_native_m > meta.heightmap.spacing_m * 1.5
                && `, shown on a ${fmtM(meta.heightmap.spacing_m)} m grid (interpolated)`}</td></tr>
              <tr><td>Imagery</td><td>{fmtM(res.image_native_m)} m per pixel</td></tr>
            </> : <>
              <tr><td>Elevation grid</td><td>{meta.heightmap.spacing_m} m, real terrain</td></tr>
              <tr><td>Imagery</td><td>{meta.texture.pixel_m} m per pixel</td></tr>
            </>}
            {ctx && <tr><td>Surroundings</td><td>{(ctx.extent_m.east - ctx.extent_m.west) / 1000} km
              at {fmtM(ctx.dem_sample_m)} m elevation and {fmtM(ctx.image_native_m)} m imagery, for orientation only</td></tr>}
          </tbody></table>
          {ctx && <p className="note"><span className="outline-key" />Outline: the high-resolution site, where readouts apply.</p>}
        </details>

        {checks.length > 0 && <fieldset className="group">
          <legend>Site checks</legend>
          <details className={`site-validation ${status}`}>
            <summary>
              {checks.filter((c) => c.level === "pass").length} of {checks.length} passed
              {status === "warn" && `, ${nWarn} warning${nWarn === 1 ? "" : "s"}`}
            </summary>
            <ul>{checks.map((c) => <li key={c.name} className={c.level}>
              <b>{LEVEL[c.level as keyof typeof LEVEL] ?? c.level}</b>
              <span>{c.name}{c.value && <span className="muted">: {c.value}</span>}</span>
            </li>)}</ul>
          </details>
        </fieldset>}

        <details className="fold group">
          <summary>Display</summary>
          <label className="slider">
            Vertical exaggeration <b>{props.exaggeration.toFixed(1)}×</b>
            {props.exaggeration !== 1 && <span className="warn"> not true scale</span>}
            <input type="range" min={1} max={5} step={0.5} value={props.exaggeration}
                   onChange={(e) => props.setExaggeration(Number(e.target.value))} />
          </label>
          {meta.color?.file && <label className="check">
            <input type="checkbox" checked={props.colorOn} onChange={(e) => props.setColorOn(e.target.checked)} />
            <span>Mars colour <span className="muted small" title={meta.color.method}>Colour from the Viking mosaic
              ({Math.round(meta.color.native_m)} m, as on the globe), detail from the {global ? "CTX" : "HiRISE"} image.
              Off shows the original grayscale.</span></span>
          </label>}
          <label className="check">
            <input type="checkbox" checked={props.relief} onChange={(e) => props.setRelief(e.target.checked)} />
            <span>Extra relief lighting <span className="muted small">The imagery already contains real sun shading.</span></span>
          </label>
          <label className="check">
            <input type="checkbox" checked={props.fullDetail} onChange={(e) => props.setFullDetail(e.target.checked)} />
            <span>Full mesh detail <span className="muted small">{fmtM(meta.heightmap.spacing_m)} m vertices;
              the default is {fmtM(meta.heightmap.spacing_m * 2)} m.</span></span>
          </label>
        </details>
      </section>

      <aside className="col col-right">
        {!props.run && <section className="block">
          <div className="block-head"><h2>Selected point</h2>
            {pick && <button className="link" onClick={props.clearPick}>Clear</button>}</div>
          {pick ? <table className="values"><tbody>
            <tr><td>Position</td><td>{fmtLat(pick.lat)}, {fmtLon(pick.lon)}</td></tr>
            <tr><td>Elevation</td><td>{fmtElev(pick.elev)}</td></tr>
            <tr><td>Slope</td><td>{at?.slope == null ? "edge of the grid" : `${at.slope.toFixed(1)}°`}</td></tr>
            {at?.fines != null && <tr title="THEMIS night infrared, relative to this site"><td>Ground dust</td><td>{rel(at.fines, "rock", "fines")}</td></tr>}
            {at?.exposure != null && <tr title="Estimate: minus the maximum upwind slope"><td>Wind</td><td>{at.exposure > 1 ? "exposed" : at.exposure < -1 ? "sheltered" : "neutral"} (estimate)</td></tr>}
          </tbody></table> : <p className="muted">Click the terrain to inspect a point.</p>}
          {pick && props.station && <button className="primary" onClick={() => props.setTarget(pick)}>Go here from the station</button>}
          {pick && props.station && <button className="secondary" onClick={() => props.addRefuge(pick)} title="An oxygen and shelter cache the crew can walk to instead of the station">Place an emergency refuge here</button>}
          {pick && !props.station && <button className="primary" disabled={tooSteep || at?.slope == null} onClick={() => props.placeStation(pick)}>Place the station here</button>}
          {pick && !props.station && tooSteep && <p className="error">Too steep: {at!.slope!.toFixed(1)}° here, limit {props.slopeLimit}°.</p>}
          {pick && !props.station && at?.slope == null && <p className="error">Too close to the edge of the site to measure the slope.</p>}
          {props.notice && <p className="error">{props.notice}</p>}
          {pick && at && <details className="fold">
            <summary>More values</summary>
            <table className="values"><tbody>
              {at.irDay != null && <tr title="THEMIS day infrared, relative to this site"><td>Ground by day</td><td>{rel(at.irDay, "colder", "warmer")}</td></tr>}
              {at.irNight != null && <tr title="THEMIS night infrared, relative to this site"><td>Ground by night</td><td>{rel(at.irNight, "colder", "warmer")}</td></tr>}
              {at.exposure != null && <tr><td>Wind exposure</td><td>{at.exposure > 0 ? "+" : ""}{at.exposure.toFixed(1)}°</td></tr>}
              {at.regional.map(({ def, v }) => <tr key={def.id} title={def.note}><td>{def.label}</td><td>{fmtVal(def.id, v)}</td></tr>)}
            </tbody></table>
            <p className="note">Slope, ground dust, day and night warmth and wind exposure are local to this site (percent of the
              site's own range). The rows after them are regional (7 km to 300 km cells), as on the globe.</p>
            <p className="note">Coordinates: planetocentric latitude, east-positive longitude, Mars 2000 sphere
              (R = {meta.body.radius_m.toLocaleString("en-US")} m). Elevation: {meta.heightmap.vertical_reference}</p>
          </details>}
        </section>}

        {props.target && trip && <section className="block">
          <div className="block-head"><h2>Trip to the target</h2>
            <button className="link" onClick={() => props.setTarget(null)}>Cancel</button></div>
          <p><b>{TRAVEL[trip.mode].label}</b>, {km(trip.straightM)} in a straight line</p>
          {trip.error && <p className="error">{trip.error}</p>}
          {props.run && props.sim && <>
            {props.emergency ? <>
              <p className="error">Emergency: {props.emergency.title.toLowerCase()}.</p>
              <p className="why">{props.emergency.message}</p>
              <table className="values options"><tbody>{props.emergency.options.map((o) => <tr key={o.name} className={o.chosen ? "chosen" : undefined}>
                <td>{o.name}</td><td>{o.why}</td></tr>)}</tbody></table>
            </> : <p className="why"><b>Route {"ABCD"[props.chosen]}.</b> {PHASE[props.sim.phase]}</p>}
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((props.simT / props.run.totalS) * 100)}>
              <div style={{ width: `${(props.simT / props.run.totalS) * 100}%` }} /></div>
            <p className="profile-at">{(props.run.route.profile.d.at(-1) ?? 0) > 0 && <>{km(props.sim.travelled)} of {km((props.run.oneWay ? 1 : 2) * props.run.route.profile.d[props.run.route.profile.d.length - 1])},{" "}</>}
              {dur(props.simT / 60)} of {dur(props.run.totalS / 60)}{props.sim.speed > 0 && `, ${(props.sim.speed * 3.6).toFixed(1)} km/h on a ${props.sim.slope.toFixed(0)}° slope`}</p>
            <div className="trip-controls">
              <button className="secondary" onClick={() => props.setPlaying(!props.playing)} disabled={props.sim.phase === "done"}>{props.playing ? "Pause" : "Resume"}</button>
              <div className="sizes" role="group" aria-label="Time speed">
                {[1, 10, 60].map((r) => <button key={r} aria-pressed={props.rate === r} onClick={() => props.setRate(r)}>×{r}</button>)}
              </div>
              <div className="sizes" role="group" aria-label="Camera">
                {(["follow", "overview", "free"] as const).map((m) => <button key={m} aria-pressed={props.camMode === m} onClick={() => props.setCamMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
              </div>
            </div>
            {!props.emergency && props.sim.phase !== "done" && <div className="what-if">
              <p className="muted small">What if something goes wrong here?</p>
              {props.run.mode === "rover" ? <>
                <button className="secondary danger" onClick={() => props.trouble("drive")} title="The rover stops but its cabin still holds air">Rover cannot drive</button>
                <button className="secondary danger" onClick={() => props.trouble("leak")} title="The cabin loses its air: the crew must leave in their suits">Rover cabin leaks</button>
              </> : <button className="secondary danger" onClick={() => props.trouble("crew")} title="Hurt or exhausted: walks at half speed">Crew member in trouble</button>}
            </div>}
            <button className="link" onClick={props.endTrip}>{props.sim.phase === "done" ? "Close the trip" : "End the trip"}</button>
          </>}
          {!props.run && trip.routes.length > 0 && <Compare walkBack={props.walkBack} trip={trip} chosen={props.chosen} setChosen={props.setChosen} km={km} dur={dur} />}
          {!props.run && trip.routes[props.chosen] && <>
            <p className="why"><b>Route {"ABCD"[props.chosen]}.</b> {why[props.chosen]}</p>
            <Profile r={trip.routes[props.chosen]} limit={TRAVEL[trip.mode].maxSlopeDeg} color={ROUTE_COLORS[props.chosen]} km={km} setProbe={props.setProbe} />
            {props.lessons.count > 0 && <div className="lessons">
              <label className="check"><input type="checkbox" checked={props.useLessons} onChange={(e) => props.setUseLessons(e.target.checked)} />
                <span><b>Learn from {props.lessons.count} earlier trip{props.lessons.count > 1 ? "s" : ""}</b></span></label>
              {props.useLessons && <>
                <ul>{props.lessons.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                {props.lessonEffect && <p>{props.lessonEffect}</p>}
                {props.lessons.carry && <button className="link" onClick={props.rested}>The crew has rested and cleaned the suit</button>}
                <p className="muted small">These rules are our assumptions. Untick to plan without them.</p>
              </>}
            </div>}
            {props.safety && <p className={`safety ${props.safety.zone}`}>{props.safety.text}</p>}
            <button className="primary" disabled={props.safety ? !props.safety.go : false} onClick={props.startTrip}>Start the trip {trip.mode === "foot" ? "on foot" : "by rover"}</button>
          </>}
          <details className="fold">
            <summary>How routes are chosen</summary>
            <p className="note">Dijkstra's shortest path on a {trip.cellM.toFixed(0)} m grid. Route A has the lowest total cost; B to D
              are the best routes that take a different way. Cost per metre = 1 + {WEIGHTS.slope} × (slope / limit)²
              + {WEIGHTS.dust} × ground dust + {WEIGHTS.wind} × wind exposure + {WEIGHTS.cold} × cold ground by day.
              {!trip.has.dust && " No night infrared here, so dust is not counted."}{!trip.has.wind && " Wind data is not built, so wind is not counted."}</p>
            <p className="note"><span className="warn">Assumptions</span> (ours, not NASA values): the weights; on foot under {FOOT_RANGE_M / 1000} km,
              up to {TRAVEL.foot.maxSlopeDeg}°, {TRAVEL.foot.speedKmh} km/h; rover up to {TRAVEL.rover.maxSlopeDeg}°, {TRAVEL.rover.speedKmh} km/h.</p>
          </details>
        </section>}

        {props.run && !props.crewView && props.vitals && props.vitalsLog && <BodyPanel v={props.vitals} log={props.vitalsLog} tempK={props.tempK} groundWarm={props.groundWarm} tank={props.tank} homeNow={props.homeNow} />}

        {!props.run && <section className="block">
          <div className="block-head"><h2>Station</h2>
            {props.station && <button className="link" onClick={() => props.placeStation(null)}>Remove</button>}</div>
          {!props.station && <p className="muted">Select a point on the terrain, then place the station there.</p>}
          {props.station && <>
            <p>{fmtLat(props.station.lat)}, {fmtLon(props.station.lon)}, slope {props.station.slope.toFixed(1)}°</p>
            <button className="secondary" onClick={props.viewStation}>View the station up close</button>
          </>}
          <details className="fold">
            <summary>Settings</summary>
            {pick && props.station && <button className="secondary" disabled={tooSteep || at?.slope == null} onClick={() => props.placeStation(pick)}>Move the station to the selected point</button>}
            <p className="muted small">Suit life support <span className="warn">assumption</span> (Apollo suits: 4 h, later 8 h)</p>
            <div className="sizes" role="group" aria-label="Suit life support">
              {SUIT_HOURS.map((h) => <button key={h} aria-pressed={props.suitHours === h} onClick={() => props.setSuitHours(h)}>{h} h</button>)}
            </div>
            {props.refuges > 0 && <button className="link" onClick={props.clearRefuges}>Remove the {props.refuges === 1 ? "refuge" : `${props.refuges} refuges`}</button>}
            <label className="slider">Maximum slope for the station <b>{props.slopeLimit}°</b> <span className="warn">assumption</span>
              <input type="range" min={1} max={15} step={1} value={props.slopeLimit} onChange={(e) => props.setSlopeLimit(+e.target.value)} />
            </label>
            <p className="muted small">{props.hasModel ? "Team model: habitat, airlock, cargo and three vehicles, at true size (about 40 m across)."
              : "Stand-in marker. Put the station model at web/public/models/station.glb to show it here."}</p>
          </details>
        </section>}

        {!props.run && <TripLog reports={props.reports} open={props.openReport} clear={props.clearReports} />}

        <details className="fold block sources">
          <summary>Sources</summary>
          {global && meta.sources ? meta.sources.map((s) => <p key={s.role}>
            {s.role === "elevation" ? "Elevation" : "Imagery"}: {s.mission} {s.instrument}, {s.title}
            {s.citation && <> ({s.citation})</>}.
            {s.info && <> <a href={s.info} target="_blank" rel="noreferrer">Source</a></>}
          </p>) : <>
            <p>Elevation: NASA {dtm.mission} {dtm.instrument}, {dtm.title} (USGS, doi:
              <a href={`https://doi.org/${dtm.doi}`} target="_blank" rel="noreferrer">{dtm.doi}</a>).</p>
            <p>Imagery: NASA {ortho.mission} {ortho.instrument}, {ortho.title} (USGS, doi:
              <a href={`https://doi.org/${ortho.doi}`} target="_blank" rel="noreferrer">{ortho.doi}</a>).</p>
            <p>Credit: NASA/JPL-Caltech/University of Arizona/USGS.</p>
          </>}
        </details>
      </aside>

      <footer className="sheet-foot">
        {lay && <div className="legend">
          <div className="legend-title">{lay.name}<span className="badge">{lay.local ? "local" : "regional"}</span></div>
          {lay.classes ? <div className="legend-classes">{lay.classes.map(([c, name]) => <span key={name}><i style={{ background: c }} />{name}</span>)}</div> : <>
          <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${lay.legend.join(",")})` }} />
          <div className="legend-scale">{lay.ends
            ? <><span>{lay.ends[0]}{lay.units && ` (${lay.min} ${lay.units})`}</span><span>{lay.ends[1]}{lay.units && ` (+${lay.max} ${lay.units})`}</span></>
            : <><span>{lay.min} {lay.units}</span><span>{lay.max} {lay.units}</span></>}</div></>}
        </div>}
        <div className="scalebar">
          <div className="bar" style={{ width: `${barPx}px` }} />
          <span>{len >= 1000 ? `${len / 1000} km` : `${len} m`} <span className="muted">at view centre</span></span>
        </div>
        <div className="compass" title="North">
          <div className="needle" style={{ transform: `rotate(${props.azimuthDeg}deg)` }}>
            <svg width="14" height="28" viewBox="0 0 14 28" aria-hidden="true">
              <path d="M7 0 L13 27 L7 21 Z" fill="var(--ink)" />
              <path d="M7 0 L1 27 L7 21 Z" fill="none" stroke="var(--ink)" strokeWidth="1" />
            </svg>
          </div>
          <span>North</span>
        </div>
        {hover && <span className="cursor-at">{fmtLat(hover.lat)}, {fmtLon(hover.lon)}, {fmtElev(hover.elev)}</span>}
        <span className="hint">Left-drag to pan, right-drag to rotate or tilt, wheel to zoom</span>
      </footer>
    </div>
  );
}
