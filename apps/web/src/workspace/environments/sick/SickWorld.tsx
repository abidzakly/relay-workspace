import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { Clouds, Smoke, WindClock, Fireflies, Rain } from '../../environment/Atmosphere';
import { Rocks, Trees } from '../../environment/Foliage';
import { hash01 } from '../../environment/placement';
import { DENSITY } from '../../environment/quality';
import { scatter } from '../../environment/scatter';
import { Seat } from '../../environment/Seat';
import { Terrain } from '../../environment/Terrain';
import { Ball, Box, Cone, Cyl } from '../../scene/parts';
import type { SceneryProps } from '../../world/types';
import {
  CABIN,
  inLake,
  KNOLL,
  LAKE,
  PORCH_SEAT,
  SICK_LAYOUT,
  sickGround,
  SPRING,
} from './sickLayout';

/**
 * SICK — the quiet mountain retreat: a log cabin with a porch where the avatar rests under a blanket, warm
 * windows and a fireplace glow, a mountain lake, a steaming hot spring, a meditation garden, pine forest climbing into
 * the mist. Fog drifts through the trees, leaves fall now and then, the lake barely moves. Nothing here hurries.
 */
const TERRAIN = { low: '#7d9a6a', mid: '#6a8a5c', high: '#8a8790', shore: '#b9b08f' } as const;
const LOG = '#7a5235';

function clearOfRetreat(x: number, z: number): boolean {
  if (inLake(x, z) || Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz) < 1.15)
    return false;
  if (Math.hypot(x, z) < 12) return false;
  if (Math.hypot(x - KNOLL.x, z - KNOLL.z) < 3.2) return false;
  if (Math.abs(x + 16) < 3 && z < -3 && z > -19) return false; // the funicular line
  return true;
}

function inGlade(x: number, z: number): boolean {
  if (inLake(x, z)) return false;
  if (
    Math.abs(x - CABIN.x) < CABIN.w / 2 + 1 &&
    z > CABIN.z - CABIN.d / 2 - 1 &&
    z < CABIN.z + CABIN.d / 2 + CABIN.porch + 1
  )
    return false;
  return Object.values(SICK_LAYOUT.place!).every(
    (p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) > 1.6,
  );
}

function Cabin({ lamps }: { lamps: number }) {
  const { x, z, w, d, porch, y } = CABIN;
  const H = 2.5;
  return (
    <group position={[x, 0, z]}>
      <Box size={[w + 0.2, y, d + 0.2]} position={[0, y / 2, 0]} color="#8f887d" />
      {/* stacked logs */}
      {Array.from({ length: 8 }, (_, i) => (
        <Box
          key={i}
          size={[w, 0.3, d]}
          position={[0, y + 0.15 + i * 0.31, 0]}
          color={i % 2 ? LOG : '#6b4a33'}
        />
      ))}
      {[-1, 1].map((s) => (
        <Box
          key={s}
          size={[w + 0.6, 0.16, d * 0.62]}
          position={[0, y + H + 0.7, (s * d) / 4]}
          rotation={[s * 0.68, 0, 0]}
          color="#5a4a44"
        />
      ))}
      <Box size={[0.6, 1.8, 0.6]} position={[-w / 2 + 0.8, y + H + 0.9, -0.5]} color="#8f887d" />
      {/* warm windows: the fireplace glows inside */}
      {[-1.6, 1.6].map((wx) => (
        <Box
          key={wx}
          size={[0.8, 0.7, 0.06]}
          position={[wx, y + 1.4, d / 2 + 0.02]}
          color="#ffe2b0"
          emissive="#ff9d5a"
          emissiveIntensity={0.35 + lamps * 1.4}
          noGlow
        />
      ))}
      <Box size={[0.9, 1.7, 0.06]} position={[0, y + 0.85, d / 2 + 0.02]} color="#5b3a2a" />
      <pointLight
        position={[0, y + 1.2, d / 2 - 0.6]}
        intensity={0.6 + lamps * 1.6}
        distance={6}
        color="#ff9d5a"
      />
      {/* the porch */}
      <group position={[0, 0, d / 2 + porch / 2]}>
        <Box size={[w, y, porch]} position={[0, y / 2, 0]} color="#8a6a4a" />
        {[-w / 2 + 0.15, w / 2 - 0.15].map((px) => (
          <Box
            key={px}
            size={[0.14, 2.3, 0.14]}
            position={[px, y + 1.15, porch / 2 - 0.15]}
            color={LOG}
          />
        ))}
        <Box
          size={[w + 0.3, 0.1, porch + 0.3]}
          position={[0, y + 2.35, 0]}
          rotation={[-0.08, 0, 0]}
          color="#5a4a44"
        />
      </group>
    </group>
  );
}

function Lake() {
  return (
    <mesh
      position={[LAKE.x, LAKE.y, LAKE.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[LAKE.rx * 1.12, LAKE.rz * 1.12, 1]}
      receiveShadow
    >
      <circleGeometry args={[1, 40]} />
      <meshStandardMaterial
        color="#6f93a8"
        transparent
        opacity={0.88}
        roughness={0.15}
        metalness={0.1}
      />
    </mesh>
  );
}

/** The hot spring: a stone-ringed pool, steam rising. */
function HotSpring({ animate }: { animate: boolean }) {
  const y = sickGround(SPRING.x, SPRING.z);
  return (
    <group position={[SPRING.x, y, SPRING.z]}>
      {Array.from({ length: 12 }, (_, i) => (
        <Ball
          key={i}
          r={0.32}
          position={[Math.cos(i * 0.52) * SPRING.r, 0.12, Math.sin(i * 0.52) * SPRING.r]}
          color="#8f887d"
        />
      ))}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[SPRING.r, 24]} />
        <meshStandardMaterial color="#9fd0d0" roughness={0.1} transparent opacity={0.85} />
      </mesh>
      <Smoke at={[0, 0.1, 0]} animate={animate} puffs={7} color="#f4f1ea" />
    </group>
  );
}

/** Mist banks drifting through the forest. */
function Mist({ animate, count }: { animate: boolean; count: number }) {
  const ref = useRef<Group>(null);
  const banks = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: -40 + hash01(i * 2.7) * 80,
        z: -30 + hash01(i * 4.1) * 30,
        s: 6 + hash01(i * 6.3) * 8,
        y: 1.5 + hash01(i * 8.9) * 3,
      })),
    [count],
  );
  useFrame((_, dt) => {
    if (!ref.current || !animate) return;
    ref.current.children.forEach((m, i) => {
      m.position.x += Math.min(dt, 0.1) * (0.35 + (i % 3) * 0.1);
      if (m.position.x > 45) m.position.x = -45;
    });
  });
  return (
    <group ref={ref}>
      {banks.map((b, i) => (
        <mesh
          key={i}
          position={[b.x, sickGround(b.x, b.z) + b.y, b.z]}
          scale={[b.s, b.s * 0.22, b.s * 0.6]}
        >
          <icosahedronGeometry args={[1, 1]} />
          <meshStandardMaterial
            color="#e6e8f2"
            transparent
            opacity={0.28}
            depthWrite={false}
            flatShading
          />
        </mesh>
      ))}
    </group>
  );
}

/** A few leaves falling now and then. */
function FallingLeaves({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    ref.current?.children.forEach((l, i) => {
      const k = (((t.current * 0.08 + i / 8) % 1) + 1) % 1;
      const x0 = -8 + hash01(i * 3.1) * 16;
      const z0 = -4 + hash01(i * 5.9) * 10;
      l.position.set(x0 + Math.sin(k * 9 + i) * 0.6, 6 - k * 6, z0 + Math.cos(k * 7) * 0.4);
      l.rotation.set(k * 6 + i, k * 4, 0);
      ((l as Mesh).material as MeshStandardMaterial).opacity = k < 0.9 ? 0.9 : (1 - k) * 9;
    });
  });
  return (
    <group ref={ref}>
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i}>
          <planeGeometry args={[0.12, 0.08]} />
          <meshStandardMaterial
            color={['#c9842f', '#b5622e', '#d6a03a'][i % 3]}
            side={2}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </group>
  );
}

function Mountains() {
  const peaks = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => {
        const a = -Math.PI * 0.92 + (i / 8) * Math.PI * 0.85;
        const r = 70 + hash01(i * 3.3) * 25;
        return {
          x: Math.cos(a) * r,
          z: Math.sin(a) * r * 0.8 - 10,
          h: 26 + hash01(i * 1.7) * 18,
          w: 20 + hash01(i * 5.5) * 12,
        };
      }),
    [],
  );
  return (
    <group>
      {peaks.map((p, i) => (
        <group key={i} position={[p.x, -1, p.z]}>
          <Cone
            r={p.w}
            h={p.h}
            position={[0, p.h / 2, 0]}
            color="#7d7f98"
            segments={5}
            shadow={false}
          />
          <Cone
            r={p.w * 0.3}
            h={p.h * 0.3}
            position={[0, p.h * 0.85, 0]}
            color="#eef0f7"
            segments={5}
            shadow={false}
          />
        </group>
      ))}
    </group>
  );
}

export function SickWorld({ lamps, animate, quality, pal, avatar, weather }: SceneryProps) {
  const k = DENSITY[quality];
  const pines = useMemo(
    () =>
      scatter({
        count: Math.round(110 * k),
        seed: 211,
        rMin: 12,
        rMax: 60,
        ground: sickGround,
        keep: clearOfRetreat,
        scale: [0.9, 1.8],
      }),
    [k],
  );
  const glade = useMemo(
    () =>
      scatter({
        count: Math.round(10 * k),
        seed: 223,
        rMin: 6,
        rMax: 12,
        ground: sickGround,
        keep: inGlade,
        scale: [0.7, 1.0],
      }),
    [k],
  );
  const rocks = useMemo(
    () =>
      scatter({
        count: Math.round(20 * k),
        seed: 239,
        rMin: 6,
        rMax: 30,
        ground: sickGround,
        keep: inGlade,
        scale: [0.5, 1.4],
      }),
    [k],
  );
  return (
    <group>
      <WindClock animate={animate} strength={0.035 * weather.wind} />
      <Terrain
        ground={sickGround}
        size={180}
        segments={quality === 'low' ? 60 : 110}
        colors={TERRAIN}
        waterY={LAKE.y}
      />
      <Lake />
      <HotSpring animate={animate} />
      <Cabin lamps={lamps} />
      <Smoke
        at={[CABIN.x - CABIN.w / 2 + 0.8, CABIN.y + 2.5 + 1.9, CABIN.z - 0.5]}
        animate={animate}
      />
      <Seat
        pos={PORCH_SEAT.pos}
        rotY={PORCH_SEAT.rotY}
        avatar={avatar}
        animate={animate}
        pal={pal}
        lamps={lamps}
        desk={false}
      />
      <Trees items={pines} kind="pine" crowns={['#2f5a44', '#3a6a4a', '#2a4f3f']} />
      <Trees items={glade} kind="pine" crowns={['#3f7a4a', '#2f6a4f']} />
      <Rocks items={rocks} color="#8f887d" />
      {quality !== 'low' && <Mist animate={animate} count={quality === 'high' ? 9 : 5} />}
      <FallingLeaves animate={animate} />
      <Mountains />
      <Clouds
        count={Math.round((quality === 'low' ? 3 : 6) * weather.clouds)}
        height={26}
        spread={140}
        animate={animate}
        speed={0.6}
        tint="#eef0f7"
      />
      {/* a small jetty for the lake boat */}
      <group position={[LAKE.x + 3.6, LAKE.y + 0.5, LAKE.z - 3.4]}>
        <Box size={[1.2, 0.1, 3]} color="#8a6a4a" />
        {[-1, 1].map((z) => (
          <Cyl key={z} r={0.07} h={1.4} position={[0.5, -0.5, z]} color={LOG} />
        ))}
      </group>
      {lamps > 0.5 && !weather.rain && <Fireflies center={[-6, 0.2, 3]} animate={animate} />}
      {weather.rain && <Rain animate={animate} count={quality === 'low' ? 160 : 480} />}
    </group>
  );
}
