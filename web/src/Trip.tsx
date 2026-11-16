import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { sampleElevation, type Terrain } from "./geo";
import { Astronaut, newPose } from "./Crew";
import { stateAt, type SimState, type Timeline } from "./sim";

/** Simulation clock shared with the panel: seconds since departure, time factor, running or paused. */
export interface SimClock { t: number; rate: number; playing: boolean }
export type CamMode = "follow" | "overview" | "free";
/** The rover taken out of the station model, with what is needed to drive it. */
export interface RoverPart { object: THREE.Object3D; lift: number; wheelR: number; halfTrack: number; parked: { x: number; y: number; hx: number; hy: number } }
/** A point of the base-activity loop, in site-local metres. */
export interface BasePoint { x: number; y: number; work: boolean }

const UP = new THREE.Vector3(0, 1, 0);

/** Orientation of a vehicle on the ground: local -Z along the heading, local +Y along the terrain normal. */
function groundQuat(data: Terrain, ex: number, x: number, y: number, hx: number, hy: number, span: number, out: THREE.Quaternion) {
  const h = Math.max(span, data.meta.heightmap.spacing_m) / 2, z = (px: number, py: number) => sampleElevation(data, px, py);
  const e = z(x + h, y), w = z(x - h, y), n = z(x, y + h), s = z(x, y - h);
  const nrm = e === null || w === null || n === null || s === null ? UP.clone()
    : new THREE.Vector3(-((e - w) / (2 * h)) * ex, 1, ((n - s) / (2 * h)) * ex).normalize();
  const f = new THREE.Vector3(hx, 0, -hy);
  f.addScaledVector(nrm, -f.dot(nrm)).normalize();
  const zAxis = f.negate(), xAxis = new THREE.Vector3().crossVectors(nrm, zAxis).normalize();
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, nrm, zAxis));
}

let puffTexture: THREE.Texture | null = null;
function puffMap() {
  if (puffTexture) return puffTexture;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,0.9)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return (puffTexture = new THREE.CanvasTexture(c));
}
const PUFFS = 18, PUFF_LIFE = 2.2;

/**
 * Everything that moves on the site: the crew on a trip (walking, or the rover driving), the dust the rover raises,
 * the trail left behind, a second astronaut working around the base, and the camera that follows the crew.
 * Positions come from the trip timeline (sim.ts); nothing here is random.
 */
export function Life({ data, exaggeration, tl, clock, camMode, controls, rover, base, color, onTick, stranded, rescue, rescueTl, crewHidden }: {
  data: Terrain; exaggeration: number; tl: Timeline | null; clock: React.MutableRefObject<SimClock>;
  camMode: CamMode; controls: React.RefObject<MapControlsImpl>; rover: RoverPart | null; base: BasePoint[] | null;
  color: string; onTick: (t: number) => void;
  /** Where the trip rover broke down (it stays there); the standby rover and its drive to the crew. */
  stranded: RoverPart["parked"] | null; rescue: RoverPart | null; rescueTl: Timeline | null;
  /** The crew is waiting inside the rover cabin, so no figure is shown. */
  crewHidden: boolean;
}) {
  const { camera } = useThree();
  const min = data.meta.heightmap.min;
  const sy = (x: number, y: number, z?: number) => ((z ?? sampleElevation(data, x, y) ?? min) - min) * exaggeration;
  const crew = useRef(newPose()), worker = useRef(newPose());
  const roverG = useRef<THREE.Group>(null), rescueG = useRef<THREE.Group>(null), label = useRef<THREE.Group>(null);
  const rescueAngle = useRef(0), rescueDist = useRef(0), q2 = useMemo(() => new THREE.Quaternion(), []);
  const actor = useRef(new THREE.Vector3()), prev = useRef<THREE.Vector3 | null>(null);
  const glide = useRef<{ t: number; fromP: THREE.Vector3; fromT: THREE.Vector3; overview: boolean } | null>(null);
  const lastTick = useRef(0), puffAt = useRef(0), puffN = useRef(0), wheelAngle = useRef(0), lastDist = useRef(0);
  const puffs = useRef<(THREE.Sprite | null)[]>([]), puffBorn = useRef<number[]>(Array(PUFFS).fill(-1e9));
  const [trail, setTrail] = useState<THREE.Vector3[][]>([]);
  const [farAway, setFarAway] = useState(false);     // show the "Crew" pointer only from a distance
  const q = useMemo(() => new THREE.Quaternion(), []);

  const wheels = useMemo(() => {
    const list: { o: THREE.Object3D; q0: THREE.Quaternion }[] = [];
    rover?.object.traverse((o) => { if (/Wheel[FMR][LR]$/.test(o.name)) list.push({ o, q0: o.quaternion.clone() }); });
    return list;
  }, [rover]);

  const rescueWheels = useMemo(() => {
    const list: { o: THREE.Object3D; q0: THREE.Quaternion }[] = [];
    rescue?.object.traverse((o) => { if (/Wheel[FMR][LR]$/.test(o.name)) list.push({ o, q0: o.quaternion.clone() }); });
    return list;
  }, [rescue]);

  // Base activity: walk between the points at 1 m/s, work 8 s at each. A fixed loop on the real clock.
  const loop = useMemo(() => {
    if (!base || base.length < 2) return null;
    const legs = base.map((a, i) => { const b = base[(i + 1) % base.length]; return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }; });
    return { legs, total: legs.reduce((s, l) => s + l.len + 8, 0) };
  }, [base]);

  // Camera: glide to the crew (follow) or to the whole route (overview) when the mode or the trip changes.
  useEffect(() => {
    const c = controls.current;
    if (!c || !tl || camMode === "free") { glide.current = null; return; }
    glide.current = { t: 0, fromP: camera.position.clone(), fromT: c.target.clone(), overview: camMode === "overview" };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camMode, tl]);
  useEffect(() => { if (!tl) { setTrail([]); prev.current = null; wheelAngle.current = 0; lastDist.current = 0; } }, [tl]);

  useFrame((state, dt) => {
    const ck = clock.current, now = state.clock.elapsedTime, step = Math.min(dt, 0.1);
    let s: SimState | null = null;
    if (tl) {
      if (ck.playing) ck.t = Math.min(tl.totalS, ck.t + step * ck.rate);
      s = stateAt(tl, ck.t);
    }
    const driving = !!s && tl!.mode === "rover";

    // --- rover: on the trip, or parked at the base
    const g = roverG.current;
    if (g && rover) {
      const p = driving ? { x: s!.x, y: s!.y, hx: s!.hx, hy: s!.hy } : stranded ?? rover.parked;
      groundQuat(data, exaggeration, p.x, p.y, p.hx, p.hy, 4, q);
      g.position.set(p.x, sy(p.x, p.y) + rover.lift, -p.y);
      if (driving && ck.playing && ck.rate <= 10) g.quaternion.slerp(q, 1 - Math.exp(-step * 5)); else g.quaternion.copy(q);
      if (driving) {
        wheelAngle.current -= (s!.travelled - lastDist.current) / rover.wheelR;
        lastDist.current = s!.travelled;
        for (const w of wheels) w.o.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), wheelAngle.current).multiply(w.q0);
      }
    }

    // --- standby rover: parked at the base, or driving out to the crew
    const rg = rescueG.current;
    if (rg && rescue) {
      const rs = rescueTl ? stateAt(rescueTl, ck.t) : null, p = rs ?? rescue.parked;
      groundQuat(data, exaggeration, p.x, p.y, p.hx, p.hy, 3, q2);
      rg.position.set(p.x, sy(p.x, p.y) + rescue.lift, -p.y); rg.quaternion.copy(q2);
      if (rs) {
        rescueAngle.current -= (rs.travelled - rescueDist.current) / rescue.wheelR; rescueDist.current = rs.travelled;
        for (const w of rescueWheels) w.o.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), rescueAngle.current).multiply(w.q0);
      } else rescueDist.current = 0;
    }

    // --- crew on the trip
    const c = crew.current;
    c.visible = !!s && !crewHidden && (tl!.mode === "foot" || s.phase === "work");
    if (s) {
      const side = driving ? rover!.halfTrack + 2.2 : 0;                 // beside the rover when it is parked at the target
      const x = s.x - s.hy * side, y = s.y + s.hx * side;
      c.x = x; c.z = -y; c.y = sy(x, y);
      c.yaw = Math.atan2(s.hx, -s.hy);
      c.kind = s.phase === "work" ? "sample" : s.speed > 0 ? "walk" : "stand";
      c.phase = c.kind === "walk" ? s.travelled : ck.t;
      actor.current.set(s.x, sy(s.x, s.y, s.z), -s.y);
      label.current?.position.copy(actor.current);
    }

    // --- dust behind the rover, stronger on dusty ground (the dust layer along the route)
    if (driving && s!.speed > 0 && ck.playing && now - puffAt.current > 0.12) {
      puffAt.current = now;
      const i = puffN.current++ % PUFFS, sp = puffs.current[i], sideways = (i % 2 ? 1 : -1) * rover!.halfTrack;
      if (sp) {
        const bx = s!.x - s!.hx * 3 - s!.hy * sideways, by = s!.y - s!.hy * 3 + s!.hx * sideways;
        sp.position.set(bx, sy(bx, by) + 0.6, -by); sp.userData.dust = s!.dust; puffBorn.current[i] = now;
      }
    }
    puffs.current.forEach((sp, i) => {
      if (!sp) return;
      const age = (now - puffBorn.current[i]) / PUFF_LIFE;
      sp.visible = age >= 0 && age < 1;
      if (sp.visible) { sp.scale.setScalar(1.5 + 5 * age); sp.material.opacity = 0.55 * (0.25 + 0.75 * (sp.userData.dust ?? 0)) * (1 - age); sp.position.y += step * 0.5; }
    });

    // --- second astronaut around the base
    const w = worker.current;
    w.visible = !!loop;
    if (loop) {
      let t = now % loop.total;
      for (const l of loop.legs) {
        if (t < l.len) {
          const f = t / l.len, x = l.a.x + (l.b.x - l.a.x) * f, y = l.a.y + (l.b.y - l.a.y) * f;
          w.x = x; w.z = -y; w.y = sy(x, y); w.yaw = Math.atan2(l.b.x - l.a.x, -(l.b.y - l.a.y)); w.kind = "walk"; w.phase = t;
          break;
        }
        t -= l.len;
        if (t < 8) { w.x = l.b.x; w.z = -l.b.y; w.y = sy(l.b.x, l.b.y); w.kind = l.b.work ? "inspect" : "stand"; w.phase = t; break; }
        t -= 8;
      }
    }

    // --- camera
    const ctl = controls.current;
    if (ctl && s) {
      const gl = glide.current;
      if (gl) {
        gl.t = Math.min(1, gl.t + step / 1.4);
        const e = gl.t * gl.t * (3 - 2 * gl.t), pts = tl!.route.points;
        let toT = actor.current.clone(), toP: THREE.Vector3;
        if (gl.overview) {
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 120);
          toT = new THREE.Vector3(cx, sy(cx, cy), -cy);
          toP = toT.clone().add(new THREE.Vector3(-0.55, 0.95, 0.7).multiplyScalar(span));
        } else {
          const d = driving ? 30 : 13;
          toP = toT.clone().add(new THREE.Vector3(-s.hx * d + s.hy * d * 0.45, d * 0.5, s.hy * d + s.hx * d * 0.45));
        }
        camera.position.lerpVectors(gl.fromP, toP, e); ctl.target.lerpVectors(gl.fromT, toT, e); ctl.update();
        if (gl.t >= 1) { glide.current = null; prev.current = actor.current.clone(); }
      } else if (camMode === "follow") {               // carry the camera with the crew; the user keeps zoom and angle
        if (prev.current) {
          const d = actor.current.clone().sub(prev.current);
          camera.position.add(d); ctl.target.add(d); ctl.update();
        }
        prev.current = actor.current.clone();
      } else prev.current = null;
    }

    // --- panel and trail, four times per second
    if (tl && s && now - lastTick.current > 0.25) {
      lastTick.current = now;
      onTick(ck.t);
      setFarAway(camera.position.distanceTo(actor.current) > 90);
      const pts = tl.route.points, lift = 0.25, full = s.phase === "back" || s.phase === "done" || s.phase === "work";
      const line: THREE.Vector3[] = [];
      for (let k = 0; k < pts.length && (full || tl.route.profile.d[k] <= s.dist); k++) line.push(new THREE.Vector3(pts[k][0], sy(pts[k][0], pts[k][1], pts[k][2]) + lift, -pts[k][1]));
      if (!full) line.push(new THREE.Vector3(s.x, sy(s.x, s.y, s.z) + lift, -s.y));
      if (line.length < 2) setTrail([]);
      else if (tl.mode === "foot") setTrail([line]);
      else {                                           // two wheel tracks
        const side = (sign: number) => line.map((p, k) => {
          const a = line[Math.max(0, k - 1)], b = line[Math.min(line.length - 1, k + 1)];
          const dx = b.x - a.x, dz = b.z - a.z, h = Math.hypot(dx, dz) || 1;
          return new THREE.Vector3(p.x - (dz / h) * sign * rover!.halfTrack, p.y, p.z + (dx / h) * sign * rover!.halfTrack);
        });
        setTrail([side(1), side(-1)]);
      }
    }
  });

  return <>
    {rover && <group ref={roverG}><primitive object={rover.object} /></group>}
    {rescue && <group ref={rescueG}><primitive object={rescue.object} /></group>}
    <Astronaut pose={crew} accent={color} />
    <Astronaut pose={worker} accent="#1d4e9e" />
    {trail.map((pts, i) => <Line key={i} points={pts} color="#3b2a22" lineWidth={tl?.mode === "foot" ? 2 : 2.5} transparent opacity={0.8}
      dashed={tl?.mode === "foot"} dashSize={0.35} gapSize={0.4} />)}
    {Array.from({ length: PUFFS }, (_, i) => <sprite key={i} ref={(o) => { puffs.current[i] = o; }} visible={false}>
      <spriteMaterial map={puffMap()} color="#c79a76" transparent depthWrite={false} opacity={0} />
    </sprite>)}
    <group ref={label} visible={!!tl && farAway}>
      <mesh position={[0, 14, 0]}><cylinderGeometry args={[0.25, 0.25, 28, 6]} /><meshBasicMaterial color={color} /></mesh>
      {tl && farAway && <Html center position={[0, 34, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}><div className="site-label">Crew</div></Html>}
    </group>
  </>;
}
