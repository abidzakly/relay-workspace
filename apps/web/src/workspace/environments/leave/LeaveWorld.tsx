import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh, MeshBasicMaterial, PointLight } from 'three';
import { Birds, Clouds, WindClock, Rain } from '../../environment/Atmosphere';
import { Rocks, Trees } from '../../environment/Foliage';
import { hash01 } from '../../environment/placement';
import { DENSITY } from '../../environment/quality';
import { scatter } from '../../environment/scatter';
import { Sea } from '../../environment/Sea';
import { Seat } from '../../environment/Seat';
import { Terrain } from '../../environment/Terrain';
import { Ball, Box, Cone, Cyl } from '../../scene/parts';
import type { SceneryProps } from '../../world/types';
import {
  BONFIRE,
  BUNGALOW,
  DECK_SEAT,
  HAMMOCK,
  ISLAND,
  LEAVE_LAYOUT,
  leaveColor,
  leaveGround,
  PIER,
  POINT,
  TRAM,
} from './leaveLayout';

/**
 * LEAVE — the tropical private island: sandy beach, palms, a beach bungalow with a deck chair, a wooden
 * pier, a hammock, a bonfire, a coral reef, a lighthouse on the point. Waves approach and recede, palms sway, the
 * bonfire flickers, footprints appear in the sand and fade. The world is relaxed: nothing asks for work.
 */
const TERRAIN = { low: '#ecd9a8', mid: '#7cbf5a', high: '#a0968a', shore: '#ecd9a8' } as const;
const BAMBOO = '#c9a66b';
const THATCH = '#d8b26e';
const PLANK = '#a8825c';

function onIsland(x: number, z: number): boolean {
  return leaveGround(x, z) > 0.25;
}

function freeSand(x: number, z: number): boolean {
  if (!onIsland(x, z)) return false;
  const objects = Object.values(LEAVE_LAYOUT.place!);
  if (objects.some((p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) < 2.2)) return false;
  if (
    Math.abs(x - BUNGALOW.x) < BUNGALOW.w / 2 + 1.5 &&
    z > BUNGALOW.z - BUNGALOW.d / 2 - 1 &&
    z < BUNGALOW.z + BUNGALOW.d / 2 + BUNGALOW.deck + 1
  )
    return false;
  if (Math.hypot(x - TRAM.x, z - TRAM.z) < TRAM.rx + 1) return false;
  if (Math.hypot(x - BONFIRE[0], z - BONFIRE[2]) < 2.5) return false;
  if (Math.hypot(x - POINT.x, z - POINT.z) < 3) return false;
  return true;
}

function Bungalow({ lamps }: { lamps: number }) {
  const { x, z, w, d, deck, y } = BUNGALOW;
  return (
    <group position={[x, 0, z]}>
      {/* stilts, floor, walls, a deep thatched roof */}
      {[-1, 1].flatMap((sx) =>
        [-1, 0, 1].map((sz) => (
          <Cyl
            key={`${sx}${sz}`}
            r={0.1}
            h={y}
            position={[(sx * w) / 2.2, y / 2, (sz * (d + deck)) / 2.3 + deck / 2]}
            color={PLANK}
          />
        )),
      )}
      <Box size={[w, 0.14, d + deck]} position={[0, y + 0.07, deck / 2]} color={PLANK} />
      <Box size={[w - 0.4, 2.3, d]} position={[0, y + 1.25, 0]} color="#efe3c8" />
      <Box size={[0.9, 1.7, 0.06]} position={[0.8, y + 0.99, d / 2 + 0.01]} color="#8a5a3b" />
      <Box
        size={[1.1, 0.8, 0.06]}
        position={[-1.2, y + 1.5, d / 2 + 0.02]}
        color="#fff1c9"
        emissive="#ffc861"
        emissiveIntensity={0.15 + lamps * 1.3}
        noGlow
      />
      <Cone
        r={(w + 1.6) * 0.72}
        h={2.0}
        position={[0, y + 3.3, deck / 4]}
        rotation={[0, Math.PI / 4, 0]}
        color={THATCH}
        segments={4}
      />
      {/* deck railing */}
      <Box size={[w, 0.06, 0.06]} position={[0, y + 0.85, d / 2 + deck - 0.05]} color={BAMBOO} />
      {[-w / 2 + 0.1, w / 2 - 0.1].map((px) => (
        <Cyl
          key={px}
          r={0.06}
          h={2.4}
          position={[px, y + 1.2, d / 2 + deck - 0.1]}
          color={BAMBOO}
        />
      ))}
      {/* steps down to the sand */}
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          size={[1, 0.12, 0.35]}
          position={[1.6, y - 0.25 - i * 0.28, d / 2 + deck + 0.25 + i * 0.32]}
          color={PLANK}
        />
      ))}
    </group>
  );
}

function Pier() {
  const planks = [];
  for (let z = PIER.z0; z <= PIER.z1; z += 0.5) planks.push(z);
  return (
    <group position={[PIER.x, 0, 0]}>
      {planks.map((z) => (
        <Box key={z} size={[1.6, 0.08, 0.44]} position={[0, PIER.y, z]} color={PLANK} />
      ))}
      {[PIER.z0 + 1, PIER.z0 + 4, PIER.z0 + 7, PIER.z1].flatMap((z) =>
        [-0.75, 0.75].map((x) => (
          <Cyl key={`${z}${x}`} r={0.09} h={2.4} position={[x, PIER.y - 0.8, z]} color="#7a5a3b" />
        )),
      )}
    </group>
  );
}

/** A hammock between two palms, swinging gently. */
function Hammock({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const [ax, az] = HAMMOCK.a;
  const [bx, bz] = HAMMOCK.b;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const len = Math.hypot(bx - ax, bz - az);
  const yaw = Math.atan2(bx - ax, bz - az);
  useFrame(({ clock }) => {
    if (ref.current && animate) ref.current.rotation.z = Math.sin(clock.elapsedTime * 0.9) * 0.08;
  });
  return (
    <group>
      {[HAMMOCK.a, HAMMOCK.b].map(([x, z], i) => (
        <group key={i} position={[x, leaveGround(x, z), z]}>
          <Cyl
            r={0.16}
            rBottom={0.2}
            h={4.2}
            position={[0, 2.1, 0]}
            rotation={[0, 0, i ? 0.06 : -0.06]}
            color="#8b6a4a"
          />
          {Array.from({ length: 6 }, (_, k) => (
            <group key={k} position={[0, 4.2, 0]} rotation={[0, (k / 6) * Math.PI * 2, 0]}>
              <Box
                size={[0.4, 0.05, 1.8]}
                position={[0, -0.3, 0.8]}
                rotation={[0.45, 0, 0]}
                color="#4f9c50"
              />
            </group>
          ))}
        </group>
      ))}
      <group position={[mx, leaveGround(mx, mz) + 1.25, mz]} rotation={[0, yaw, 0]}>
        <group ref={ref}>
          <mesh position={[0, -0.25, 0]} rotation={[0, 0, 0]}>
            <cylinderGeometry
              args={[0.5, 0.5, len * 0.8, 10, 1, true, Math.PI * 0.6, Math.PI * 0.8]}
            />
            <meshStandardMaterial color="#e86a5a" side={2} flatShading />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** The bonfire: logs, flickering flames, warm light at dusk. */
function Bonfire({ animate, lamps }: { animate: boolean; lamps: number }) {
  const flames = useRef<Group>(null);
  const light = useRef<PointLight>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (flames.current && animate)
      flames.current.children.forEach((f, i) => {
        f.scale.y = 0.8 + Math.sin(t * (7 + i) + i) * 0.25;
      });
    if (light.current)
      light.current.intensity =
        (0.6 + lamps * 2.2) * (animate ? 0.85 + Math.sin(t * 13) * 0.15 : 1);
  });
  const [x, , z] = BONFIRE;
  return (
    <group position={[x, leaveGround(x, z), z]}>
      {Array.from({ length: 7 }, (_, i) => (
        <Ball
          key={i}
          r={0.18}
          position={[Math.cos(i * 0.9) * 0.6, 0.08, Math.sin(i * 0.9) * 0.6]}
          color="#8f8678"
        />
      ))}
      {[0, 1, 2].map((i) => (
        <Cyl
          key={i}
          r={0.07}
          h={0.9}
          position={[0, 0.12, 0]}
          rotation={[Math.PI / 2, (i * Math.PI) / 3, 0]}
          color="#6b4a33"
        />
      ))}
      <group ref={flames}>
        {[0, 1, 2].map((i) => (
          <Cone
            key={i}
            r={0.18 - i * 0.04}
            h={0.7 - i * 0.12}
            position={[Math.cos(i * 2) * 0.08, 0.45, Math.sin(i * 2) * 0.08]}
            color="#ffb347"
            emissive="#ff7a1a"
            emissiveIntensity={2.4}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      <pointLight ref={light} position={[0, 1, 0]} intensity={1} distance={9} color="#ff9d5a" />
    </group>
  );
}

/** The lighthouse on the point: its beam turns at dusk and night. */
function Lighthouse({ animate, lamps }: { animate: boolean; lamps: number }) {
  const beam = useRef<Group>(null);
  useFrame((_, dt) => {
    if (beam.current && animate) beam.current.rotation.y += Math.min(dt, 0.1) * 0.6;
    if (beam.current) beam.current.visible = lamps > 0.3;
  });
  const y = leaveGround(POINT.x, POINT.z);
  return (
    <group position={[POINT.x, y, POINT.z]}>
      {[0, 1, 2, 3].map((i) => (
        <Cyl
          key={i}
          r={0.9 - i * 0.12}
          rBottom={1.0 - i * 0.12}
          h={1.5}
          position={[0, 0.75 + i * 1.5, 0]}
          color={i % 2 ? '#d6453d' : '#f4f1ea'}
          segments={10}
        />
      ))}
      <Cyl
        r={0.6}
        h={0.8}
        position={[0, 6.4, 0]}
        color="#fff6d8"
        emissive="#ffd890"
        emissiveIntensity={0.3 + lamps * 2}
        noGlow
      />
      <Cone r={0.7} h={0.6} position={[0, 7.1, 0]} color="#2b2f36" />
      <group ref={beam} position={[0, 6.4, 0]}>
        <mesh position={[0, 0, 7]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[1.6, 14, 12, 1, true]} />
          <meshBasicMaterial color="#fff2c8" transparent opacity={0.12} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

/** A coral reef glimpsed through the lagoon. */
function Reef() {
  const corals = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        x: -12 + hash01(i * 3.1) * 24,
        z: 22 + hash01(i * 5.7) * 6,
        r: 0.4 + hash01(i * 7.9) * 0.6,
        c: ['#ff8a7a', '#f6c94a', '#b78bf5', '#ff6fa0', '#7fd6c2'][i % 5]!,
      })),
    [],
  );
  return (
    <group>
      {corals.map((c, i) => (
        <Ball
          key={i}
          r={c.r}
          position={[c.x, -0.9, c.z]}
          scale={[1, 0.6, 1]}
          color={c.c}
          shadow={false}
        />
      ))}
    </group>
  );
}

/** Footprints from the bungalow steps towards the water, appearing one by one and fading. */
function Footprints({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const prints = useMemo(() => {
    const out: { x: number; z: number; yaw: number }[] = [];
    const sx = BUNGALOW.x + 1.6;
    const sz = BUNGALOW.z + BUNGALOW.d / 2 + BUNGALOW.deck + 1.6;
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const x = sx + t * 3.5 + (i % 2 ? 0.18 : -0.18);
      const z = sz + t * 10;
      out.push({ x, z, yaw: Math.atan2(3.5, 10) });
    }
    return out;
  }, []);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    ref.current?.children.forEach((c, i) => {
      const k = (((t.current * 0.12 - i / prints.length) % 1) + 1) % 1;
      ((c as Mesh).material as MeshBasicMaterial).opacity = animate
        ? Math.max(0, 1 - k * 1.6) * 0.45
        : 0.25;
    });
  });
  return (
    <group ref={ref}>
      {prints.map((p, i) => (
        <mesh
          key={i}
          position={[p.x, leaveGround(p.x, p.z) + 0.02, p.z]}
          rotation={[-Math.PI / 2, 0, p.yaw]}
          scale={[0.09, 0.16, 1]}
        >
          <circleGeometry args={[1, 10]} />
          <meshBasicMaterial color="#b9a378" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

export function LeaveWorld({ lamps, animate, quality, pal, avatar, weather }: SceneryProps) {
  const k = DENSITY[quality];
  const palms = useMemo(
    () =>
      scatter({
        count: Math.round(30 * k),
        seed: 71,
        rMin: 6,
        rMax: 22,
        ground: leaveGround,
        keep: freeSand,
        scale: [0.9, 1.4],
      }),
    [k],
  );
  const bushes = useMemo(
    () =>
      scatter({
        count: Math.round(16 * k),
        seed: 83,
        rMin: 3,
        rMax: 14,
        ground: leaveGround,
        keep: freeSand,
        scale: [0.5, 0.8],
      }),
    [k],
  );
  const rocks = useMemo(
    () =>
      scatter({
        count: Math.round(18 * k),
        seed: 97,
        rMin: 15,
        rMax: 24,
        ground: leaveGround,
        keep: onIsland,
        scale: [0.6, 1.6],
      }),
    [k],
  );
  return (
    <group>
      <WindClock animate={animate} strength={0.07 * weather.wind} />
      <Sea
        color="#2fa5b8"
        foam={{ x: 0, z: 0, radius: ISLAND.rx * 1.0, sz: ISLAND.rz / ISLAND.rx }}
        animate={animate}
      />
      <Terrain
        ground={leaveGround}
        size={120}
        segments={quality === 'low' ? 60 : 100}
        colors={TERRAIN}
        colorAt={leaveColor}
      />
      <Bungalow lamps={lamps} />
      <Seat
        pos={DECK_SEAT.pos}
        rotY={DECK_SEAT.rotY}
        avatar={avatar}
        animate={animate}
        pal={pal}
        lamps={lamps}
        desk={false}
      />
      <Pier />
      <Hammock animate={animate} />
      <Bonfire animate={animate} lamps={lamps} />
      <Lighthouse animate={animate} lamps={lamps} />
      {quality !== 'low' && <Reef />}
      <Footprints animate={animate} />
      <Trees items={palms} kind="palm" crowns={['#3f8a4a', '#4f9c50', '#5aa85a']} trunk="#8b6a4a" />
      <Trees items={bushes} kind="round" crowns={['#5d9c4c', '#6fae4f']} />
      <Rocks items={rocks} color="#a0968a" />
      <Clouds
        count={Math.round((quality === 'low' ? 4 : 7) * weather.clouds)}
        height={32}
        spread={150}
        animate={animate}
      />
      {quality !== 'low' && (
        <Birds center={[-4, 14, -8]} count={4} color="#f2683c" animate={animate} />
      )}
      {weather.rain && <Rain animate={animate} count={quality === 'low' ? 160 : 480} />}
    </group>
  );
}
