import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MapControls } from "@react-three/drei";
import * as THREE from "three";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { ContextTerrain, Terrain, TileOutline } from "./Terrain";
import { loadTerrain, localToLatLon, pickHeightfield, type Terrain as TerrainData } from "./geo";
import { Hud, type Readout } from "./Hud";
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

export default function Region({ base }: { base: string }) {
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
        <ambientLight intensity={relief ? 0.55 : 1} />
        {/* Light from the west-northwest, high in the sky; only used in "relief lighting" mode. */}
        <directionalLight position={[-4000 * k, 3000 * k, -1500 * k]} intensity={relief ? 1.6 : 0} />
        <Suspense fallback={null}>
          <Terrain data={data} base={base} stride={fullDetail ? 1 : 2} exaggeration={exaggeration} relief={relief} colorOn={colorOn} />
          {ctx && <>
            <ContextTerrain data={data} base={base} exaggeration={exaggeration} relief={relief} colorOn={colorOn} />
            <TileOutline data={data} exaggeration={exaggeration} />
          </>}
          <Ready onReady={() => setReady(true)} />
        </Suspense>
        {pick && <Marker data={data} pick={pick} exaggeration={exaggeration} scale={Math.max(1, Math.sqrt(k))} />}
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
      />
      <Veil opacity={ready ? 0 : 1} label="Preparing the surface" progress={null} sub="uploading imagery to the GPU" />
    </>
  );
}
