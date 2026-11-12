import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  MathUtils,
  MeshStandardMaterial,
  NormalBlending,
  Quaternion,
  SRGBColorSpace,
  type CubeTexture,
  type Group,
  type Mesh,
} from 'three';
import type { QualityTier } from '../environment/quality';
import type { Tone } from '../signals';
import type { CrystalAssets, RockName } from './assets';
import { shardsOf } from './fracture';
import { foilMaterial } from './foil';

/** Small deterministic random from a string, so each crystal keeps its own turn and phase. */
export function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const TONE_ORB: Record<Tone, string | null> = {
  idle: null,
  ok: null,
  warn: '#e8b23a',
  bad: '#ff5a4a',
};

/**
 * The soft light under a crystal on paper: a grey contact shadow and, beneath it, the warm rainbow that the glass
 * throws. At night it is a violet glow instead. A camera-facing sprite behind the crystal.
 */
function haloTexture(dark: boolean): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const blob = (x: number, y: number, r: number, stops: [number, string][]) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [at, col] of stops) grd.addColorStop(at, col);
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
  };
  if (dark) {
    blob(128, 128, 120, [
      [0, 'rgba(150,140,255,0.32)'],
      [0.45, 'rgba(110,100,230,0.09)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
  } else {
    blob(128, 118, 118, [
      [0, 'rgba(70,70,70,0.30)'],
      [0.5, 'rgba(70,70,70,0.10)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
    blob(132, 170, 70, [
      [0, 'rgba(255,236,214,0.9)'],
      [0.35, 'rgba(255,214,190,0.45)'],
      [0.6, 'rgba(206,226,255,0.2)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function Halo({ size, dark, glow }: { size: number; dark: boolean; glow: number }) {
  const texture = useMemo(() => haloTexture(dark), [dark]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite scale={[size, size, 1]} renderOrder={-1}>
      <spriteMaterial
        map={texture}
        transparent
        depthWrite={false}
        opacity={Math.min(1, 0.85 + glow * 0.3)}
        blending={dark ? AdditiveBlending : NormalBlending}
        toneMapped={false}
      />
    </sprite>
  );
}

/** What a crystal is doing: resting, held down (cracking), broken open, or coming back together. */
export type BreakState = 'whole' | 'pressed' | 'broken';

const SHATTER_S = 1.1;
const REFORM_S = 0.9;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const qa = new Quaternion();

/**
 * One crystal: a generated rock of glass holding an emblem, rocking slowly about facing the viewer. Drawn about its
 * base: the rock's centre is `centre` metres above it.
 *
 * Breaking: held down, it trembles and its cracks open (the frost and bend of its surface rise). Opened, it bursts
 * into real pieces (`fracture.ts`) that tumble outward while the emblem drops away; when the visitor comes back,
 * the pieces fly home and it is whole again. Under reduced motion it never breaks.
 */
export function Crystal({
  assets,
  rock,
  emblem,
  scale,
  centre,
  quality,
  dark,
  animate,
  tone = 'idle',
  seed,
  spin = 1,
  still = false,
  state = 'whole',
  spread = 1,
}: {
  assets: CrystalAssets;
  rock: RockName;
  /** The shape held inside; none for a bare shard. */
  emblem?: string;
  scale: number;
  centre: number;
  quality: QualityTier;
  dark: boolean;
  animate: boolean;
  tone?: Tone;
  seed: number;
  spin?: number;
  /** Off-duty worlds: no turning, no bobbing. */
  still?: boolean;
  state?: BreakState;
  /** How far the pieces fly when broken: 1 bursts them away; less opens the glass around the emblem, which stays. */
  spread?: number;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const scene = useThree((s) => s.scene);
  const geometry = assets.rock(rock);
  const material = useMemo(() => foilMaterial({ quality, dark }), [quality, dark]);
  // The fresh fracture faces: the same foil, frosted white, so a broken piece shows a bruise where it split.
  const inside = useMemo(() => foilMaterial({ quality, dark, frost: true }), [quality, dark]);
  useEffect(
    () => () => {
      material.dispose();
      inside.dispose();
    },
    [material, inside],
  );
  const shards = useMemo(() => shardsOf(rock, geometry), [rock, geometry]);
  const inner = useMemo(() => {
    if (!emblem) return null;
    const g = assets.emblem(emblem);
    // Ink in Wake: a dark polished mark that reads through the pale foil, as type reads on paper. In Dream, a pale
    // mark lit from within, which reads against the dark.
    const mat = dark
      ? new MeshStandardMaterial({
          color: new Color('#ffffff'),
          roughness: 0.3,
          metalness: 0,
          emissive: new Color('#b9b2ff'),
          emissiveIntensity: 0.6,
          envMapIntensity: 1.2,
        })
      : new MeshStandardMaterial({
          color: new Color('#15151a'),
          roughness: 0.22,
          metalness: 0.7,
          envMapIntensity: 1.3,
        });
    // The emblem never takes the hover glow: the glass does.
    mat.userData.noGlow = true;
    g.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.material = mat;
    });
    return { group: g, mat };
  }, [assets, emblem, dark]);
  useEffect(() => () => inner?.mat.dispose(), [inner]);

  const body = useRef<Group>(null);
  const whole = useRef<Mesh>(null);
  const pieces = useRef<Group>(null);
  const emblemRef = useRef<Group>(null);
  const orb = TONE_ORB[tone];
  const phase = seed * Math.PI * 2;
  const breakable = animate && !still;
  // 0 whole … 1 fully burst. Moves towards the target over time, so a reform starts from wherever the burst got to.
  const burst = useRef(0);
  const pressedFor = useRef(0);
  const tilt = useRef({ x: 0, y: 0 });

  useEffect(() => invalidate(), [invalidate, material, state]);

  useFrame(({ clock, pointer }, dt) => {
    const b = body.current;
    if (!b) return;
    const t = clock.elapsedTime;
    const cube = scene.environment as CubeTexture | null;
    for (const m of [material, inside]) {
      if (cube) m.uniforms.uEnv!.value = cube;
      m.uniforms.uTime!.value = t;
      // The studio turns slowly round each crystal, so highlights glide across the folds even while it rests.
      m.uniforms.uEnvRot!.value =
        phase + (animate && !still ? Math.sin(t * 0.12 + phase) * 0.6 : 0);
    }
    if (animate && !still) {
      // Leans towards the pointer, on a soft spring: the crystals notice you.
      tilt.current.x = MathUtils.damp(tilt.current.x, -pointer.y * 0.22, 3, dt);
      tilt.current.y = MathUtils.damp(tilt.current.y, pointer.x * 0.32, 3, dt);
      // Rocks gently around facing the viewer, so the emblem stays readable; a slow drift keeps it alive.
      b.rotation.y = Math.sin(t * 0.25 * spin + phase) * 0.38 + tilt.current.y;
      b.rotation.x = 0.1 + Math.sin(t * 0.33 + phase) * 0.12 + tilt.current.x;
      b.rotation.z = -0.12 + Math.sin(t * 0.21 + phase * 2) * 0.1;
      b.position.y = centre + Math.sin(t * 0.8 + phase) * 0.06 * scale;
    }

    // Held down: a tremble that grows, the surface bends and frosts as cracks open.
    const pressing = breakable && state === 'pressed';
    pressedFor.current = pressing ? Math.min(1.5, pressedFor.current + dt) : 0;
    const strain = Math.min(1, pressedFor.current / 1.2);
    if (pressing) {
      const amp = 0.012 + strain * 0.035;
      b.position.x = Math.sin(t * 61) * amp * scale;
      b.position.z = Math.cos(t * 47) * amp * scale * 0.6;
      invalidate();
    } else {
      b.position.x = 0;
      b.position.z = 0;
    }
    material.uniforms.uStrain!.value = strain;

    // Burst and reform.
    // While a page covers the world (no animation) the pieces hold where they are, so coming back plays the mend.
    const goal = state === 'broken' ? 1 : 0;
    const before = burst.current;
    if (still) burst.current = 0;
    else if (!animate) {
      /* frozen */
    } else if (goal > before) burst.current = Math.min(1, before + dt / SHATTER_S);
    else if (goal < before) burst.current = Math.max(0, before - dt / REFORM_S);
    const k = burst.current;
    if (k !== before || (k > 0 && k < 1)) invalidate();

    const broken = k > 0.001;
    if (whole.current) whole.current.visible = !broken;
    if (pieces.current) {
      pieces.current.visible = broken;
      if (broken) {
        const out = goal === 1 ? easeOut(k) : easeInOut(k);
        pieces.current.children.forEach((child, i) => {
          const sh = shards[i];
          if (!sh) return;
          const d = out * 1.4 * spread;
          child.position.set(
            sh.centre.x + sh.dir.x * d,
            sh.centre.y + sh.dir.y * d - out * out * 0.35 * spread,
            sh.centre.z + sh.dir.z * d,
          );
          qa.setFromAxisAngle(sh.axis, out * sh.spin);
          child.quaternion.copy(qa);
        });
      }
    }
    if (emblemRef.current) {
      // A burst drops the emblem; an opening (spread below 1) leaves it standing in the open glass.
      const drop = spread >= 1 ? k : 0;
      const e = 1 - Math.min(1, drop * 1.8);
      emblemRef.current.scale.setScalar(scale * 0.62 * Math.max(0.0001, e));
      emblemRef.current.position.y = -drop * 0.6 * scale;
    }
  });

  return (
    <group>
      <group position={[0, centre - scale * 0.1, -scale * 0.9]}>
        <Halo size={scale * 3.2} dark={dark} glow={tone === 'bad' ? 0.6 : 0} />
      </group>
      <group ref={body} position={[0, centre, 0]} rotation={[0.1, Math.sin(phase) * 0.38, -0.12]}>
        <mesh ref={whole} geometry={geometry} material={material} scale={scale} />
        <group ref={pieces} scale={scale} visible={false}>
          {shards.map((sh, i) => (
            <mesh
              key={i}
              geometry={sh.geometry}
              material={[material, inside]}
              position={[sh.centre.x, sh.centre.y, sh.centre.z]}
            />
          ))}
        </group>
        {inner && (
          <group ref={emblemRef} scale={scale * 0.62}>
            <primitive object={inner.group} />
          </group>
        )}
      </group>
      {orb && (
        <mesh position={[scale * 0.62, centre + scale * 0.55, scale * 0.2]}>
          <sphereGeometry args={[0.07 * Math.max(1, scale), 24, 16]} />
          <meshBasicMaterial color={orb} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}
