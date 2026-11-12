import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { useCelebration } from '../../world/useCelebration';
import {
  Birds,
  Butterflies,
  Clouds,
  River,
  Smoke,
  WindClock,
  Fireflies,
  Rain,
} from '../../environment/Atmosphere';
import { Grass, Rocks, Trees } from '../../environment/Foliage';
import { hash01 } from '../../environment/placement';
import { DENSITY } from '../../environment/quality';
import { scatter } from '../../environment/scatter';
import { Seat } from '../../environment/Seat';
import { Terrain } from '../../environment/Terrain';
import { Ball, Box, Cone, Cyl } from '../../scene/parts';
import type { SceneryProps } from '../../world/types';
import {
  COTTAGE,
  homeGround,
  HOME_LAYOUT,
  LANTERNS,
  OBSERVATORY_HILL,
  PORCH_DESK,
  RAILWAY,
  RIVER_HALF_WIDTH,
  riverZ,
  WATER_Y,
  WORKSHOP,
} from './homeLayout';

/**
 * HOME — the cozy hillside village: rolling hills, a cottage with a porch desk, the workshop beside it, a
 * garden, a river with a wooden bridge, distant mountains, and the observatory hill. The dashboard objects are placed
 * by the canvas from `HOME_LAYOUT`; this draws everything around them.
 */

const TERRAIN = { low: '#8fbf6a', mid: '#6fa456', high: '#7d8a6a', shore: '#d8c79a' } as const;
const CREAM = '#efe3c8';
const ROOF = '#9b4a32';
const WOOD = '#8a5a3b';

/** Keeps scenery off the yard's objects, the cottage, the paths and the water. */
function clearOfVillage(x: number, z: number): boolean {
  if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 1.2) return false;
  if (Math.hypot(x, z) < 13) return false;
  const hd = Math.hypot(x - OBSERVATORY_HILL.x, z - OBSERVATORY_HILL.z);
  if (hd < 3.5) return false; // the observatory's summit stays clear
  return true;
}

/** The yard: anywhere near the village but off paths, buildings and objects. */
function inYard(x: number, z: number): boolean {
  if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 0.6) return false;
  if (
    Math.abs(x - COTTAGE.x) < COTTAGE.w / 2 + 0.6 &&
    z > COTTAGE.z - COTTAGE.d / 2 - 0.5 &&
    z < COTTAGE.z + COTTAGE.d / 2 + COTTAGE.porchDepth + 0.4
  )
    return false;
  if (
    Math.abs(x - WORKSHOP.x) < WORKSHOP.w / 2 + 0.6 &&
    Math.abs(z - WORKSHOP.z) < WORKSHOP.d / 2 + 0.8
  )
    return false;
  if (Math.abs(x) < 0.9 && z > -2 && z < 9) return false; // the path to the bridge
  const objects = Object.values(HOME_LAYOUT.place!);
  return objects.every((p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) > 1.3);
}

function Cottage({ lamps }: { lamps: number }) {
  const { x, z, w, d, porchDepth, porchY } = COTTAGE;
  const H = 2.6;
  const window = (wx: number, wy: number, wz: number, ry = 0) => (
    <group position={[wx, wy, wz]} rotation={[0, ry, 0]} key={`${wx}${wz}`}>
      <Box size={[0.8, 0.8, 0.06]} color="#5b4636" />
      <Box
        size={[0.66, 0.66, 0.07]}
        color="#ffe9b8"
        emissive="#ffc861"
        emissiveIntensity={0.15 + lamps * 1.4}
        noGlow
      />
    </group>
  );
  return (
    <group position={[x, 0, z]}>
      {/* stone footing, cream walls, a steep roof */}
      <Box size={[w + 0.2, 0.4, d + 0.2]} position={[0, 0.2, 0]} color="#a9a39a" />
      <Box size={[w, H, d]} position={[0, 0.4 + H / 2, 0]} color={CREAM} />
      {[-1, 1].map((s) => (
        <Box
          key={s}
          size={[w + 0.5, 0.16, d * 0.62]}
          position={[0, 0.4 + H + 0.62, (s * d) / 4]}
          rotation={[s * 0.62, 0, 0]}
          color={ROOF}
        />
      ))}
      <Cone
        r={d * 0.55}
        h={1.3}
        position={[0, 0.4 + H + 0.55, 0]}
        rotation={[0, Math.PI / 4, 0]}
        color={ROOF}
        segments={4}
      />
      {/* chimney */}
      <Box size={[0.5, 1.6, 0.5]} position={[w / 2 - 0.9, 0.4 + H + 1.0, -0.6]} color="#8b6a55" />
      {/* door and windows on the porch side */}
      <Box size={[0.9, 1.7, 0.08]} position={[0.4, 0.4 + 0.85, d / 2 + 0.01]} color="#6b3b2b" />
      {window(-1.6, 1.85, d / 2 + 0.02)}
      {window(1.75, 1.85, d / 2 + 0.02)}
      {window(w / 2 + 0.02, 1.85, 0, Math.PI / 2)}
      {window(-w / 2 - 0.02, 1.85, 0, -Math.PI / 2)}
      {/* the porch: deck, posts, roof */}
      <group position={[0, 0, d / 2 + porchDepth / 2]}>
        <Box size={[w, porchY, porchDepth]} position={[0, porchY / 2, 0]} color="#a8825c" />
        {[-w / 2 + 0.15, w / 2 - 0.15].map((px) => (
          <Box
            key={px}
            size={[0.14, 2.3, 0.14]}
            position={[px, porchY + 1.15, porchDepth / 2 - 0.15]}
            color={WOOD}
          />
        ))}
        <Box
          size={[w + 0.3, 0.1, porchDepth + 0.3]}
          position={[0, porchY + 2.35, 0]}
          rotation={[-0.08, 0, 0]}
          color={ROOF}
        />
        {/* railing on the left end */}
        <Box
          size={[0.06, 0.06, porchDepth]}
          position={[-w / 2 + 0.1, porchY + 0.8, 0]}
          color={WOOD}
        />
      </group>
    </group>
  );
}

function Bridge() {
  const z = riverZ(0);
  return (
    <group position={[0, 0, z]}>
      <Box
        size={[1.6, 0.14, RIVER_HALF_WIDTH * 2 + 2]}
        position={[0, 0.25, 0]}
        rotation={[0, 0, 0]}
        color="#9b7a5a"
      />
      {[-0.75, 0.75].map((x) => (
        <group key={x}>
          <Box size={[0.08, 0.08, RIVER_HALF_WIDTH * 2 + 2]} position={[x, 0.85, 0]} color={WOOD} />
          {[-1.6, -0.5, 0.5, 1.6].map((pz) => (
            <Box key={pz} size={[0.08, 0.65, 0.08]} position={[x, 0.55, pz]} color={WOOD} />
          ))}
        </group>
      ))}
    </group>
  );
}

/**
 * Village lanterns: dark by day, warm from dusk. When the release lands
 * (100%), they light one after another along the path, whatever the hour.
 */
function Lanterns({
  lamps,
  progress,
  animate,
}: {
  lamps: number;
  progress: number | null;
  animate: boolean;
}) {
  const celebration = useCelebration(progress, animate);
  const glow = useRef<Group>(null);
  useFrame((_, dt) => {
    const k = celebration.tick(dt);
    glow.current?.children.forEach((g, i) => {
      const lit = k !== null && k > (i / LANTERNS.length) * 0.6 && k < 0.95;
      const m = (g.children[2] as Mesh).material as MeshStandardMaterial;
      m.emissiveIntensity = Math.max(lamps * 2.4, lit ? 3 : 0);
    });
  });
  return (
    <group ref={glow}>
      {LANTERNS.map(([x, z], i) => (
        <group key={i} position={[x, homeGround(x, z), z]}>
          <Cyl r={0.04} h={1.6} position={[0, 0.8, 0]} color="#2b2f36" />
          <Box size={[0.2, 0.26, 0.2]} position={[0, 1.7, 0]} color="#2b2f36" />
          <Ball
            r={0.08}
            position={[0, 1.7, 0]}
            color="#fff1c9"
            emissive="#ffc861"
            emissiveIntensity={lamps * 2.4}
            shadow={false}
            noGlow
          />
          {i < 2 && lamps > 0.3 && (
            <pointLight
              position={[0, 1.7, 0]}
              intensity={lamps * 1.6}
              distance={7}
              color="#ffc861"
            />
          )}
        </group>
      ))}
    </group>
  );
}

/** Stepping-stone paths: gate to porch, porch to workshop, the bridge. */
function Paths() {
  const stones = useMemo(() => {
    const out: [number, number][] = [];
    for (let z = -0.4; z < riverZ(0) - RIVER_HALF_WIDTH - 0.6; z += 0.75)
      out.push([Math.sin(z * 0.7) * 0.25, z]);
    for (let x = -0.3; x < 1.6; x += 0.7) out.push([x, -1.0 - x * 0.4]);
    return out;
  }, []);
  return (
    <group>
      {stones.map(([x, z], i) => (
        <Cyl
          key={i}
          r={0.32}
          h={0.06}
          position={[x, homeGround(x, z) + 0.03, z]}
          rotation={[0, i, 0]}
          color="#c9c1b3"
          segments={6}
          shadow={false}
        />
      ))}
    </group>
  );
}

/** A garden bed with flowers, a picket fence and a watering can. */
function Garden() {
  const flowers = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        x: -9.4 + hash01(i * 2.1) * 2.6,
        z: 0.6 + hash01(i * 3.7) * 1.6,
        c: ['#f08ab0', '#f6c94a', '#ffffff', '#b78bf5', '#f2683c'][i % 5]!,
      })),
    [],
  );
  return (
    <group>
      <Box size={[3.0, 0.16, 2.0]} position={[-8.1, 0.08, 1.4]} color="#6b4a33" />
      {flowers.map((f, i) => (
        <group key={i} position={[f.x, 0.16, f.z]}>
          <Cyl r={0.012} h={0.3} position={[0, 0.15, 0]} color="#4f7f3a" shadow={false} />
          <Ball r={0.06} position={[0, 0.32, 0]} color={f.c} shadow={false} />
        </group>
      ))}
      {Array.from({ length: 9 }, (_, i) => (
        <Box
          key={i}
          size={[0.08, 0.6, 0.04]}
          position={[-9.6 + i * 0.38, 0.3, 2.55]}
          color="#f4f1ea"
        />
      ))}
      <Box size={[3.2, 0.06, 0.04]} position={[-8.1, 0.45, 2.55]} color="#f4f1ea" />
      <group position={[-6.4, 0, 2.2]}>
        <Cyl
          r={0.14}
          rBottom={0.16}
          h={0.3}
          position={[0, 0.15, 0]}
          color="#5a8f7b"
          metalness={0.4}
        />
        <Cyl r={0.025} h={0.36} position={[0.2, 0.25, 0]} rotation={[0, 0, -0.9]} color="#5a8f7b" />
      </group>
    </group>
  );
}

/** Distant mountains behind the village, with snow caps; the ship hangs above them. */
function Mountains() {
  const peaks = useMemo(
    () =>
      Array.from({ length: 11 }, (_, i) => {
        const a = -Math.PI * 0.95 + (i / 10) * Math.PI * 0.9;
        const r = 95 + hash01(i * 5.3) * 30;
        return {
          x: Math.cos(a) * r,
          z: Math.sin(a) * r * 0.85 - 20,
          h: 16 + hash01(i * 2.9) * 18,
          w: 18 + hash01(i * 7.7) * 14,
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
            color="#7d8fa8"
            segments={5}
            shadow={false}
          />
          <Cone
            r={p.w * 0.32}
            h={p.h * 0.32}
            position={[0, p.h * 0.84, 0]}
            color="#eef2f7"
            segments={5}
            shadow={false}
          />
        </group>
      ))}
    </group>
  );
}

export function HomeWorld({
  phase,
  lamps,
  animate,
  quality,
  pal,
  avatar,
  weather,
  data,
}: SceneryProps) {
  const k = DENSITY[quality];
  const pines = useMemo(
    () =>
      scatter({
        count: Math.round(70 * k),
        seed: 11,
        rMin: 16,
        rMax: 58,
        ground: homeGround,
        keep: clearOfVillage,
        scale: [0.9, 1.6],
      }),
    [k],
  );
  const oaks = useMemo(
    () =>
      scatter({
        count: Math.round(22 * k),
        seed: 23,
        rMin: 11,
        rMax: 24,
        ground: homeGround,
        keep: clearOfVillage,
        scale: [0.9, 1.3],
      }),
    [k],
  );
  const tufts = useMemo(
    () =>
      scatter({
        count: Math.round(260 * k),
        seed: 37,
        rMin: 1.5,
        rMax: 15,
        ground: homeGround,
        keep: inYard,
        scale: [0.7, 1.4],
      }),
    [k],
  );
  const rocks = useMemo(
    () =>
      scatter({
        count: Math.round(26 * k),
        seed: 53,
        rMin: 10,
        rMax: 40,
        ground: homeGround,
        keep: clearOfVillage,
        scale: [0.6, 1.8],
      }),
    [k],
  );
  const day = phase === 'day' || phase === 'dawn';
  return (
    <group>
      <WindClock animate={animate} strength={0.05 * weather.wind} />
      <Terrain
        ground={homeGround}
        size={180}
        segments={quality === 'low' ? 60 : 110}
        colors={TERRAIN}
        waterY={WATER_Y}
      />
      <River
        centerZ={riverZ}
        halfWidth={RIVER_HALF_WIDTH}
        y={WATER_Y}
        from={-90}
        to={90}
        color="#5aa7c9"
        animate={animate}
      />
      <Bridge />
      <Paths />
      <Cottage lamps={lamps} />
      <Smoke
        at={[COTTAGE.x + COTTAGE.w / 2 - 0.9, 0.4 + 2.6 + 1.85, COTTAGE.z - 0.6]}
        animate={animate}
      />
      <Seat
        pos={PORCH_DESK.pos}
        rotY={PORCH_DESK.rotY}
        avatar={avatar}
        animate={animate}
        pal={pal}
        lamps={lamps}
        desk
      />
      <Garden />
      {day && quality !== 'low' && <Butterflies center={[-8.1, 0.3, 1.4]} animate={animate} />}
      <Lanterns lamps={lamps} progress={data.progress} animate={animate} />
      <Trees items={pines} kind="pine" crowns={['#3f7a4a', '#2f6a4f', '#4a8a50']} />
      <Trees items={oaks} kind="round" crowns={['#6fa64f', '#5d9c4c', '#86b85a']} />
      <Grass items={tufts} colors={['#6fae4f', '#7dbb57', '#5f9c45']} />
      <Rocks items={rocks} color="#9a958c" />
      <Mountains />
      <Clouds
        count={Math.round((quality === 'low' ? 4 : 8) * weather.clouds)}
        height={34}
        spread={140}
        animate={animate}
      />
      {quality !== 'low' && <Birds center={[0, 16, -20]} animate={animate} />}
      {/* the railway's little station sign post */}
      <Box
        size={[0.08, 1.0, 0.08]}
        position={[RAILWAY.x + 0.9, 0.5, RAILWAY.z + RAILWAY.rz + 0.7]}
        color={WOOD}
      />
      {lamps > 0.5 && !weather.rain && <Fireflies center={[-8.1, 0.2, 1.4]} animate={animate} />}
      {weather.rain && <Rain animate={animate} count={quality === 'low' ? 160 : 480} />}
    </group>
  );
}
