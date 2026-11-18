import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls, Stars, useTexture } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { Veil } from "./Veil";
import {
  GLOBE_BASE, fmtLat, fmtLonE, fmtVal, latLonToUnit, loadGlobeMeta, loadScalar, unitToLatLon,
  type GlobeMeta, type LayerDef, type ScalarGrid, type Site,
} from "./globeData";

const S = 1.65;                      // scene radius of Mars
const SEG_LON = 1024, SEG_LAT = 512;
const JEZERO = { lat: 18.455, lon: 77.425 };
const SIZES = [10, 20, 40] as const;
const MAX_LAT = 80;   // pipeline/config.yaml global.max_abs_lat
const CONTEXT_KM = 160;   // pipeline/config.yaml global.context.global_edge_m: one surroundings square for every size
/** Camera height that frames the fixed surroundings square with a margin (fov 42 deg): about 75 % of the view height.
 *  The camera then stays put while the size changes, so 10, 20 and 40 km squares are seen at their true relative size. */
const FRAME_ALT_KM = CONTEXT_KM * 1.75;

interface Landing {
  lat: number; lon: number; size: number;
  status: "requesting" | "queued" | "running" | "done" | "error";
  stage?: string; progress?: number; error?: string | null; base?: string;
}

/** POST /api/site, then poll until the site server reports done/error. */
async function requestSite(lat: number, lon: number, size: number, onUpdate: (l: Partial<Landing>) => void,
                           cancelled: () => boolean) {
  const r = await fetch("/api/site", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, size_km: size }),
  }).catch(() => null);
  if (r?.status === 503) {   // the dev server knows why the builder is down (no Python environment, crashed, ...)
    const why = await r.json().catch(() => null);
    if (why?.error) throw new Error(why.error);
  }
  if (!r || r.status === 404 || r.status >= 500)
    throw new Error(location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "The site builder is not responding. Restart `npm run dev` (it starts the builder automatically) and try again."
      : "The site builder is not responding. Try again in a minute, or press Explore terrain to visit Jezero Crater.");
  let st = await r.json();
  let retried = false;
  if (!r.ok) throw new Error(st.error ?? `HTTP ${r.status}`);
  while (!cancelled()) {
    onUpdate({ status: st.status, stage: st.stage, progress: st.progress, error: st.error, base: st.base });
    if (st.status === "done" || st.status === "error") return st;
    await new Promise((res) => setTimeout(res, 400));
    const g = await fetch(`/api/site/${st.id}`).catch(() => null);
    if (!g || g.status >= 500) throw new Error("Lost connection to the site server");
    const next = await g.json().catch(() => null);
    if (!next || !next.status) {
      // Job unknown (server restarted / job dropped): ask for it again once, then give up with a clear error.
      if (retried) throw new Error(next?.error ?? "The site server lost this request");
      retried = true;
      const again = await fetch("/api/site", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon, size_km: size }) }).catch(() => null);
      if (!again || !again.ok) throw new Error("The site server lost this request");
      st = await again.json();
      continue;
    }
    st = next;
  }
  return st;
}

/** Fire-and-forget background build of the selected point (server keeps only the latest queued prefetch). */
function prefetchSite(lat: number, lon: number, size: number) {
  fetch("/api/site", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, size_km: size, prefetch: true }) }).catch(() => {});
}

/** Overall 0..1 progress from the server's per-stage progress (elevation and imagery run in parallel). */
function overallProgress(l: Landing | null): number | null {
  if (!l) return null;
  const f = l.progress ?? 0;
  switch (l.stage) {
    case "queued": return 0.03;
    case "elevation": return 0.05 + 0.1 * f;
    case "imagery": return 0.15 + 0.6 * f;
    case "processing": return 0.78;
    case "context": return 0.85 + 0.1 * f;
    case "done": return 1;
    default: return null;
  }
}

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued", requesting: "Contacting site builder", elevation: "Reading HRSC–MOLA elevation",
  imagery: "Fetching CTX imagery tiles", processing: "Reprojecting and validating", context: "Adding surroundings",
  done: "Ready",
};

function LandCard({ point, inHiRISE, busy, landing, size, setSize, onLand, onHiRISE }: {
  point: Pick; inHiRISE: boolean; busy: boolean; landing: Landing | null; size: number; setSize: (s: number) => void;
  onLand: (size: number) => void; onHiRISE: () => void;
}) {
  const polar = Math.abs(point.lat) > MAX_LAT;
  const active = landing && landing.status !== "error" && landing.status !== "done";
  return <section className="block land">
    <div className="block-head"><h2>Land at this point</h2><span className="muted small">3D surface site</span></div>
    <div className="sizes" role="group" aria-label="Site size">
      {SIZES.map((s) => <button key={s} aria-pressed={size === s} onClick={() => setSize(s)} disabled={busy}>{s} km</button>)}
    </div>
    <button className="primary" onClick={() => onLand(size)} disabled={busy || polar}>
      {active ? "Building the site" : "Land here"}
    </button>
    {polar && <p className="error">Sites are limited to |latitude| ≤ {MAX_LAT}° (local map projection).</p>}
    {active && <div className="build">
      <div className="progress"><div style={{ width: `${Math.round((landing.progress ?? 0) * 100)}%` }} /></div>
      <p className="muted small">{STAGE_LABEL[landing.stage ?? "queued"] ?? landing.stage}</p>
    </div>}
    {landing?.status === "error" && <p className="error">Could not build this site: {landing.error}</p>}
    <p className="footprint-key small"><span className="key-hi" aria-hidden="true" /> {size} × {size} km high-resolution square
      <span className="key-ctx" aria-hidden="true" /> {CONTEXT_KM} km surroundings, the same for every size</p>
    <p className="muted small">Elevation: HRSC–MOLA, 200 m. Imagery: CTX, about 5 m, uncontrolled. Each site is checked against MOLA.</p>
    {inHiRISE && <button className="secondary" onClick={onHiRISE} disabled={busy}>Open the HiRISE site here (1 m DTM)</button>}
  </section>;
}

type Scalars = Record<string, ScalarGrid>;
interface Pick { lat: number; lon: number }
/** A camera flight. `frame` = only zooming to show the chosen square: the app stays usable meanwhile. */
type FlyTo = Pick & { dist: number; dur?: number; frame?: boolean };

/** Scene radius at (lat, lon) including MOLA relief x exaggeration. */
function radiusAt(elev: ScalarGrid | undefined, exag: number, R: number, lat: number, lon: number) {
  return elev ? S * (1 + (exag * elev.smooth(lat, lon)) / R) : S;
}

function buildPlanet(elev: ScalarGrid | undefined, exag: number, R: number) {
  const cols = SEG_LON + 1, rows = SEG_LAT + 1;
  const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
  let p = 0, q = 0;
  for (let r = 0; r < rows; r++) {
    const lat = 90 - (180 * r) / SEG_LAT;
    for (let c = 0; c < cols; c++) {
      const lon = -180 + (360 * c) / SEG_LON;
      const [x, y, z] = latLonToUnit(lat, lon);
      const rad = radiusAt(elev, exag, R, lat, lon);
      pos[p++] = x * rad; pos[p++] = y * rad; pos[p++] = z * rad;
      uv[q++] = (lon + 180) / 360; uv[q++] = (lat + 90) / 180;
    }
  }
  const idx = new Uint32Array(SEG_LON * SEG_LAT * 6);
  let k = 0;
  for (let r = 0; r < SEG_LAT; r++) for (let c = 0; c < SEG_LON; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = b; idx[k++] = d; idx[k++] = e;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function useLayerTexture(layer: LayerDef) {
  const t = useTexture(`${GLOBE_BASE}/${layer.texture}`);
  useEffect(() => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }, [t]);
  return t;
}

function Surface({ geometry, base, overlay, opacity, shaded }: {
  geometry: THREE.BufferGeometry; base: LayerDef; overlay: LayerDef | null; opacity: number; shaded: boolean;
}) {
  const baseTex = useLayerTexture(base);
  return <>
    <mesh geometry={geometry} raycast={() => null}>
      {shaded ? <meshStandardMaterial map={baseTex} roughness={1} metalness={0} />
              : <meshBasicMaterial map={baseTex} />}
    </mesh>
    {overlay && <Suspense fallback={null}><Overlay geometry={geometry} layer={overlay} opacity={opacity} /></Suspense>}
  </>;
}

function Overlay({ geometry, layer, opacity }: { geometry: THREE.BufferGeometry; layer: LayerDef; opacity: number }) {
  const tex = useLayerTexture(layer);
  return <mesh geometry={geometry} scale={1.0006} raycast={() => null} renderOrder={1}>
    <meshBasicMaterial map={tex} transparent opacity={opacity} depthWrite={false}
      polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
  </mesh>;
}

/** Surface-following polyline (lat/lon list), lifted slightly above the relief. */
function SurfaceLine({ pts, color, elev, exag, R, lift = 0.0015, width = 1 }: {
  pts: [number, number][]; color: string; elev?: ScalarGrid; exag: number; R: number; lift?: number; width?: number;
}) {
  const obj = useMemo(() => {
    const arr = new Float32Array(pts.length * 3);
    pts.forEach(([la, lo], i) => {
      const [x, y, z] = latLonToUnit(la, lo);
      const r = radiusAt(elev, exag, R, la, lo) + lift * S;
      arr.set([x * r, y * r, z * r], i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, linewidth: width }));
  }, [pts, elev, exag, R, lift, color, width]);
  useEffect(() => () => { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); }, [obj]);
  return <primitive object={obj} raycast={() => null} />;
}

/** Lat/lon outline of a square local-eqc tile of edge `km` centred on (lat, lon): the pipeline's footprint(),
 *  densified so the edges follow the relief. */
function squareOutline(lat: number, lon: number, km: number, n = 24): [number, number][] {
  const dLat = (km * 500 / R_MARS) * 180 / Math.PI;
  const dLon = dLat / Math.cos(lat * Math.PI / 180);
  const c: [number, number][] = [[lat + dLat, lon - dLon], [lat + dLat, lon + dLon], [lat - dLat, lon + dLon], [lat - dLat, lon - dLon]];
  const pts: [number, number][] = [];
  for (let e = 0; e < 4; e++) {
    const [a, b] = [c[e], c[(e + 1) % 4]];
    for (let i = 0; i < n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  }
  pts.push(c[0]);
  return pts;
}
const R_MARS = 3396190;

/**
 * Where a "Land here" site would be: the high-resolution square at its true size (accent outline over a light fill)
 * and the fixed lower-resolution surroundings square (dashed). Drawn on the relief, like the Jezero tile outline.
 */
function SiteFootprint({ lat, lon, km, elev, exag, R }: {
  lat: number; lon: number; km: number; elev?: ScalarGrid; exag: number; R: number;
}) {
  const lift = 0.0008;
  const pos = (la: number, lo: number, extra = 0) => {
    const [x, y, z] = latLonToUnit(la, lo);
    const r = radiusAt(elev, exag, R, la, lo) + (lift + extra) * S;
    return [x * r, y * r, z * r] as const;
  };
  const objs = useMemo(() => {
    const line = (pts: [number, number][], mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial) => {
      const arr = new Float32Array(pts.length * 3);
      pts.forEach(([la, lo], i) => arr.set(pos(la, lo), i * 3));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const l = new THREE.Line(g, mat);
      if (mat instanceof THREE.LineDashedMaterial) l.computeLineDistances();
      l.renderOrder = 2;
      return l;
    };
    const inner = line(squareOutline(lat, lon, km), new THREE.LineBasicMaterial({ color: "#f28b4a" }));
    const outer = line(squareOutline(lat, lon, CONTEXT_KM, 48), new THREE.LineDashedMaterial({
      color: "#f3ebe1", transparent: true, opacity: 0.75, dashSize: 0.0035, gapSize: 0.0025 }));
    // Fill: a small grid over the square so it follows the relief.
    const n = 12, dLat = (km * 500 / R_MARS) * 180 / Math.PI, dLon = dLat / Math.cos(lat * Math.PI / 180);
    const v = new Float32Array((n + 1) * (n + 1) * 3), idx: number[] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++)
      v.set(pos(lat + dLat - 2 * dLat * i / n, lon - dLon + 2 * dLon * j / n, -0.0002), (i * (n + 1) + j) * 3);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.BufferAttribute(v, 3));
    fg.setIndex(idx);
    const fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: "#f28b4a", transparent: true, opacity: 0.2,
      depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    fill.renderOrder = 1;
    return [fill, outer, inner];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, km, elev, exag, R]);
  useEffect(() => () => objs.forEach((o) => { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }), [objs]);
  const dLat = (km * 500 / R_MARS) * 180 / Math.PI;
  const tag = pos(lat + dLat, lon + dLat / Math.cos(lat * Math.PI / 180));
  const cLat = (CONTEXT_KM * 500 / R_MARS) * 180 / Math.PI;
  const ctxTag = pos(lat - cLat, lon + cLat / Math.cos(lat * Math.PI / 180));
  return <>
    {objs.map((o) => <primitive key={o.uuid} object={o} raycast={() => null} />)}
    <Html position={tag as unknown as [number, number, number]} zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
      <div className="footprint-tag">{km} × {km} km</div>
    </Html>
    <Html position={ctxTag as unknown as [number, number, number]} zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
      <div className="footprint-tag ctx">{CONTEXT_KM} km surroundings</div>
    </Html>
  </>;
}

function Graticule({ elev, exag, R }: { elev?: ScalarGrid; exag: number; R: number }) {
  const lines = useMemo(() => {
    const out: { pts: [number, number][]; major: boolean }[] = [];
    for (let lon = -180; lon < 180; lon += 30) {
      const pts: [number, number][] = [];
      for (let lat = -90; lat <= 90; lat += 1) pts.push([lat, lon]);
      out.push({ pts, major: lon === 0 });
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: [number, number][] = [];
      for (let lon = -180; lon <= 180; lon += 1) pts.push([lat, lon]);
      out.push({ pts, major: lat === 0 });
    }
    return out;
  }, []);
  return <>{lines.map((l, i) =>
    <SurfaceLine key={i} pts={l.pts} color={l.major ? "#ffd7b8" : "#ffffff"} elev={elev} exag={exag} R={R} lift={0.002} />)}</>;
}

function SiteMarker({ site, elev, exag, R, selected, onSelect }: {
  site: Site; elev?: ScalarGrid; exag: number; R: number; selected: boolean; onSelect: (s: Site) => void;
}) {
  const { camera } = useThree();
  const label = useRef<HTMLDivElement>(null);
  const [x, y, z] = latLonToUnit(site.lat, site.lon);
  const r = radiusAt(elev, exag, R, site.lat, site.lon);
  const pos = new THREE.Vector3(x * r, y * r, z * r);
  const n = useMemo(() => new THREE.Vector3(x, y, z), [x, y, z]);
  useFrame(() => {
    // Hide labels on the far side of the planet.
    const facing = n.dot(camera.position.clone().sub(pos).normalize()) > 0.05;
    if (label.current) label.current.style.opacity = facing ? "1" : "0";
  });
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (n.dot(camera.position.clone().sub(pos).normalize()) > 0.05) onSelect(site);
  };
  const isM20 = site.id === "perseverance";
  return <group position={pos}>
    <mesh onClick={click}>
      <sphereGeometry args={[selected ? 0.014 : 0.01, 16, 16]} />
      <meshBasicMaterial color={isM20 ? "#ffd166" : "#7fdbff"} />
    </mesh>
    <Html center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
      <div ref={label} className={`site-label${selected ? " selected" : ""}`}>{site.name}</div>
    </Html>
  </group>;
}

/** Pointer -> lat/lon on the relief surface (ray vs. sphere, refined for the local radius). */
function Picker({ elev, exag, R, onHover, onPick }: {
  elev?: ScalarGrid; exag: number; R: number; onHover: (p: Pick | null) => void; onPick: (p: Pick | null) => void;
}) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null, raf = 0;
    const pick = (e: PointerEvent): Pick | null => {
      const b = el.getBoundingClientRect();
      ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      let rad = S, hit: THREE.Vector3 | null = null;
      for (let i = 0; i < 4; i++) {
        const sphere = new THREE.Sphere(new THREE.Vector3(), rad);
        const h = ray.ray.intersectSphere(sphere, new THREE.Vector3());
        if (!h) return hit ? unitToLatLon(hit.x, hit.y, hit.z) : null;
        hit = h;
        const ll = unitToLatLon(h.x, h.y, h.z);
        rad = radiusAt(elev, exag, R, ll.lat, ll.lon);
      }
      return hit ? unitToLatLon(hit.x, hit.y, hit.z) : null;
    };
    const move = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; onHover(pick(e)); });
    };
    const pdown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const pup = (e: PointerEvent) => {
      if (down && e.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) onPick(pick(e));
      down = null;
    };
    const leave = () => onHover(null);
    el.addEventListener("pointermove", move); el.addEventListener("pointerdown", pdown);
    el.addEventListener("pointerup", pup); el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerdown", pdown);
      el.removeEventListener("pointerup", pup); el.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, [camera, gl, elev, exag, R, onHover, onPick]);
  return null;
}

/** Camera flight along a great circle to a lat/lon, then a callback. Also adapts orbit speed to altitude. */
function CameraDirector({ controls, flyTo, onArrive, onProgress }: {
  controls: React.RefObject<OrbitControlsImpl>; flyTo: FlyTo | null; onArrive: () => void;
  onProgress?: (e: number) => void;
}) {
  const { camera } = useThree();
  const anim = useRef<{ from: THREE.Vector3; q0: THREE.Quaternion; q1: THREE.Quaternion; d0: number; d1: number; t: number; dur: number } | null>(null);
  useEffect(() => {
    if (!flyTo) { anim.current = null; return; }
    const from = camera.position.clone().normalize();
    const to = new THREE.Vector3(...latLonToUnit(flyTo.lat, flyTo.lon));
    anim.current = {
      from, q0: new THREE.Quaternion(), q1: new THREE.Quaternion().setFromUnitVectors(from, to),
      d0: camera.position.length(), d1: flyTo.dist, t: 0, dur: flyTo.dur ?? 2.6,
    };
  }, [flyTo, camera]);
  useFrame((_, dt) => {
    const c = controls.current;
    if (c) {
      const alt = camera.position.length() - S;
      c.rotateSpeed = Math.min(1, Math.max(0.02, alt / (S * 1.6)));
      c.zoomSpeed = Math.min(1, Math.max(0.25, alt / S));
    }
    const a = anim.current;
    if (!a) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    a.t = reduce ? 1 : Math.min(1, a.t + dt / a.dur);
    const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
    const q = new THREE.Quaternion().slerpQuaternions(a.q0, a.q1, e);
    camera.position.copy(a.from.clone().applyQuaternion(q).multiplyScalar(a.d0 + (a.d1 - a.d0) * e));
    camera.lookAt(0, 0, 0);
    if (c) { c.target.set(0, 0, 0); c.update(); }
    onProgress?.(e);
    if (a.t >= 1) { anim.current = null; onArrive(); }
  });
  return null;
}

function Legend({ layer }: { layer: LayerDef }) {
  if (!layer.legend) return null;
  const u = layer.units ? ` ${layer.units}` : "";
  return <div className="legend">
    <div className="legend-title">{layer.name}{layer.derived && <span className="badge">derived</span>}</div>
    <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${layer.legend.join(",")})` }} />
    <div className="legend-scale"><span>{layer.min}{u}</span><span>{layer.max}{u}</span></div>
  </div>;
}

/** The six filters. "ice" stands for the three SWIM depth layers; `kind` says what sort of data each one is. */
const FILTERS = [
  { id: "mola", name: "Elevation", kind: "Measured (laser altimeter)" },
  { id: "slope", name: "Slope", kind: "Derived from measured elevation" },
  { id: "ice", name: "Water ice", kind: "Analysis combining several instruments" },
  { id: "dust", name: "Dust", kind: "" },
  { id: "temp", name: "Temperature", kind: "" },
  { id: "wind", name: "Wind", kind: "" },
];
const ICE_DEPTHS: [string, string][] = [["ice_0_1", "0–1 m"], ["ice_1_5", "1–5 m"], ["ice_5", "> 5 m"]];

function LayerInfo({ layer }: { layer: LayerDef }) {
  const kind = layer.data_kind ?? FILTERS.find((f) => f.id === (layer.id.startsWith("ice") ? "ice" : layer.id))?.kind;
  return <div className="layer-info">
    {kind && <p className="kind"><b>Data type</b> {kind}</p>}
    <p>{layer.description}</p>
    <p className="muted">
      {layer.mission}, {layer.instrument}, <code>{layer.product}</code><br />
      {layer.source}. <a href={layer.url} target="_blank" rel="noreferrer">Data</a>, <a href={layer.doc} target="_blank" rel="noreferrer">documentation</a>
    </p>
  </div>;
}


export function Globe({ onExplore, hidden }: {
  /** hidden = a surface site is open: the globe stays mounted (state, textures, geometry kept) but paused. */
  onExplore: (base: string) => void; hidden: boolean;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const [meta, setMeta] = useState<GlobeMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scalars, setScalars] = useState<Scalars>({});
  const [filter, setFilter] = useState<string | null>(null);
  const [iceDepth, setIceDepth] = useState("ice_0_1");
  const [opacity, setOpacity] = useState(0.75);
  const [exag, setExag] = useState(1);
  const [shaded, setShaded] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showSites, setShowSites] = useState(true);
  const [showGuide, setShowGuide] = useState(true);
  const [hover, setHover] = useState<Pick | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTo | null>(null);
  const [rotating, setRotating] = useState(() => typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    let active = true;
    setError(null);
    loadGlobeMeta().then(async (m) => {
      if (!active) return;
      setMeta(m);
      // Elevation first (shapes the globe), then the other readout grids in the background.
      for (const def of [...m.scalars].sort((a) => (a.id === "elev" ? -1 : 1))) {
        try {
          const g = await loadScalar(m, def);
          if (active) setScalars((s) => ({ ...s, [def.id]: g }));
        } catch (e) { console.warn(e); }
      }
    }).catch((e) => active && setError(String(e.message ?? e)));
    return () => { active = false; };
  }, [attempt]);

  const R = meta?.frame.radius_m ?? 3396190;
  const elev = scalars.elev;
  const geometry = useMemo(() => buildPlanet(elev, exag, R), [elev, exag, R]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const base = meta?.layers.find((l) => l.id === "viking");
  const overlayId = filter === "ice" ? iceDepth : filter;
  const overlay = meta?.layers.find((l) => l.id === overlayId) ?? null;
  const legendLayer = overlay ?? (base?.legend ? base : null);
  const readAt = pick ?? hover;

  const tile = meta?.jezero_tile.bounds_deg;
  const tileOutline = useMemo<[number, number][]>(() => tile ? [
    [tile.north, tile.west], [tile.north, tile.east], [tile.south, tile.east], [tile.south, tile.west], [tile.north, tile.west],
  ] : [], [tile]);
  const traverse = useMemo<[number, number][]>(() => meta?.m20_traverse.points.map(([a, b]) => [a, b]) ?? [], [meta]);

  const startCam = useMemo(() => {
    const [x, y, z] = latLonToUnit(15, 70);
    return [x * 5.8, y * 5.8, z * 5.8] as [number, number, number];
  }, []);

  const zoom = (f: number) => {
    const o = controls.current; if (!o) return;
    o.object.position.multiplyScalar(f).clampLength(S * 1.008, 9); o.update();
  };
  const rotate = (d: number) => {
    const o = controls.current; if (!o) return;
    o.setAzimuthalAngle(o.getAzimuthalAngle() + d); o.update();
  };
  // Descent: the camera flight and the site build run in parallel; open the site once both are finished.
  const [arrived, setArrived] = useState(false);
  const [openBase, setOpenBase] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const landToken = useRef(0);
  const target = useRef<Pick | null>(null);
  const opened = useRef(false);     // hand over to the surface view exactly once per landing
  const orbitDist = useRef(5.2);    // camera distance before the descent: returns and failures climb back to it
  const rememberOrbit = () => {
    const d = controls.current?.object.position.length();
    if (d) orbitDist.current = Math.max(d, S * 1.6);
  };
  useEffect(() => {
    if (arrived && openBase && !opened.current) { opened.current = true; onExplore(openBase); }
  }, [arrived, openBase, onExplore]);
  // Veil: fades in during the last part of a descent, stays while the site builds, fades out on ascent/error.
  const [descentE, setDescentE] = useState(0);
  const [descending, setDescending] = useState(false);
  const [returning, setReturning] = useState(false);
  const onFlightProgress = useCallback((e: number) => {
    setDescentE((v) => (Math.abs(v - e) > 0.03 || e === 1 ? e : v));
  }, []);
  // "Back to Mars": the globe was paused just above the site with the veil up. Reset the landing state and
  // climb back to orbit while the veil fades.
  const wasHidden = useRef(false);
  useEffect(() => {
    if (hidden) { wasHidden.current = true; return; }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    landToken.current++;
    setReturning(true); setDescending(false); setArrived(false); setOpenBase(null); setLanding(null); setDescentE(0);
    const t = target.current ?? JEZERO;
    setFlyTo({ lat: t.lat, lon: t.lon, dist: orbitDist.current });
    const id = setTimeout(() => setReturning(false), 120);
    return () => clearTimeout(id);
  }, [hidden]);
  // Background prefetch: build the selected point while the user is still reading the card.
  const [size, setSize] = useState<number>(20);
  useEffect(() => {
    if (hidden || !pick || Math.abs(pick.lat) > MAX_LAT) return;
    const id = setTimeout(() => prefetchSite(pick.lat, pick.lon, size), 600);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, size]);
  useEffect(() => () => { landToken.current++; }, []);
  // Zoom to the chosen place, framing the fixed surroundings square; changing the size does not move the camera.
  // "Clear" climbs back to the earlier view.
  const framed = useRef(false);
  useEffect(() => {
    if (hidden || busyRef.current) return;
    const d = controls.current?.object.position.length() ?? 0;
    if (pick) {
      if (d > S * 1.3) rememberOrbit();
      framed.current = true;
      setRotating(false);
      setFlyTo({ ...pick, frame: true, dur: 1.6, dist: radiusAt(elev, exag, R, pick.lat, pick.lon) + (FRAME_ALT_KM * 1000 / R) * S });
    } else if (framed.current) {
      framed.current = false;
      const c = controls.current?.object.position;
      if (c) { const ll = unitToLatLon(c.x, c.y, c.z); setFlyTo({ ...ll, frame: true, dur: 1.6, dist: orbitDist.current }); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);
  const explore = useCallback(() => {
    landToken.current++; setLanding(null); setArrived(false); setRotating(false);
    opened.current = false; rememberOrbit();
    target.current = JEZERO; setDescending(true); setDescentE(0);
    setOpenBase("/terrain/jezero"); setFlyTo({ ...JEZERO, dist: S * 1.035 });
  }, []);
  const land = useCallback((p: Pick, size: number) => {
    const token = ++landToken.current;
    opened.current = false; rememberOrbit();
    setArrived(false); setOpenBase(null); setRotating(false);
    setLanding({ lat: p.lat, lon: p.lon, size, status: "requesting", stage: "requesting" });
    target.current = p; setDescending(true); setDescentE(0);
    // Descend from the framing view toward the square (the surface view takes over behind the veil).
    setFlyTo({ lat: p.lat, lon: p.lon, dist: radiusAt(elev, exag, R, p.lat, p.lon) + (size * 1200 / R) * S });
    requestSite(p.lat, p.lon, size, (u) => { if (landToken.current === token) setLanding((l) => l && { ...l, ...u }); },
      () => landToken.current !== token)
      .then((st) => {
        if (landToken.current !== token) return;
        if (st.status === "done") setOpenBase(st.base);
        else { setOpenBase(null); setDescending(false); setFlyTo({ lat: p.lat, lon: p.lon, dist: orbitDist.current }); }
      })
      .catch((e) => {
        if (landToken.current !== token) return;
        setLanding((l) => l && { ...l, status: "error", error: String(e.message ?? e) });
        setOpenBase(null); setDescending(false);
        setFlyTo({ lat: p.lat, lon: p.lon, dist: orbitDist.current });   // climb back to where the user was
      });
  }, [elev, exag, R]);
  const flyRef = useRef<FlyTo | null>(null);
  flyRef.current = flyTo;
  const onArrive = useCallback(() => { const f = flyRef.current; setFlyTo(null); if (!f?.frame) setArrived(true); }, []);
  const inTile = (p: Pick | null) => !!(p && tile && p.lat >= tile.south && p.lat <= tile.north && p.lon >= tile.west && p.lon <= tile.east);
  const busy = !!(flyTo && !flyTo.frame) || !!(landing && (landing.status === "requesting" || landing.status === "queued" || landing.status === "running"));
  const busyRef = useRef(false);   // read by canvas event handlers: no selection changes during a flight/landing
  busyRef.current = busy || descending;

  const checksOk = meta?.validation.every((c) => c.ok);

  return <main className="sheet orbital-view" style={hidden ? { visibility: "hidden" } : undefined} aria-hidden={hidden}>
    <div className="planet-stage" role="img" aria-label="Interactive 3D Mars globe with NASA data layers. Drag to rotate, scroll or pinch to zoom.">
      <Canvas camera={{ position: startCam, fov: 42, near: 0.001, far: 200 }} dpr={[1, 2]}
        frameloop={hidden ? "never" : "always"}
        fallback={<div className="globe-status">WebGL is unavailable.</div>}>
        <ambientLight intensity={shaded ? 0.35 : 1} />
        <directionalLight position={[-3, 4, 5]} intensity={shaded ? 2.4 : 0} />
        <Stars radius={80} depth={30} count={1800} factor={2} saturation={0} fade speed={0} />
        {meta && base && <Suspense fallback={null}>
          <Surface geometry={geometry} base={base} overlay={overlay} opacity={opacity} shaded={shaded} />
        </Suspense>}
        {meta && showGrid && <Graticule elev={elev} exag={exag} R={R} />}
        {meta && showSites && meta.sites.map((s) =>
          <SiteMarker key={s.id} site={s} elev={elev} exag={exag} R={R} selected={site?.id === s.id}
            onSelect={(x) => { if (busyRef.current) return; setSite(x); setPick({ lat: x.lat, lon: x.lon }); }} />)}
        {meta && <>
          <SurfaceLine pts={tileOutline} color="#ef476f" elev={elev} exag={exag} R={R} lift={0.0004} />
          <SurfaceLine pts={traverse} color="#ffd166" elev={elev} exag={exag} R={R} lift={0.0003} />
        </>}
        {meta && pick && Math.abs(pick.lat) <= MAX_LAT && !inTile(pick) &&
          <SiteFootprint lat={pick.lat} lon={pick.lon} km={size} elev={elev} exag={exag} R={R} />}
        <Picker elev={elev} exag={exag} R={R} onHover={setHover}
          onPick={(p) => { if (busyRef.current) return; setPick(p); setSite(null); }} />
        <CameraDirector controls={controls} flyTo={flyTo} onArrive={onArrive} onProgress={onFlightProgress} />
        <OrbitControls ref={controls} enablePan={false} minDistance={S * 1.008} maxDistance={9}
          enabled={!flyTo} autoRotate={rotating && !!meta && !flyTo} autoRotateSpeed={0.25}
          enableDamping dampingFactor={0.06} />
      </Canvas>
    </div>

    {meta && showGuide && <div className="stage"><div className="stage-card plain" key={pick ? "picked" : "start"} role="status">
      <div className="block-head">
        <p className="stage-step">{pick ? "Place chosen" : "Start here"}</p>
        <button type="button" className="stage-dismiss" onClick={() => setShowGuide(false)}>Hide guide</button>
      </div>
      <h2>{pick ? "Land here, or pick another place" : "Pick a place on Mars"}</h2>
      <p>{pick ? "Press “Land here” in the panel on the right to see the ground in 3D." : "Drag to turn the planet, then click where you want to land. Or press “Explore terrain” to visit Jezero Crater."}</p>
    </div></div>}

    <header className="sheet-head">
      <a className="wordmark" href="#" onClick={(e) => { e.preventDefault(); controls.current?.reset(); }}>RED ATLAS</a>
      <span className="sheet-name">Science globe</span>
      <span className={`checks${!meta || checksOk ? "" : " bad"}`} title={meta?.validation.map((c) => `${c.ok ? "Pass" : "FAIL"}: ${c.check}`).join("\n")}>
        {meta ? `${meta.validation.filter((c) => c.ok).length} of ${meta.validation.length} data checks passed` : "Loading"}
      </span>
    </header>

    <section className="col col-left">
      <div className="title-block">
        <h1>Mars</h1>
        <p>Where could humans live and work?</p>
      </div>
      <fieldset className="group">
        <legend>Show on the map</legend>
        <label className="radio"><input type="radio" name="flt" checked={!filter} onChange={() => setFilter(null)} /> None (Viking colour)</label>
        {FILTERS.map((f) => {
          const built = !!meta?.layers.some((l) => l.id === (f.id === "ice" ? "ice_0_1" : f.id));
          return <label key={f.id} className={`radio${built ? "" : " off"}`}>
            <input type="radio" name="flt" disabled={!built} checked={filter === f.id} onChange={() => setFilter(f.id)} /> {f.name}
          </label>;
        })}
        {filter === "ice" && <div className="sizes depth" role="group" aria-label="Ice depth">
          {ICE_DEPTHS.map(([id, label]) =>
            <button key={id} aria-pressed={iceDepth === id} onClick={() => setIceDepth(id)}>{label}</button>)}
        </div>}
        {overlay && <label className="slider">Opacity <b>{Math.round(opacity * 100)}%</b>
          <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
        </label>}
        {meta && !meta.climate_period && <p className="note">Dust, temperature and wind are built on each computer.
          Run <code>.venv/bin/python pipeline/build_climate.py</code> (about 180 MB of downloads), then reload.</p>}
        {meta?.climate_public && <p className="note">Temperature and wind are not in the online version: their source,
          OpenMARS, may not be redistributed. Run the project on your computer with <code>npm start</code> to see them.</p>}
      </fieldset>
      <fieldset className="group">
        <legend>Display</legend>
        <label className="check"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> 30° graticule (0° meridian highlighted)</label>
        <label className="check"><input type="checkbox" checked={showSites} onChange={(e) => setShowSites(e.target.checked)} /> NASA landing sites</label>
        <label className="check"><input type="checkbox" checked={shaded} onChange={(e) => setShaded(e.target.checked)} /> Sun shading (visual only)</label>
        <label className="slider">Relief exaggeration <b>{exag}×</b>{exag !== 1 && <span className="warn"> not true scale</span>}
          <input type="range" min={1} max={30} step={1} value={exag} onChange={(e) => setExag(+e.target.value)} />
        </label>
      </fieldset>
      {(overlay ?? base) && <LayerInfo layer={(overlay ?? base)!} />}
    </section>

    <aside className="col col-right">
      <section className="block">
        <div className="block-head"><h2>{pick ? "Selected point" : "Cursor"}</h2>
          {pick && <button className="link" disabled={busy} onClick={() => { setPick(null); setSite(null); }}>Clear</button>}</div>
        {readAt ? <>
          <p className="coords">{fmtLat(readAt.lat)}, {fmtLonE(readAt.lon)}</p>
          <table className="values"><tbody>
            {meta?.scalars.filter((d) => d.readout !== false).map((d) => {
              const masked = d.mask_above_elev_m !== undefined && elev
                && (elev.at(readAt.lat, readAt.lon) ?? -Infinity) > d.mask_above_elev_m;
              return <tr key={d.id} title={d.note} className={masked ? "masked" : undefined}>
                <td>{d.label}</td>
                <td>{!scalars[d.id] ? "loading"
                  : masked ? `masked (terrain > +${d.mask_above_elev_m! / 1000} km, as in SWIM products)`
                  : fmtVal(d.id, scalars[d.id].at(readAt.lat, readAt.lon))}</td>
              </tr>;
            })}
          </tbody></table>
          <p className="note">Values from 0.125° cells (≈7.4 km); elevation above the MOLA areoid.
            {meta?.climate_period && (meta.climate_public
              ? <> Dust comes from 3° maps ({meta.climate_period}), interpolated: a regional value, not a local one.</>
              : <> Dust comes from 3° maps and temperature and wind from a 5° weather model (reanalysis)
                ({meta.climate_period}), interpolated: regional values, not local ones.</>)}</p>
        </> : <p className="muted">Hover or click the globe to read the NASA data at that point.</p>}
      </section>

      {site && <section className="block" key={site.id}>
        <div className="block-head"><h2>Landing site</h2><span className="muted small">{site.year}</span></div>
        <h3 className="feature">{site.name}</h3>
        <p>{fmtLat(site.lat)}, {fmtLonE(site.lon)}</p>
        <p className="muted">MOLA elevation ≈ {site.mola_elev_m.toLocaleString("en-US")} m{site.note ? `. ${site.note}` : ""}</p>
        <p className="muted small">Source: <a href={site.url} target="_blank" rel="noreferrer">{site.source}</a></p>
      </section>}

      {pick && <LandCard point={pick} inHiRISE={inTile(pick)} busy={busy} size={size} setSize={setSize}
        landing={landing && landing.lat === pick.lat && landing.lon === pick.lon ? landing : null}
        onLand={(size) => land(pick, size)} onHiRISE={explore} />}

      <section className="block">
        <div className="block-head"><h2>High-resolution site</h2><span className="muted small">HiRISE, 1 m</span></div>
        <h3 className="feature">Jezero Crater</h3>
        <p>{fmtLat(JEZERO.lat)}, {fmtLonE(JEZERO.lon)}</p>
        <p className="muted">Fly down to the western delta front: 3D terrain from the HiRISE 1 m DTM and 25 cm imagery. On the globe, the red box is the tile and the yellow line is the Perseverance traverse (NASA waypoints).</p>
        <button className="primary" onClick={explore} disabled={!!flyTo}>{flyTo ? "Descending" : "Explore terrain"}</button>
      </section>

      <section className="block about">
        <div className="block-head"><h2>About</h2><span className="muted small">NASA Space Apps</span></div>
        <p>RED ATLAS answers the challenge “Interplanetary Survival Guide: Martian Map”: find where humans could live
          and work on Mars, using open NASA, USGS and ESA data.</p>
        <p className="credit">Project lead <b>Gamal Mohamed Esseddik</b></p>
      </section>
    </aside>

    {!meta && <div className="globe-status" role="status" aria-live="polite">
      {error ? <><p>{error}</p><button onClick={() => setAttempt((v) => v + 1)}>Retry</button></>
             : <><span className="loading-dot" />Loading NASA Mars data layers</>}
    </div>}

    <footer className="sheet-foot">
      {legendLayer ? <Legend layer={legendLayer} /> : <div className="basemap-credit">
        {base && <><b>Base map</b> {base.mission}, {base.product}</>}</div>}
      <div className="map-tools" aria-label="Globe controls">
        <span className="hint">Drag to orbit, scroll to zoom, click to inspect</span>
        <div className="tool-buttons">
          <button aria-label="Rotate globe left" onClick={() => rotate(0.25)}>←</button>
          <button aria-label="Rotate globe right" onClick={() => rotate(-0.25)}>→</button>
          <button aria-label="Zoom in" onClick={() => zoom(0.85)}>+</button>
          <button aria-label="Zoom out" onClick={() => zoom(1.18)}>−</button>
          <button aria-pressed={rotating} onClick={() => setRotating(!rotating)}>{rotating ? "Pause rotation" : "Resume rotation"}</button>
          <button onClick={() => controls.current?.reset()}>Reset view</button>
        </div>
      </div>
    </footer>
    {(() => {
      // Veil opacity: smoothstep over the last 45 % of the descent; fully on while waiting for the build.
      const k = Math.min(1, Math.max(0, (descentE - 0.55) / 0.45));
      const descentVeil = descending ? (arrived ? 1 : k * k * (3 - 2 * k)) : 0;
      const op = Math.max(descentVeil, returning ? 1 : 0);
      const waiting = descending && arrived && !openBase;
      const lbl = landing && landing.status !== "error"
        ? (STAGE_LABEL[landing.stage ?? "queued"] ?? landing.stage) : "Descending";
      return <Veil opacity={op} label={returning ? "Returning to orbit" : waiting || descentVeil > 0.6 ? lbl : undefined}
        progress={returning ? null : landing ? overallProgress(landing) : openBase ? null : undefined}
        sub={landing && !returning ? `${landing.size} km site at ${fmtLat(landing.lat)}, ${fmtLonE(landing.lon)}` : undefined} />;
    })()}
  </main>;
}
