import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { Birds, Clouds, WindClock, Rain } from '../../environment/Atmosphere';
import { Rocks, Trees } from '../../environment/Foliage';
import { DENSITY } from '../../environment/quality';
import { scatter } from '../../environment/scatter';
import { Sea } from '../../environment/Sea';
import { Seat } from '../../environment/Seat';
import { Terrain } from '../../environment/Terrain';
import { useFloat } from '../../objects/kit';
import { Box, Cone, Cyl } from '../../scene/parts';
import type { SceneryProps } from '../../world/types';
import {
  CAFE_SEAT,
  FERRY_DOCK,
  HANGAR,
  HEADLAND,
  ISLAND,
  LIGHTHOUSE_AT,
  RUNWAY,
  SEAPLANE,
  TERMINAL,
  TRIP_LAYOUT,
  tripColor,
  tripGround,
} from './tripLayout';

/**
 * TRIP — the coastal transit island: a small airport terminal and runway, a maintenance hangar, a ferry
 * terminal and dock, a seaplane on the water and another crossing the sky, flags in the wind, seabirds, the lighthouse
 * on the point with its observation deck. The avatar waits at the terminal café with its luggage.
 */
const TERRAIN = { low: '#86c06a', mid: '#86c06a', high: '#8f8678', shore: '#ecd9a8' } as const;
const GLASS = '#9fd2e6';
const STEEL = '#9aa3ad';
const CORAL = '#f2683c';

function keepClear(x: number, z: number): boolean {
  if (tripGround(x, z) < 0.3) return false;
  if (Math.abs(z - RUNWAY.z) < RUNWAY.w / 2 + 2) return false;
  if (
    Math.abs(x - TERMINAL.x) < TERMINAL.w / 2 + 2 &&
    Math.abs(z - TERMINAL.z) < TERMINAL.d / 2 + 4
  )
    return false;
  if (Math.abs(x - HANGAR.x) < HANGAR.w / 2 + 1.5 && Math.abs(z - HANGAR.z) < HANGAR.d / 2 + 1.5)
    return false;
  if (Math.hypot(x - HEADLAND.x, z - HEADLAND.z) < HEADLAND.radius) return false;
  return Object.values(TRIP_LAYOUT.place!).every(
    (p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) > 2.4,
  );
}

function Terminal({ lamps, animate }: { lamps: number; animate: boolean }) {
  const flags = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!flags.current || !animate) return;
    flags.current.children.forEach((f, i) => {
      f.rotation.y = Math.sin(clock.elapsedTime * 3 + i) * 0.35;
    });
  });
  const { x, z, w, d, h } = TERMINAL;
  const y = tripGround(x, z);
  return (
    <group position={[x, y, z]}>
      <Box size={[w, h, d]} position={[0, h / 2, 0]} color="#e8e4dc" />
      <Box
        size={[w - 0.6, h - 1.2, 0.1]}
        position={[0, h / 2 - 0.2, d / 2 + 0.01]}
        color={GLASS}
        emissive="#fff1c9"
        emissiveIntensity={lamps * 0.8}
        transparent
        opacity={0.85}
        noGlow
      />
      <Box
        size={[w + 1.6, 0.25, d + 2.4]}
        position={[0, h + 0.1, 0.6]}
        rotation={[0.04, 0, 0]}
        color={CORAL}
      />
      {/* control tower */}
      <Cyl r={0.7} h={4} position={[w / 2 - 1, h + 2, -0.8]} color="#e8e4dc" />
      <Cyl
        r={1.1}
        rBottom={0.9}
        h={1}
        position={[w / 2 - 1, h + 4.5, -0.8]}
        color={GLASS}
        emissive="#bfe6ff"
        emissiveIntensity={0.3 + lamps}
        noGlow
      />
      {/* flags along the front, waving in the wind */}
      <group ref={flags}>
        {[-4, -1.5, 1, 3.5].map((fx, i) => (
          <group key={fx} position={[fx, 0, d / 2 + 2.6]}>
            <group>
              <Box
                size={[0.9, 0.55, 0.02]}
                position={[0.45, 3.0, 0]}
                color={['#3f7ad9', CORAL, '#34c77b', '#f6c94a'][i]}
                shadow={false}
              />
            </group>
          </group>
        ))}
      </group>
      {[-4, -1.5, 1, 3.5].map((fx) => (
        <Cyl key={fx} r={0.04} h={3.4} position={[fx, 1.7, d / 2 + 2.6]} color={STEEL} />
      ))}
    </group>
  );
}

function Runway() {
  const y = tripGround(0, RUNWAY.z) + 0.02;
  const dashes = [];
  for (let x = RUNWAY.x0 + 2; x < RUNWAY.x1 - 2; x += 3) dashes.push(x);
  return (
    <group>
      {dashes.map((x) => (
        <Box
          key={x}
          size={[1.6, 0.02, 0.18]}
          position={[x, y, RUNWAY.z]}
          color="#f4f1ea"
          shadow={false}
        />
      ))}
      {[RUNWAY.x0 + 0.8, RUNWAY.x1 - 0.8].map((x) => (
        <Box
          key={x}
          size={[0.6, 0.02, RUNWAY.w - 0.6]}
          position={[x, y, RUNWAY.z]}
          color="#f4f1ea"
          shadow={false}
        />
      ))}
    </group>
  );
}

function Hangar() {
  const { x, z, d, h } = HANGAR;
  const y = tripGround(x, z);
  return (
    <group position={[x, y, z]}>
      {/* a quonset: half a cylinder lying along z, open towards the village, closed at the back */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[h, h, d, 12, 1, true, -Math.PI / 2, Math.PI]} />
        <meshStandardMaterial color="#c4c9d0" flatShading side={2} metalness={0.3} />
      </mesh>
      <Box size={[h * 2, h, 0.1]} position={[0, h / 2, -d / 2]} color="#b4bac2" />
    </group>
  );
}

function FerryDock() {
  const planks = [];
  for (let z = FERRY_DOCK.z0; z <= FERRY_DOCK.z1; z += 0.5) planks.push(z);
  return (
    <group position={[FERRY_DOCK.x, 0, 0]}>
      {planks.map((z) => (
        <Box key={z} size={[2.2, 0.1, 0.44]} position={[0, FERRY_DOCK.y, z]} color="#a8825c" />
      ))}
      {[FERRY_DOCK.z0 + 2, FERRY_DOCK.z0 + 5, FERRY_DOCK.z1].flatMap((z) =>
        [-1, 1].map((x) => (
          <Cyl
            key={`${z}${x}`}
            r={0.1}
            h={2.6}
            position={[x, FERRY_DOCK.y - 0.8, z]}
            color="#7a5a3b"
          />
        )),
      )}
      <Box
        size={[2.6, 2.4, 2]}
        position={[0, FERRY_DOCK.y + 1.2, FERRY_DOCK.z0 - 0.5]}
        color="#f4f1ea"
      />
      <Box
        size={[3, 0.2, 2.4]}
        position={[0, FERRY_DOCK.y + 2.5, FERRY_DOCK.z0 - 0.5]}
        color="#2fa5b8"
      />
    </group>
  );
}

function Seaplane({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  useFloat(ref, animate, 0.03);
  return (
    <group position={[...SEAPLANE]} rotation={[0, 0.8, 0]}>
      <group ref={ref}>
        <PlaneBody />
        {[-0.9, 0.9].map((x) => (
          <Box key={x} size={[0.3, 0.3, 3]} position={[x, 0.15, 0]} color="#f4f1ea" />
        ))}
      </group>
    </group>
  );
}

function PlaneBody() {
  return (
    <group position={[0, 1.1, 0]}>
      <Box size={[0.7, 0.7, 3.2]} color="#f4f1ea" />
      <Box size={[4.6, 0.08, 0.8]} position={[0, 0.4, 0.2]} color={CORAL} />
      <Box size={[0.08, 0.7, 0.6]} position={[0, 0.5, -1.4]} color={CORAL} />
      <Box size={[1.4, 0.06, 0.4]} position={[0, 0.2, -1.4]} color="#f4f1ea" />
      <Cone
        r={0.35}
        h={0.5}
        position={[0, 0, 1.85]}
        rotation={[Math.PI / 2, 0, 0]}
        color="#2b2f36"
      />
    </group>
  );
}

/** A seaplane crossing the sky now and then. */
function Overflight({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    const g = ref.current;
    if (!g) return;
    const k = ((t.current * 0.02) % 1.4) - 0.2;
    g.visible = k > 0 && k < 1;
    g.position.set(-90 + k * 180, 22 + Math.sin(k * Math.PI) * 4, -40 + k * 30);
    g.rotation.set(0, Math.PI / 2 - 0.16, Math.sin(t.current) * 0.05);
  });
  return (
    <group ref={ref}>
      <PlaneBody />
    </group>
  );
}

/** A walkway from the lighthouse up to its observation deck on the headland. */
function Walkway() {
  const [lx, lz] = LIGHTHOUSE_AT;
  const steps = 10;
  return (
    <group>
      {Array.from({ length: steps }, (_, i) => {
        const t = (i + 0.5) / steps;
        const x = lx + 1.4 + (HEADLAND.x - 2.2 - lx - 1.4) * t;
        const z = lz - 1 + (HEADLAND.z + 1.8 - lz + 1) * t;
        return (
          <Box
            key={i}
            size={[1.1, 0.1, 1.0]}
            position={[x, tripGround(x, z) + 0.15, z]}
            rotation={[0, -0.9, 0]}
            color="#a8825c"
          />
        );
      })}
    </group>
  );
}

export function TripWorld({ lamps, animate, quality, pal, avatar, weather }: SceneryProps) {
  const k = DENSITY[quality];
  const palms = useMemo(
    () =>
      scatter({
        count: Math.round(26 * k),
        seed: 131,
        rMin: 8,
        rMax: 24,
        ground: tripGround,
        keep: keepClear,
        scale: [0.9, 1.4],
      }),
    [k],
  );
  const rocks = useMemo(
    () =>
      scatter({
        count: Math.round(22 * k),
        seed: 149,
        rMin: 18,
        rMax: 27,
        ground: tripGround,
        keep: (x, z) => tripGround(x, z) > -0.4,
        scale: [0.6, 1.8],
      }),
    [k],
  );
  return (
    <group>
      <WindClock animate={animate} strength={0.06 * weather.wind} />
      <Sea
        color="#2a8fb3"
        foam={{ x: 0, z: 0, radius: ISLAND.rx * 1.0, sz: ISLAND.rz / ISLAND.rx }}
        animate={animate}
      />
      <Terrain
        ground={tripGround}
        size={130}
        segments={quality === 'low' ? 60 : 100}
        colors={TERRAIN}
        colorAt={tripColor}
      />
      <Runway />
      <Terminal lamps={lamps} animate={animate} />
      <Hangar />
      <FerryDock />
      <Seaplane animate={animate} />
      <Overflight animate={animate} />
      <Walkway />
      <Seat
        pos={CAFE_SEAT.pos}
        rotY={CAFE_SEAT.rotY}
        avatar={avatar}
        animate={animate}
        pal={pal}
        lamps={lamps}
        desk
      />
      {/* the traveller's luggage beside the café table */}
      <group position={[CAFE_SEAT.pos[0] + 0.9, CAFE_SEAT.pos[1], CAFE_SEAT.pos[2] - 1.2]}>
        <Box size={[0.42, 0.62, 0.26]} position={[0, 0.36, 0]} color="#d6453d" />
        <Box size={[0.04, 0.3, 0.04]} position={[0, 0.82, 0]} color="#2b2f36" />
      </group>
      <Trees items={palms} kind="palm" crowns={['#3f8a4a', '#4f9c50', '#5aa85a']} trunk="#8b6a4a" />
      <Rocks items={rocks} color="#9a958c" />
      <Clouds
        count={Math.round((quality === 'low' ? 4 : 7) * weather.clouds)}
        height={30}
        spread={150}
        animate={animate}
        speed={1.6}
      />
      {quality !== 'low' && (
        <Birds center={[4, 12, 10]} count={6} color="#f4f1ea" animate={animate} />
      )}
      {weather.rain && <Rain animate={animate} count={quality === 'low' ? 160 : 480} />}
    </group>
  );
}
