import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MathUtils, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { aimAt } from '../environment/placement';
import type { V3 } from '../layout';
import { Box, Cyl } from '../scene/parts';

/**
 * An observatory: a tower, a dome that turns towards the ship and a telescope that swings onto it — its
 * lens glowing — when the camera heads to the ship through it (`active`). Every environment dresses it its own way
 * (`style`, `extras`); the gateway behaviour is the same everywhere. Drawn about its base, unturned.
 */
export interface ObservatoryStyle {
  tower: string;
  band: string;
  dome: string;
  door: string;
  /** Glass dome (the office's rooftop dome). */
  glass?: boolean;
}

export function ObservatoryModel({
  pivot,
  ship,
  active,
  lamps,
  animate,
  style,
  height = 2.6,
  radius = 2.1,
  extras,
}: {
  /**
   * The telescope's pivot and the ship, world metres (the observatory itself stands unturned). The pivot must be
   * `height + 0.8` above the base: `observatoryPivotHeight`.
   */
  pivot: V3;
  ship: V3;
  active: boolean;
  lamps: number;
  animate: boolean;
  style: ObservatoryStyle;
  height?: number;
  radius?: number;
  extras?: ReactNode;
}) {
  const aim = aimAt(pivot, ship);
  const dome = useRef<Group>(null);
  const tube = useRef<Group>(null);
  const lens = useRef<Mesh>(null);
  useFrame((_, dt) => {
    // Idle: parked low and a little aside; active: locked on the ship.
    const yaw = active ? aim.yaw : aim.yaw - 0.35;
    const pitch = active ? aim.pitch : aim.pitch - 0.25;
    const k = animate ? 4 : 1000;
    if (dome.current)
      dome.current.rotation.y = MathUtils.damp(dome.current.rotation.y, yaw, k * 0.6, dt);
    if (tube.current)
      tube.current.rotation.x = MathUtils.damp(tube.current.rotation.x, -pitch, k, dt);
    const m = lens.current?.material as MeshStandardMaterial | undefined;
    if (m)
      m.emissiveIntensity = MathUtils.damp(
        m.emissiveIntensity,
        active ? 3 : 0.3 + lamps * 0.5,
        3,
        dt,
      );
  });
  const H = height;
  const R = radius;
  return (
    <group>
      <Cyl
        r={R}
        rBottom={R + 0.2}
        h={H}
        position={[0, H / 2, 0]}
        color={style.tower}
        segments={12}
      />
      <Cyl r={R + 0.1} h={0.25} position={[0, H + 0.12, 0]} color={style.band} segments={12} />
      <Box size={[0.9, 1.6, 0.1]} position={[0, 0.8, R + 0.12]} color={style.door} />
      <Box
        size={[0.4, 0.3, 0.06]}
        position={[0, 1.85, R + 0.14]}
        color="#fff1c9"
        emissive="#ffc861"
        emissiveIntensity={lamps * 1.6}
        noGlow
      />
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          size={[1.2, 0.15, 0.4]}
          position={[0, 0.075 + i * 0.15, R + 0.8 - i * 0.35]}
          color="#c9c1b3"
        />
      ))}
      <group ref={dome} position={[0, H + 0.25, 0]} rotation={[0, aim.yaw - 0.35, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[R + 0.05, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial
            color={style.dome}
            flatShading
            metalness={style.glass ? 0.1 : 0.3}
            roughness={style.glass ? 0.1 : 0.5}
            transparent={style.glass ?? false}
            opacity={style.glass ? 0.45 : 1}
          />
        </mesh>
        {!style.glass && (
          <Box
            size={[0.8, 0.05, R + 0.1]}
            position={[0, R, R * 0.43]}
            rotation={[-0.45, 0, 0]}
            color="#2b2f36"
            shadow={false}
          />
        )}
        <group ref={tube} position={[0, 0.55, 0]} rotation={[-(aim.pitch - 0.25), 0, 0]}>
          <Cyl
            r={0.26}
            rBottom={0.32}
            h={3.2}
            position={[0, 0, 1.2]}
            rotation={[Math.PI / 2, 0, 0]}
            color={style.band}
          />
          <Cyl
            r={0.34}
            h={0.3}
            position={[0, 0, 2.75]}
            rotation={[Math.PI / 2, 0, 0]}
            color="#c9a227"
            metalness={0.6}
          />
          <mesh ref={lens} position={[0, 0, 2.92]}>
            <circleGeometry args={[0.28, 16]} />
            <meshStandardMaterial color="#bfe6ff" emissive="#7fd0ff" emissiveIntensity={0.3} />
          </mesh>
          <Box size={[0.2, 0.6, 0.2]} position={[0, -0.5, 0]} color="#5b4636" />
        </group>
      </group>
      {extras}
    </group>
  );
}

/** How high above its base an observatory's telescope pivots (layouts place the pivot with it). */
export const observatoryPivotHeight = (height = 2.6): number => height + 0.8;
