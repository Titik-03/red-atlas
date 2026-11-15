import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/** What the figure is doing. `phase` drives the cycle: metres walked for "walk", seconds for the others. */
export interface Pose { x: number; y: number; z: number; yaw: number; phase: number; kind: "walk" | "stand" | "sample" | "inspect"; visible: boolean }
export const newPose = (): Pose => ({ x: 0, y: 0, z: 0, yaw: 0, phase: 0, kind: "stand", visible: false });

/** Stride length of the walking cycle, metres per step. Visual only. */
const STEP_M = 0.7;

/**
 * A simple suited figure, 1.85 m tall, facing +Z, built from primitives (the team supplied no astronaut model).
 * It reads its pose from a ref every frame, so moving it never re-renders React.
 */
export function Astronaut({ pose, accent = "#ad2218" }: { pose: React.MutableRefObject<Pose>; accent?: string }) {
  const root = useRef<THREE.Group>(null), body = useRef<THREE.Group>(null);
  const hipL = useRef<THREE.Group>(null), hipR = useRef<THREE.Group>(null), kneeL = useRef<THREE.Group>(null), kneeR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null), armR = useRef<THREE.Group>(null), elbL = useRef<THREE.Group>(null), elbR = useRef<THREE.Group>(null);
  const mats = useMemo(() => ({
    suit: new THREE.MeshStandardMaterial({ color: "#d9d2c4", roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: "#5f5a55", roughness: 0.95 }),
    pack: new THREE.MeshStandardMaterial({ color: "#b5ada0", roughness: 0.85 }),
    visor: new THREE.MeshStandardMaterial({ color: "#b98a2e", roughness: 0.25, metalness: 0.8 }),
    mark: new THREE.MeshStandardMaterial({ color: accent, roughness: 0.8 }),
  }), [accent]);

  useFrame(() => {
    const p = pose.current, g = root.current;
    if (!g) return;
    g.visible = p.visible;
    if (!p.visible) return;
    g.position.set(p.x, p.y, p.z); g.rotation.y = p.yaw;
    let hl = 0, hr = 0, kl = 0, kr = 0, al = 0, ar = 0, el = -0.25, er = -0.25, lean = 0.05, drop = 0;
    if (p.kind === "walk") {
      const a = (p.phase / STEP_M) * Math.PI, s = Math.sin(a);
      hl = -0.5 * s; hr = 0.5 * s; kl = 0.7 * Math.max(0, Math.cos(a)); kr = 0.7 * Math.max(0, -Math.cos(a));
      al = 0.35 * s; ar = -0.35 * s; lean = 0.12; drop = -0.03 * Math.abs(s);
    } else if (p.kind === "sample") {          // kneeling, one arm working at the ground
      hl = -1.5; kl = 1.7; hr = -0.2; kr = 1.75; lean = 0.55; drop = 0.42;
      ar = -1.15 + 0.25 * Math.sin(p.phase * 2.2); er = -0.5 - 0.3 * Math.sin(p.phase * 2.2); al = -0.5; el = -0.9;
    } else if (p.kind === "inspect") {         // standing, both hands up at a panel
      al = -1.25 + 0.08 * Math.sin(p.phase * 1.7); ar = -1.1 + 0.2 * Math.sin(p.phase * 2.6); el = -0.6; er = -0.75 - 0.2 * Math.sin(p.phase * 2.6);
      lean = 0.1;
    } else lean = 0.04 + 0.01 * Math.sin(p.phase * 0.9);
    hipL.current!.rotation.x = hl; hipR.current!.rotation.x = hr; kneeL.current!.rotation.x = kl; kneeR.current!.rotation.x = kr;
    armL.current!.rotation.x = al; armR.current!.rotation.x = ar; elbL.current!.rotation.x = el; elbR.current!.rotation.x = er;
    body.current!.rotation.x = lean; body.current!.position.y = -drop;
  });

  const leg = (hip: React.RefObject<THREE.Group>, knee: React.RefObject<THREE.Group>, x: number) =>
    <group ref={hip} position={[x, 0.95, 0]}>
      <mesh position={[0, -0.22, 0]} material={mats.suit}><capsuleGeometry args={[0.095, 0.3, 4, 10]} /></mesh>
      <group ref={knee} position={[0, -0.45, 0]}>
        <mesh position={[0, -0.2, 0]} material={mats.suit}><capsuleGeometry args={[0.085, 0.28, 4, 10]} /></mesh>
        <mesh position={[0, -0.45, 0.05]} material={mats.dark}><boxGeometry args={[0.17, 0.11, 0.32]} /></mesh>
      </group>
    </group>;
  const arm = (sh: React.RefObject<THREE.Group>, el: React.RefObject<THREE.Group>, x: number) =>
    <group ref={sh} position={[x, 1.5, 0]}>
      <mesh position={[0, -0.16, 0]} material={mats.suit}><capsuleGeometry args={[0.075, 0.2, 4, 10]} /></mesh>
      <group ref={el} position={[0, -0.32, 0]}>
        <mesh position={[0, -0.14, 0]} material={mats.suit}><capsuleGeometry args={[0.068, 0.18, 4, 10]} /></mesh>
        <mesh position={[0, -0.31, 0]} material={mats.dark}><sphereGeometry args={[0.08, 10, 8]} /></mesh>
      </group>
    </group>;
  return (
    <group ref={root} visible={false}>
      <group ref={body}>
        {leg(hipL, kneeL, -0.13)}{leg(hipR, kneeR, 0.13)}
        <group position={[0, 0.95, 0]}>
          <mesh position={[0, 0.32, 0]} material={mats.suit}><boxGeometry args={[0.5, 0.64, 0.32]} /></mesh>
          <mesh position={[0, 0.36, -0.27]} material={mats.pack}><boxGeometry args={[0.44, 0.66, 0.22]} /></mesh>
          <mesh position={[0, 0.5, 0.165]} material={mats.mark}><boxGeometry args={[0.2, 0.06, 0.01]} /></mesh>
          <mesh position={[0, 0.3, 0.17]} material={mats.dark}><boxGeometry args={[0.24, 0.2, 0.05]} /></mesh>
          <mesh position={[0, 0.8, 0]} material={mats.suit}><sphereGeometry args={[0.2, 18, 14]} /></mesh>
          <mesh position={[0, 0.8, 0.075]} material={mats.visor}><sphereGeometry args={[0.165, 18, 14, 0, Math.PI * 2, 0.35, 1.5]} /></mesh>
        </group>
        <group position={[0, 0, 0]}>{arm(armL, elbL, -0.32)}{arm(armR, elbR, 0.32)}</group>
      </group>
    </group>
  );
}
