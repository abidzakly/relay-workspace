import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, ExtrudeGeometry, Object3D, Shape, type Group, type InstancedMesh } from 'three';
import { Clouds, WindClock, Rain } from '../../environment/Atmosphere';
import { Trees } from '../../environment/Foliage';
import { hash01 } from '../../environment/placement';
import { DENSITY } from '../../environment/quality';
import { Seat } from '../../environment/Seat';
import { Ball, Box, Cyl } from '../../scene/parts';
import type { SceneryProps } from '../../world/types';
import { usePulse } from '../../world/usePulse';
import { useCelebration } from '../../world/useCelebration';
import { useStoryBeat } from '../../world/useWorldEvents';
import { DECK, DESK_SEAT, DROP, MAIN, OFFICE_LAYOUT, TOWERS } from './officeLayout';

/**
 * OFFICE — the futuristic sky campus: a deck suspended above a metropolitan skyline, glass towers, the main
 * building's atrium (the avatar's desk), rooftop gardens, small aircraft crossing the skyline, robots doing their
 * rounds, holographic displays, windows lighting up at night.
 */
const GLASS = '#9fd2e6';
const PANEL = '#d9dee6';
const CYAN = '#43d1ff';

function roundedRect(hx: number, hz: number, r: number): Shape {
  const s = new Shape();
  s.moveTo(-hx + r, -hz);
  s.lineTo(hx - r, -hz);
  s.quadraticCurveTo(hx, -hz, hx, -hz + r);
  s.lineTo(hx, hz - r);
  s.quadraticCurveTo(hx, hz, hx - r, hz);
  s.lineTo(-hx + r, hz);
  s.quadraticCurveTo(-hx, hz, -hx, hz - r);
  s.lineTo(-hx, -hz + r);
  s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  return s;
}

/** The suspended deck: a thick slab with a glowing rim and glass railings. */
function Deck({ lamps }: { lamps: number }) {
  const geo = useMemo(() => {
    const g = new ExtrudeGeometry(roundedRect(DECK.hx, DECK.hz, DECK.edge), {
      depth: 1.4,
      bevelEnabled: false,
    });
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const rim = useMemo(() => {
    const g = new ExtrudeGeometry(roundedRect(DECK.hx + 0.05, DECK.hz + 0.05, DECK.edge), {
      depth: 0.12,
      bevelEnabled: false,
    });
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  useEffect(
    () => () => {
      geo.dispose();
      rim.dispose();
    },
    [geo, rim],
  );
  return (
    <group>
      <mesh geometry={geo} receiveShadow>
        <meshStandardMaterial color="#c8ced8" flatShading metalness={0.2} roughness={0.6} />
      </mesh>
      <mesh geometry={rim} position={[0, -0.6, 0]}>
        <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.4 + lamps * 1.2} />
      </mesh>
      {/* the deck's underside tapers to a column of light far below */}
      <Cyl
        r={6}
        rBottom={1.2}
        h={14}
        position={[0, -8.4, 0]}
        color="#b4bac2"
        metalness={0.3}
        segments={10}
      />
    </group>
  );
}

function GlassTower({
  x,
  z,
  w,
  d,
  h,
  lamps,
}: {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  lamps: number;
}) {
  return (
    <group position={[x, 0, z]}>
      <Box size={[w, h, d]} position={[0, h / 2, 0]} color={GLASS} metalness={0.3} />
      {Array.from({ length: Math.floor(h / 2.2) }, (_, i) => (
        <Box
          key={i}
          size={[w + 0.06, 0.1, d + 0.06]}
          position={[0, 1.6 + i * 2.2, 0]}
          color={PANEL}
        />
      ))}
      {/* lit windows at night */}
      {Array.from({ length: Math.floor(h / 2.2) - 1 }, (_, i) => (
        <Box
          key={`w${i}`}
          size={[w * 0.8, 0.9, 0.02]}
          position={[0, 2.6 + i * 2.2, d / 2 + 0.02]}
          color="#fff1c9"
          emissive="#ffd890"
          emissiveIntensity={hash01(i * 3.3 + x) > 0.35 ? lamps * 1.2 : 0}
          noGlow
        />
      ))}
      <Box size={[w + 0.4, 0.3, d + 0.4]} position={[0, h + 0.15, 0]} color={PANEL} />
    </group>
  );
}

/** The main building: an open atrium under a canopy, where the avatar works. */
function MainBuilding({ lamps }: { lamps: number }) {
  const { x, z, w, d, h } = MAIN;
  return (
    <group position={[x, 0, z]}>
      <Box size={[w, h, d]} position={[0, h / 2, 0]} color={GLASS} metalness={0.3} />
      <Box
        size={[w - 1, h - 2, 0.05]}
        position={[0, h / 2 - 0.4, d / 2 + 0.02]}
        color="#fff1c9"
        emissive="#ffe6b0"
        emissiveIntensity={0.1 + lamps * 0.6}
        transparent
        opacity={0.6}
        noGlow
      />
      <Box size={[w + 2, 0.18, d + 5]} position={[0, h - 1.5, 2.2]} color={PANEL} />
      {[-w / 2 - 0.6, w / 2 + 0.6].map((px) => (
        <Cyl
          key={px}
          r={0.14}
          h={h - 1.5}
          position={[px, (h - 1.5) / 2, d / 2 + 4.4]}
          color={PANEL}
        />
      ))}
      {/* a rooftop garden */}
      <Box size={[w - 1, 0.4, d - 1]} position={[0, h + 0.2, 0]} color="#7a6a55" />
    </group>
  );
}

/** Rooftop gardens: round trees in planters on the roofs and the deck's corners. */
function Gardens() {
  const spots = useMemo(() => {
    const out: { x: number; y: number; z: number; scale: number; turn: number; variant: number }[] =
      [];
    for (let i = 0; i < 4; i++)
      out.push({
        x: MAIN.x - 3.5 + i * 2.3,
        y: MAIN.h + 0.4,
        z: MAIN.z,
        scale: 0.7,
        turn: i,
        variant: hash01(i),
      });
    for (const [x, z] of [
      [-17, 13],
      [17, 13],
      [-17, 3],
      [18, -1],
    ] as const)
      out.push({ x, y: 0.5, z, scale: 0.9, turn: x, variant: hash01(x + z) });
    return out;
  }, []);
  return (
    <group>
      {spots.slice(4).map((s, i) => (
        <Box key={i} size={[1.6, 0.5, 1.6]} position={[s.x, 0.25, s.z]} color="#c4c9d0" />
      ))}
      <Trees
        items={spots}
        kind="round"
        crowns={['#6fae4f', '#86b85a', '#5d9c4c']}
        trunk="#7a5a3b"
      />
    </group>
  );
}

const dummy = new Object3D();

/** The metropolis far below: instanced blocks, windows warming up at dusk. */
function Skyline({ count, lamps }: { count: number; lamps: number }) {
  const ref = useRef<InstancedMesh>(null);
  const blocks = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const a = hash01(i * 2.3) * Math.PI * 2;
        const r = 40 + hash01(i * 5.1) * 180;
        return {
          x: Math.cos(a) * r,
          z: Math.sin(a) * r,
          w: 4 + hash01(i * 7.7) * 8,
          h: 10 + hash01(i * 3.9) * 50,
        };
      }),
    [count],
  );
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new Color();
    blocks.forEach((b, i) => {
      dummy.position.set(b.x, DROP + b.h / 2, b.z);
      dummy.scale.set(b.w, b.h, b.w);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, c.set(['#8a97a8', '#9fb0c2', '#7d8a9c'][i % 3]!));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [blocks]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, blocks.length]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color="#ffffff"
        emissive="#ffd890"
        emissiveIntensity={lamps * 0.35}
        flatShading
      />
    </instancedMesh>
  );
}

/** Small aircraft crossing the skyline. */
function Aircraft({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    ref.current?.children.forEach((c, i) => {
      const k = ((t.current * (0.012 + i * 0.004) + i * 0.37) % 1) * 2 - 1;
      c.position.set(k * 160, 18 + i * 6, -60 - i * 25);
      c.rotation.y = Math.PI / 2;
    });
  });
  return (
    <group ref={ref}>
      {[0, 1, 2].map((i) => (
        <group key={i}>
          <Box size={[0.8, 0.5, 3]} color="#f4f1ea" />
          <Box size={[3.2, 0.06, 0.7]} color="#c4c9d0" />
          <Box
            size={[0.3, 0.3, 0.3]}
            position={[0, 0, -1.6]}
            color="#ff6a1a"
            emissive="#ff6a1a"
            emissiveIntensity={2}
            noGlow
          />
        </group>
      ))}
    </group>
  );
}

/** Robots doing their rounds on the deck. */
function Robots({ animate }: { animate: boolean }) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    ref.current?.children.forEach((c, i) => {
      const s = t.current * 0.12 + i * 2.1;
      c.position.set(Math.cos(s) * (9 + i * 3), 0, 4 + Math.sin(s) * 4.5);
      c.rotation.y = -s;
    });
  });
  return (
    <group ref={ref}>
      {[0, 1].map((i) => (
        <group key={i}>
          <Cyl r={0.25} h={0.5} position={[0, 0.3, 0]} color="#f4f1ea" />
          <Ball r={0.18} position={[0, 0.65, 0]} color="#d9dee6" />
          <Ball
            r={0.05}
            position={[0, 0.68, 0.16]}
            color={CYAN}
            emissive={CYAN}
            emissiveIntensity={2}
            noGlow
          />
        </group>
      ))}
    </group>
  );
}

/**
 * A ring of light across the deck from the reactor: for a merge and, bigger, for the
 * release reaching 100%.
 */
function CampusWave({ data, env, animate }: Pick<SceneryProps, 'data' | 'env' | 'animate'>) {
  const pulse = usePulse(14);
  const big = usePulse(22);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'campus-wave',
    onBeat: (strength) => pulse.fire('#a98bf5', strength),
  });
  const celebration = useCelebration(data.progress, animate);
  const fired = useRef(false);
  useFrame((_, dt) => {
    const k = celebration.tick(dt);
    if (k !== null && !fired.current) {
      big.fire('#9fe6ff', 1);
      fired.current = true;
    }
    if (k === null) fired.current = false;
  });
  const at = OFFICE_LAYOUT.place!.plant.pos;
  return (
    <group position={[at[0], 0.06, at[2]]}>
      {[pulse, big].map((p, i) => (
        <mesh key={i} ref={p.ref} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
          <ringGeometry args={[1.6, 2.0, 64]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export function OfficeWorld({
  lamps,
  animate,
  quality,
  pal,
  avatar,
  weather,
  data,
  env,
}: SceneryProps) {
  const k = DENSITY[quality];
  return (
    <group>
      <WindClock animate={animate} strength={0.03 * weather.wind} />
      <Deck lamps={lamps} />
      <CampusWave data={data} env={env} animate={animate} />
      {TOWERS.map((t) => (
        <GlassTower key={t.x} {...t} lamps={lamps} />
      ))}
      <MainBuilding lamps={lamps} />
      <Seat
        pos={DESK_SEAT.pos}
        rotY={DESK_SEAT.rotY}
        avatar={avatar}
        animate={animate}
        pal={pal}
        lamps={lamps}
        desk
      />
      <Gardens />
      {/* glass railing along the front edge */}
      <Box
        size={[DECK.hx * 2 - 4, 1.1, 0.06]}
        position={[0, 0.55, DECK.hz - 0.2]}
        color={GLASS}
        transparent
        opacity={0.3}
        shadow={false}
      />
      <Skyline count={Math.round(160 * k)} lamps={lamps} />
      <Aircraft animate={animate} />
      {quality !== 'low' && <Robots animate={animate} />}
      <Clouds
        count={Math.round((quality === 'low' ? 3 : 6) * weather.clouds)}
        height={8}
        spread={160}
        animate={animate}
      />
      {weather.rain && <Rain animate={animate} count={quality === 'low' ? 160 : 480} />}
    </group>
  );
}
