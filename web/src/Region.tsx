import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, MapControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { ContextTerrain, Terrain, TileOutline } from "./Terrain";
import { loadTerrain, localToLatLon, pickHeightfield, sampleElevation, type Terrain as TerrainData } from "./geo";
import { loadGlobeMeta, loadScalar } from "./globeData";
import { buildSiteLayer, groundFines, infrared, regionalWind, siteSlope, windExposure, type Globe } from "./siteFilters";
import { Hud, type Readout } from "./Hud";
import { planRoutes, type Trip } from "./routes";
import { buildTimeline, stateAt, type Timeline } from "./sim";
import { Life, type BasePoint, type CamMode, type RoverPart, type SimClock } from "./Trip";
import { Veil } from "./Veil";

/** Converts pointer events into heightfield picks (hover + click, drags ignored). */
function Picker({ data, exaggeration, onHover, onPick }: {
  data: TerrainData; exaggeration: number;
  onHover: (r: Readout | null) => void; onPick: (r: Readout | null) => void;
}) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    let raf = 0;
    const pick = (e: PointerEvent): Readout | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = pickHeightfield(data, exaggeration, ray.ray.origin, ray.ray.direction);
      if (!hit) return null;
      const { lat, lon } = localToLatLon(data.meta, hit.x, hit.y);
      return { x: hit.x, y: hit.y, elev: hit.elev, lat, lon };
    };
    const move = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; onHover(pick(e)); });
    };
    const pdown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const pup = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && e.button === 0) onPick(pick(e));
      down = null;
    };
    const leave = () => onHover(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", pdown);
    el.addEventListener("pointerup", pup);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", pdown);
      el.removeEventListener("pointerup", pup);
      el.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, [camera, gl, data, exaggeration, onHover, onPick]);
  return null;
}

// Mars daytime sky / dust haze colour used for the background and the distance fog (visual only).
const SKY = "#b88a66";

/** Keeps the orbit target inside the area covered by data, so the edge of the context ring stays in the haze. */
function TargetClamp({ controls, limit }: { controls: React.RefObject<MapControlsImpl>; limit: number }) {
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    const t = c.target;
    const x = Math.max(-limit, Math.min(limit, t.x)), z = Math.max(-limit, Math.min(limit, t.z));
    if (x !== t.x || z !== t.z) {
      const dx = x - t.x, dz = z - t.z;
      t.set(x, t.y, z);
      c.object.position.x += dx; c.object.position.z += dz;
    }
  });
  return null;
}

/** Fires once everything inside the same Suspense boundary (all textures) has loaded and rendered once. */
function Ready({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => { if (!done.current) { done.current = true; requestAnimationFrame(() => onReady()); } });
  return null;
}

/** Continues the descent from orbit: glide from straight overhead down to the default oblique view. */
function CameraIntro({ controls, start, end, run, onDone }: {
  controls: React.RefObject<MapControlsImpl>; start: THREE.Vector3; end: THREE.Vector3; run: boolean; onDone: () => void;
}) {
  const { camera } = useThree();
  const t = useRef(0);
  const finished = useRef(false);
  useFrame((_, dt) => {
    if (finished.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (run) t.current = reduce ? 1 : Math.min(1, t.current + dt / 2.4);
    const e = 1 - (1 - t.current) ** 3;
    camera.position.lerpVectors(start, end, e);
    controls.current?.update();
    if (t.current >= 1) { finished.current = true; onDone(); }
  });
  return null;
}

/** Publishes camera azimuth and metres-per-pixel at the orbit target for the HUD (north arrow, scale bar). */
function CameraProbe({ controls, onUpdate }: {
  controls: React.RefObject<MapControlsImpl>;
  onUpdate: (azimuthDeg: number, metresPerPx: number) => void;
}) {
  const { camera, size } = useThree();
  const last = useRef(0);
  const prev = useRef({ az: NaN, mpp: 1 });
  useFrame(({ clock }) => {
    const c = controls.current;
    if (!c || clock.elapsedTime - last.current < 0.1) return;
    last.current = clock.elapsedTime;
    const d = camera.position.distanceTo(c.target);
    const fov = (camera as THREE.PerspectiveCamera).fov * Math.PI / 180;
    const az = c.getAzimuthalAngle() * 180 / Math.PI, mpp = (2 * d * Math.tan(fov / 2)) / size.height;
    // Only publish real changes: otherwise the whole HUD re-renders 10x per second while nothing moves.
    if (Math.abs(az - prev.current.az) < 0.05 && Math.abs(mpp - prev.current.mpp) < prev.current.mpp * 0.002) return;
    prev.current = { az, mpp };
    onUpdate(az, mpp);
  });
  return null;
}

function Marker({ data, pick, exaggeration, scale }: { data: TerrainData; pick: Readout; exaggeration: number; scale: number }) {
  const y = (pick.elev - data.meta.heightmap.min) * exaggeration;
  return (
    <group position={[pick.x, y, -pick.y]} scale={scale}>
      <mesh position={[0, 30, 0]}>
        <cylinderGeometry args={[0.8, 0.8, 60, 8]} />
        <meshBasicMaterial color="#ffd166" />
      </mesh>
      <mesh position={[0, 62, 0]}>
        <sphereGeometry args={[4, 16, 16]} />
        <meshBasicMaterial color="#ef476f" />
      </mesh>
    </group>
  );
}

export interface StationSpot { x: number; y: number; lat: number; lon: number; elev: number; slope: number }
/** Settings next to the team's model: web/public/models/station.json. */
interface ModelCfg { scale?: number; rotation_y_deg?: number; y_offset_m?: number; hide?: string[]; footprint_m?: number;
  /** Parts set on the ground one by one; the part that drives on trips; where the crew steps out; the base-activity loop. */
  seat?: string[]; rover?: string; airlock_exit?: [number, number]; base_walk?: [number, number, number][];
  obstacles?: [number, number, number][] }
/** The rover as found in the model: a free copy, its size, and where it is parked (model frame). */
type RoverLocal = Omit<RoverPart, "parked"> & { lx: number; lz: number; fx: number; fz: number };
const DUST = new THREE.Color("#b88a66");
const MODEL_URL = "/models/station.glb";

function StationModel({ cfg, onRover }: { cfg: ModelCfg; onRover: (r: RoverLocal | null) => void }) {
  const { scene } = useGLTF(MODEL_URL);
  const beacons = useRef<THREE.MeshStandardMaterial[]>([]);
  useFrame(({ clock }) => {            // warning beacons flash once per second
    const on = clock.elapsedTime % 1 < 0.18 ? 3 : 0.15;
    for (const m of beacons.current) m.emissiveIntensity = on;
  });
  useEffect(() => {
    if (!scene.userData.prepared) {
      scene.userData.prepared = true;
      const lit: THREE.MeshStandardMaterial[] = [], seen = new Set<THREE.Material>();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh, m = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (!m || !("color" in m)) return;
        if (/Beacon/.test(o.name)) {
          const b = m.clone(); b.emissive = new THREE.Color("#ff8a2a"); mesh.material = b; lit.push(b);
        } else if (!seen.has(m)) { seen.add(m); m.color.lerp(DUST, 0.14); }      // a film of dust, like everything on Mars
      });
      scene.userData.beacons = lit;
      // The rover that goes on trips leaves the static model and becomes a part of its own.
      const node = cfg.rover ? scene.getObjectByName(cfg.rover) : undefined;
      if (node) {
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(node.quaternion), copy = node.clone(true);
        copy.position.set(0, 0, 0); copy.quaternion.identity(); copy.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(copy);
        let wheelR = 0.9, halfTrack = 1.5;
        copy.traverse((o) => { if (/WheelFL$/.test(o.name)) {
          const wb = new THREE.Box3().setFromObject(o); wheelR = (wb.max.y - wb.min.y) / 2; halfTrack = Math.abs(o.position.x);
        } });
        node.visible = false;
        scene.userData.rover = { object: copy, lift: -box.min.y, wheelR, halfTrack, lx: node.position.x, lz: node.position.z, fx: f.x, fz: f.z } satisfies RoverLocal;
      }
    }
    beacons.current = scene.userData.beacons ?? [];
    onRover(scene.userData.rover ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);
  useEffect(() => {
    // The export carries its own ground plane and helper objects: hide them, the real terrain is the ground.
    for (const name of cfg.hide ?? []) { const o = scene.getObjectByName(name); if (o) o.visible = false; }
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      if (m && "transmission" in m && m.transmission > 0) {   // real refraction costs a second render pass
        m.transmission = 0; m.transparent = true; m.opacity = 0.45;
      }
    });
  }, [scene, cfg]);
  return <primitive object={scene} scale={cfg.scale ?? 1} position={[0, cfg.y_offset_m ?? 0, 0]}
    rotation={[0, ((cfg.rotation_y_deg ?? 0) * Math.PI) / 180, 0]} />;
}

/** Sets the free-standing parts of the model on the real ground one by one (the model as a whole lies on the mean
 *  ground plane; containers, the utility rover and equipment follow the bumps under them). */
function Seat({ data, spot, exaggeration, cfg, quat }: { data: TerrainData; spot: StationSpot; exaggeration: number; cfg: ModelCfg; quat: THREE.Quaternion }) {
  const { scene } = useGLTF(MODEL_URL);
  useEffect(() => {
    for (const name of cfg.seat ?? []) {
      const o = scene.getObjectByName(name);
      if (!o) continue;
      o.userData.y0 ??= o.position.y;
      const real = sampleElevation(data, spot.x + o.position.x, spot.y - o.position.z);
      const plane = new THREE.Vector3(o.position.x, 0, o.position.z).applyQuaternion(quat).y;
      o.position.y = o.userData.y0 + (real === null ? 0 : (real - spot.elev) * exaggeration - plane);
    }
  }, [scene, data, spot, exaggeration, cfg, quat]);
  return null;
}

/** The station at its chosen spot: the team's glTF model when present, otherwise a plain stand-in marker.
 *  It is tilted to the mean ground plane under its footprint, so it sits on the slope instead of floating. */
function Station({ data, spot, exaggeration, model, k, onRover }: {
  data: TerrainData; spot: StationSpot; exaggeration: number; model: ModelCfg | null; k: number; onRover: (r: RoverLocal | null) => void;
}) {
  const shadow = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d")!, grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grad.addColorStop(0, "rgba(20,10,5,0.42)"); grad.addColorStop(0.6, "rgba(20,10,5,0.22)"); grad.addColorStop(1, "rgba(20,10,5,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }, []);
  const y = (spot.elev - data.meta.heightmap.min) * exaggeration;
  const quat = useMemo(() => {
    const b = Math.max(model?.footprint_m ?? 40, data.meta.heightmap.spacing_m * 2), h = b / 2;
    const e = sampleElevation(data, spot.x + h, spot.y), w = sampleElevation(data, spot.x - h, spot.y);
    const n = sampleElevation(data, spot.x, spot.y + h), s = sampleElevation(data, spot.x, spot.y - h);
    if (e === null || w === null || n === null || s === null) return new THREE.Quaternion();
    // Scene axes: x east, y up, z south. Ground normal = (-dz/dx, 1, +dz/dnorth) with the vertical exaggeration.
    const nrm = new THREE.Vector3(-((e - w) / b) * exaggeration, 1, ((n - s) / b) * exaggeration).normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
  }, [data, spot, exaggeration, model]);
  const far = Math.max(1, Math.sqrt(k));
  // The beacon and label only help to find the station from far away; up close they would hang over it.
  const beacon = useRef<THREE.Group>(null), here = useMemo(() => new THREE.Vector3(spot.x, y, -spot.y), [spot, y]);
  useFrame(({ camera }) => { if (beacon.current) beacon.current.visible = camera.position.distanceTo(here) > 500; });
  return (
    <group position={[spot.x, y, -spot.y]}>
      <group quaternion={quat}>
        {model && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, 6]} renderOrder={1}>
          <circleGeometry args={[(model.footprint_m ?? 40) * 0.8, 40]} />
          <meshBasicMaterial map={shadow} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
        </mesh>}
        {model ? <Suspense fallback={null}><StationModel cfg={model} onRover={onRover} /><Seat data={data} spot={spot} exaggeration={exaggeration} cfg={model} quat={quat} /></Suspense> : <group scale={far}>
          <mesh position={[0, 4, 0]}><cylinderGeometry args={[9, 9, 8, 24]} /><meshBasicMaterial color="#e7e8e3" /></mesh>
          <mesh position={[0, 9, 0]}><sphereGeometry args={[9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshBasicMaterial color="#c9ccc4" /></mesh>
        </group>}
      </group>
      <group ref={beacon}>
      <mesh position={[0, 30 + 50 * far, 0]} scale={[1, far, 1]}>
        <cylinderGeometry args={[0.3, 0.3, 100, 6]} /><meshBasicMaterial color="#14171a" />
      </mesh>
      <Html center position={[0, 36 + 100 * far, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="site-label">Station</div>
      </Html>
      </group>
    </group>
  );
}

/** Route colours, best first (A to D). Chosen for contrast with the Mars ground and with each other. */
export const ROUTE_COLORS = ["#1d4e9e", "#e2b007", "#0d7d74", "#a3195b"];

/** The proposed routes draped on the terrain (the chosen one thick) and the target flag. */
function Routes({ data, trip, chosen, only, target, exaggeration, k }: {
  data: TerrainData; trip: Trip | null; chosen: number; only: boolean; target: Readout; exaggeration: number; k: number;
}) {
  const far = Math.max(1, Math.sqrt(k)), min = data.meta.heightmap.min;
  const lines = useMemo(() => (trip?.routes ?? []).map((r) =>
    r.points.map(([x, y, z]) => new THREE.Vector3(x, (z - min) * exaggeration + 2.5 * far, -y))), [trip, exaggeration, min, far]);
  // The chosen route is drawn twice (white casing, colour on top); the top copy sits a little higher so they never fight.
  const top = useMemo(() => lines[chosen]?.map((p) => p.clone().setY(p.y + 1.2 * far)), [lines, chosen, far]);
  const ty = (target.elev - min) * exaggeration;
  return <>
    {!only && lines.map((pts, i) => i !== chosen && <Line key={i} points={pts} color={ROUTE_COLORS[i]} lineWidth={2} transparent opacity={0.75} />)}
    {lines[chosen] && <>
      <Line points={lines[chosen]} color="#ffffff" lineWidth={7} />
      <Line points={top!} color={ROUTE_COLORS[chosen]} lineWidth={4} renderOrder={2} />
    </>}
    <group position={[target.x, ty, -target.y]}>
      <mesh position={[0, 20 * far, 0]} scale={[1, far, 1]}><cylinderGeometry args={[0.4, 0.4, 40, 6]} /><meshBasicMaterial color="#14171a" /></mesh>
      <Html center position={[0, 46 * far, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="site-label">Target</div>
      </Html>
    </group>
  </>;
}

/** Glides the camera to a close oblique view of the station each time `tick` changes. */
function FocusStation({ controls, data, spot, exaggeration, tick }: {
  controls: React.RefObject<MapControlsImpl>; data: TerrainData; spot: StationSpot | null; exaggeration: number; tick: number;
}) {
  const { camera } = useThree();
  const anim = useRef<{ t: number; fromP: THREE.Vector3; fromT: THREE.Vector3; toP: THREE.Vector3; toT: THREE.Vector3 } | null>(null);
  useEffect(() => {
    if (!tick || !spot || !controls.current) return;
    const y = (spot.elev - data.meta.heightmap.min) * exaggeration;
    const toT = new THREE.Vector3(spot.x, y + 4, -spot.y);
    anim.current = { t: 0, fromP: camera.position.clone(), fromT: controls.current.target.clone(),
      toP: toT.clone().add(new THREE.Vector3(-55, 32, 62)), toT };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  useFrame((_, dt) => {
    const a = anim.current, c = controls.current;
    if (!a || !c) return;
    a.t = Math.min(1, a.t + dt / 1.6);
    const e = a.t * a.t * (3 - 2 * a.t);
    camera.position.lerpVectors(a.fromP, a.toP, e);
    c.target.lerpVectors(a.fromT, a.toT, e);
    c.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

export default function Region({ base }: { base: string }) {
  const [globe, setGlobe] = useState<Globe | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [iceDepth, setIceDepth] = useState("ice_0_1");
  const [opacity, setOpacity] = useState(0.7);
  const [tempMode, setTempMode] = useState<"day" | "night">("night");
  const [station, setStation] = useState<StationSpot | null>(null);
  const [slopeLimit, setSlopeLimit] = useState(5);
  const [model, setModel] = useState<ModelCfg | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [target, setTarget] = useState<Readout | null>(null);
  const [chosen, setChosen] = useState(0);
  const [probe, setProbe] = useState<[number, number, number] | null>(null);
  const [roverLocal, setRoverLocal] = useState<RoverLocal | null>(null);
  const [run, setRun] = useState<Timeline | null>(null);
  const [simT, setSimT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(10);
  const [camMode, setCamMode] = useState<CamMode>("follow");
  const clock = useRef<SimClock>({ t: 0, rate: 10, playing: true });
  clock.current.rate = rate; clock.current.playing = playing;
  const [ready, setReady] = useState(false);
  const [intro, setIntro] = useState(true);
  const [colorOn, setColorOn] = useState(true);
  const [data, setData] = useState<TerrainData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const [relief, setRelief] = useState(false);
  const [fullDetail, setFullDetail] = useState(false);
  const [hover, setHover] = useState<Readout | null>(null);
  const [pick, setPick] = useState<Readout | null>(null);
  const [cam, setCam] = useState({ az: 0, mpp: 1 });
  const controls = useRef<MapControlsImpl>(null);

  useEffect(() => {
    loadTerrain(base, setProgress).then(setData).catch((e) => setError(String(e)));
  }, [base]);

  // Globe grids for the regional filters and readouts (shared with the globe view, so normally already loaded).
  useEffect(() => {
    let on = true;
    loadGlobeMeta().then(async (meta) => {
      const scalars: Globe["scalars"] = {};
      for (const def of meta.scalars) {
        try { scalars[def.id] = await loadScalar(meta, def); } catch (e) { console.warn(e); }
        if (on) setGlobe({ meta, scalars: { ...scalars } });
      }
    }).catch((e) => console.warn(e));
    // The team's station model is optional: use it when web/public/models/station.glb exists.
    fetch(MODEL_URL, { method: "HEAD" }).then(async (r) => {
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return;
      const cfg = await fetch("/models/station.json").then((j) => (j.ok ? j.json() : {})).catch(() => ({}));
      if (on) setModel(cfg);
    }).catch(() => {});
    return () => { on = false; };
  }, []);

  // The station spot is remembered per site on this computer.
  const stationKey = `red-atlas-station:${base}`;
  useEffect(() => {
    try { const s = localStorage.getItem(stationKey); setStation(s ? JSON.parse(s) : null); } catch { setStation(null); }
  }, [stationKey]);
  const placeStation = (s: StationSpot | null) => {
    setStation(s);
    try { if (s) localStorage.setItem(stationKey, JSON.stringify(s)); else localStorage.removeItem(stationKey); } catch { /* private mode */ }
  };

  const layerId = filter === "ice" ? iceDepth : filter;
  const built = useMemo(() => (data && layerId ? buildSiteLayer(data, layerId, globe, { tempMode }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, layerId, tempMode, globe?.scalars[layerId ?? ""], globe?.scalars.wind_v, globe?.meta]);
  const wind = useMemo(() => (data ? regionalWind(data, globe) : null), [data, globe]);
  // Model frame (x, z in metres around the station centre) to site coordinates.
  const site = useMemo(() => {
    const r = ((model?.rotation_y_deg ?? 0) * Math.PI) / 180, sc = model?.scale ?? 1, c = Math.cos(r), s = Math.sin(r);
    return (lx: number, lz: number) => ({ x: (station?.x ?? 0) + (lx * c + lz * s) * sc, y: (station?.y ?? 0) - (-lx * s + lz * c) * sc });
  }, [model, station]);
  const rover = useMemo<RoverPart | null>(() => {
    if (!roverLocal || !station) return null;
    const p = site(roverLocal.lx, roverLocal.lz), f = site(roverLocal.lx + roverLocal.fx, roverLocal.lz + roverLocal.fz);
    return { ...roverLocal, parked: { ...p, hx: f.x - p.x, hy: f.y - p.y } };
  }, [roverLocal, station, site]);
  const basePoints = useMemo<BasePoint[] | null>(() => (station && model?.base_walk
    ? model.base_walk.map(([lx, lz, w]) => ({ ...site(lx, lz), work: !!w })) : null), [station, model, site]);
  const trip = useMemo(() => {
    if (!data || !station || !target) return null;
    const door = model?.airlock_exit ? site(model.airlock_exit[0], model.airlock_exit[1]) : station;
    return planRoutes(data, wind, station, target, { foot: door, rover: rover?.parked ?? station },
      (model?.obstacles ?? []).map(([lx, lz, r]) => ({ ...site(lx, lz), r: r * (model?.scale ?? 1) })));
  }, [data, wind, station, target, model, site, rover]);
  useEffect(() => { setChosen(0); setRun(null); }, [trip]);
  const startTrip = () => {
    if (!trip?.routes[chosen]) return;
    clock.current.t = 0; setSimT(0); setPlaying(true); setProbe(null);
    setRun(buildTimeline(trip.routes[chosen], trip.mode));
  };
  const sim = useMemo(() => (run ? stateAt(run, simT) : null), [run, simT]);
  const overlay = useMemo(() => {
    if (!built) return null;
    const t = new THREE.DataTexture(built.rgba, built.size, built.size, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }, [built]);
  useEffect(() => () => overlay?.dispose(), [overlay]);

  if (error) return <Veil opacity={1} label="Could not load this terrain" sub={error} />;
  if (!data) return <Veil opacity={1} label="Downloading terrain" progress={progress * 0.85} sub="elevation grid" />;

  const relief0 = data.meta.heightmap.max - data.meta.heightmap.min;
  // Camera, light and marker sizes were tuned for the 4.096 km Jezero tile; scale them with the tile edge.
  const k = (data.meta.extent_m.east - data.meta.extent_m.west) / 4096;
  const ctx = data.context ? data.meta.context : undefined;
  // Half-size of the area with data. Fog hides everything beyond it, so there is never a void at the edge.
  const half = ctx ? (ctx.extent_m.east - ctx.extent_m.west) / 2 : 3000 * k;
  const maxDist = ctx ? Math.min(half * 0.32, 14000 * k) : 12000 * k;
  const camEnd = new THREE.Vector3(-2600 * k, relief0 + 1600 * k, 2400 * k);
  const camStart = new THREE.Vector3(0, Math.min(maxDist * 0.98, camEnd.length() * 2.6), 1);

  return (
    <>
      <Canvas
        camera={{ fov: 50, near: 1, far: half * 3, position: camStart.toArray() }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        dpr={[1, 1.75]}
        onCreated={({ gl }) => gl.setClearColor(SKY)}
      >
        <color attach="background" args={[SKY]} />
        <fog attach="fog" args={[SKY, half * 0.4, half * 0.95]} />
        {/* The unlit terrain ignores lights; with relief off they only light the station model. */}
        <ambientLight intensity={relief ? 0.45 : 0.35} />
        {/* Sky and ground bounce in Mars colours, so the models sit in the same light as the terrain image. */}
        <hemisphereLight args={["#e3c3a4", "#6e4a36", 0.7]} />
        {/* Light from the west-northwest, high in the sky; only used in "relief lighting" mode. */}
        <directionalLight position={[-4000 * k, 3000 * k, -1500 * k]} intensity={relief ? 1.6 : 1.3} />
        <Suspense fallback={null}>
          <Terrain data={data} base={base} stride={fullDetail ? 1 : 2} exaggeration={exaggeration} relief={relief} colorOn={colorOn}
            overlay={overlay} overlayOpacity={opacity} />
          {ctx && <>
            <ContextTerrain data={data} base={base} exaggeration={exaggeration} relief={relief} colorOn={colorOn} />
            <TileOutline data={data} exaggeration={exaggeration} />
          </>}
          <Ready onReady={() => setReady(true)} />
        </Suspense>
        {pick && <Marker data={data} pick={pick} exaggeration={exaggeration} scale={Math.max(1, Math.sqrt(k))} />}
        {target && <Routes data={data} trip={trip} chosen={chosen} only={!!run} target={target} exaggeration={exaggeration} k={k} />}
        {station && <Life data={data} exaggeration={exaggeration} tl={run} clock={clock} camMode={camMode} controls={controls}
          rover={rover} base={model ? basePoints : null} color={ROUTE_COLORS[chosen]} onTick={setSimT} />}
        {probe && target && <mesh position={[probe[0], (probe[2] - data.meta.heightmap.min) * exaggeration + 4 * Math.max(1, Math.sqrt(k)), -probe[1]]}>
          <sphereGeometry args={[5 * Math.max(1, Math.sqrt(k)), 16, 12]} /><meshBasicMaterial color="#ffffff" />
        </mesh>}
        {station && <Station data={data} spot={station} exaggeration={exaggeration} model={model} k={k} onRover={setRoverLocal} />}
        <FocusStation controls={controls} data={data} spot={station} exaggeration={exaggeration} tick={focusTick} />
        <MapControls
          ref={controls}
          enabled={!intro}
          target={[0, relief0 * 0.3, 0]}
          maxPolarAngle={Math.PI / 2 - 0.04}
          minDistance={15}
          maxDistance={maxDist}
          zoomToCursor
          screenSpacePanning={false}
        />
        {ctx && <TargetClamp controls={controls} limit={half * 0.35} />}
        {intro && <CameraIntro controls={controls} start={camStart} end={camEnd} run={ready} onDone={() => setIntro(false)} />}
        <CameraProbe controls={controls} onUpdate={(az, mpp) => setCam({ az, mpp })} />
        <Picker data={data} exaggeration={exaggeration} onHover={setHover} onPick={setPick} />
      </Canvas>
      <Hud
        meta={data.meta}
        hover={hover}
        pick={pick}
        azimuthDeg={cam.az}
        metresPerPx={cam.mpp}
        exaggeration={exaggeration}
        setExaggeration={setExaggeration}
        relief={relief}
        setRelief={setRelief}
        fullDetail={fullDetail}
        setFullDetail={setFullDetail}
        clearPick={() => setPick(null)}
        colorOn={colorOn}
        setColorOn={setColorOn}
        visible={ready}
        filter={filter} setFilter={setFilter} iceDepth={iceDepth} setIceDepth={setIceDepth}
        opacity={opacity} setOpacity={setOpacity} layer={built?.layer ?? null}
        available={(id) => id === "elev" || id === "slope" || (id === "dust" && !!data.thermal?.night)
          || (id === "temp" && !!(data.thermal?.night || data.thermal?.day)) || !!globe?.scalars[id === "ice" ? "ice_0_1" : id]}
        tempMode={tempMode} setTempMode={setTempMode} tempModes={[data.thermal?.day ? "day" : null, data.thermal?.night ? "night" : null].filter(Boolean) as ("day" | "night")[]}
        climateBuilt={!globe || !!globe.meta.climate_period}
        values={(r) => ({
          slope: siteSlope(data, r.x, r.y),
          fines: groundFines(data, r.x, r.y), irDay: infrared(data, "day", r.x, r.y), irNight: infrared(data, "night", r.x, r.y),
          exposure: wind ? windExposure(data, wind, r.x, r.y) : null,
          regional: (globe?.meta.scalars ?? []).filter((d) => d.readout !== false && d.id !== "elev" && d.id !== "slope" && globe!.scalars[d.id])
            .map((d) => ({ def: d, v: globe!.scalars[d.id].at(r.lat, r.lon) })),
        })}
        viewStation={() => setFocusTick((v) => v + 1)}
        target={target} trip={trip} chosen={chosen} setChosen={setChosen} setProbe={setProbe}
        run={run} sim={sim} simT={simT} startTrip={startTrip} endTrip={() => setRun(null)}
        playing={playing} setPlaying={setPlaying} rate={rate} setRate={setRate} camMode={camMode} setCamMode={setCamMode}
        setTarget={(r) => { setTarget(r); if (r) setPick(null); }}
        station={station} slopeLimit={slopeLimit} setSlopeLimit={setSlopeLimit} hasModel={!!model}
        placeStation={(r) => {
          if (!r) { setTarget(null); return placeStation(null); }
          const slope = siteSlope(data, r.x, r.y), elev = sampleElevation(data, r.x, r.y);
          if (slope === null || elev === null) return;
          placeStation({ x: r.x, y: r.y, lat: r.lat, lon: r.lon, elev, slope });
          setPick(null);     // the pick marker would stand inside the station
        }}
      />
      <Veil opacity={ready ? 0 : 1} label="Preparing the surface" progress={null} sub="uploading imagery to the GPU" />
    </>
  );
}
