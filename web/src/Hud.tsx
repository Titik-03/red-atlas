import type { TerrainMeta } from "./geo";

export interface Readout { x: number; y: number; elev: number; lat: number; lon: number }

const fmtLat = (v: number) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "N" : "S"}`;
const fmtLon = (v: number) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? "E" : "W"}`;
const fmtElev = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
const LEVEL = { pass: "Pass", warn: "Warn", fail: "Fail" } as const;

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

  return (
    <div className={`hud${props.visible ? " in" : ""}`}>
      <header className="sheet-head">
        <span className="wordmark">RED ATLAS</span>
        <span className="sheet-name">Surface site</span>
        <span className="sheet-datum">Planetocentric latitude, east-positive longitude</span>
      </header>

      <section className="col col-left">
        <div className="title-block">
          <h1 className={meta.site.name.length > 14 ? "long" : undefined}>{meta.site.name}</h1>
          <p>{(meta.extent_m.east - meta.extent_m.west) / 1000} km tile</p>
        </div>

        <fieldset className="group">
          <legend>Resolution</legend>
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
        </fieldset>

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

        <fieldset className="group">
          <legend>Display</legend>
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
        </fieldset>
      </section>

      <aside className="col col-right">
        <section className="block">
          <div className="block-head"><h2>Cursor</h2></div>
          {hover ? <table className="values"><tbody>
            <tr><td>Latitude</td><td>{fmtLat(hover.lat)}</td></tr>
            <tr><td>Longitude</td><td>{fmtLon(hover.lon)}</td></tr>
            <tr><td>Elevation</td><td>{fmtElev(hover.elev)}</td></tr>
          </tbody></table> : <p className="muted">Move over the terrain.</p>}
        </section>

        <section className="block">
          <div className="block-head"><h2>Selected point</h2>
            {pick && <button className="link" onClick={props.clearPick}>Clear</button>}</div>
          {pick ? <table className="values"><tbody>
            <tr><td>Latitude</td><td>{fmtLat(pick.lat)}</td></tr>
            <tr><td>Longitude</td><td>{fmtLon(pick.lon)}</td></tr>
            <tr><td>Elevation</td><td>{fmtElev(pick.elev)}</td></tr>
          </tbody></table> : <p className="muted">Click the terrain to inspect a point.</p>}
          <p className="note">
            Coordinates: planetocentric latitude, east-positive longitude, Mars 2000 sphere
            (R = {meta.body.radius_m.toLocaleString("en-US")} m).<br />
            Elevation: {meta.heightmap.vertical_reference}
          </p>
        </section>

        <section className="block sources">
          <div className="block-head"><h2>Sources</h2></div>
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
        </section>
      </aside>

      <footer className="sheet-foot">
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
        <span className="hint">Left-drag to pan, right-drag to rotate or tilt, wheel to zoom</span>
      </footer>
    </div>
  );
}
