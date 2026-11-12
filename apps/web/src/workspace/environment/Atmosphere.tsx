import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  type InstancedMesh,
  type Mesh,
  type MeshStandardMaterial,
  Object3D,
} from 'three';
import { STUDIO } from '../scene/palette';
import { Ball, Box } from '../scene/parts';
import { hash01 } from './placement';
import { windUniforms } from './wind';

/**
 * Reusable ambient systems: wind's clock, drifting clouds, flowing water, chimney smoke, butterflies,
 * birds. Every one is decorative, cheap, deterministic in layout, and frozen when `animate` is false (reduced motion,
 * a page over the world, a hidden tab).
 */

/** Advances the shared wind while the world animates. */
export function WindClock({ animate, strength = 0.05 }: { animate: boolean; strength?: number }) {
  useEffect(() => {
    windUniforms.uWind.value = strength;
  }, [strength]);
  useFrame((_, dt) => {
    if (animate) windUniforms.uTime.value += Math.min(dt, 0.1);
  });
  return null;
}

/** Puffy low-poly clouds drifting with the wind, wrapping around the sky. */
export function Clouds({
  count,
  height,
  spread,
  animate,
  speed = 1.2,
  seed = 7,
  tint = STUDIO.oat,
}: {
  count: number;
  height: number;
  spread: number;
  animate: boolean;
  speed?: number;
  seed?: number;
  tint?: string;
}) {
  const ref = useRef<Group>(null);
  const clouds = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: (hash01(seed + i) - 0.5) * spread * 2,
        z: -spread * 0.2 - hash01(seed + i * 2.7) * spread,
        y: height + hash01(seed + i * 5.1) * 12,
        s: 2.4 + hash01(seed + i * 9.3) * 3,
      })),
    [count, height, spread, seed],
  );
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || !animate) return;
    for (const c of g.children) {
      c.position.x += speed * Math.min(dt, 0.1);
      if (c.position.x > spread) c.position.x = -spread;
    }
  });
  return (
    <group ref={ref}>
      {clouds.map((c, i) => (
        <group key={i} position={[c.x, c.y, c.z]} scale={c.s}>
          <Ball r={1} detail={1} color={tint} shadow={false} />
          <Ball r={0.75} detail={1} position={[1.1, -0.2, 0.2]} color={tint} shadow={false} />
          <Ball r={0.7} detail={1} position={[-1.05, -0.25, -0.1]} color={tint} shadow={false} />
          <Ball r={0.55} detail={1} position={[0.4, 0.45, -0.3]} color={tint} shadow={false} />
        </group>
      ))}
    </group>
  );
}

/**
 * A river as a ribbon of water following `centerZ(x)`, with light streaks drifting downstream ("river water
 * flows"). Calm, transparent, unlit-looking at the edges.
 */
export function River({
  centerZ,
  halfWidth,
  y,
  from,
  to,
  color,
  animate,
  streaks = 18,
}: {
  centerZ: (x: number) => number;
  halfWidth: number;
  y: number;
  from: number;
  to: number;
  color: string;
  animate: boolean;
  streaks?: number;
}) {
  const geometry = useMemo(() => {
    const step = 1.5;
    const n = Math.ceil((to - from) / step) + 1;
    const pos = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = from + i * step;
      const z = centerZ(x);
      pos.set([x, 0, z - halfWidth * 1.25, x, 0, z + halfWidth * 1.25], i * 6);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [centerZ, halfWidth, from, to]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const ref = useRef<InstancedMesh>(null);
  const seeds = useMemo(
    () =>
      Array.from({ length: streaks }, (_, i) => ({
        u: hash01(i * 3.7 + 1),
        off: (hash01(i * 5.3 + 2) - 0.5) * halfWidth * 1.4,
        speed: 0.8 + hash01(i * 2.1 + 3) * 0.8,
      })),
    [streaks, halfWidth],
  );
  const dummy = useMemo(() => new Object3D(), []);
  const t = useRef(0);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    if (animate) t.current += Math.min(dt, 0.1);
    const len = to - from;
    seeds.forEach((s, i) => {
      const x = from + ((((s.u * len + t.current * s.speed) % len) + len) % len);
      const z = centerZ(x) + s.off;
      const slope = (centerZ(x + 0.5) - centerZ(x - 0.5)) / 1;
      dummy.position.set(x, y + 0.02, z);
      dummy.rotation.set(0, -Math.atan(slope), 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <mesh geometry={geometry} position={[0, y, 0]} receiveShadow>
        <meshStandardMaterial
          color={color}
          transparent
          opacity={0.82}
          roughness={0.15}
          metalness={0.1}
          flatShading
        />
      </mesh>
      <instancedMesh ref={ref} args={[undefined, undefined, streaks]} frustumCulled={false}>
        <boxGeometry args={[0.9, 0.01, 0.06]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.45} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

/** Smoke puffs rising from a chimney and fading. */
export function Smoke({
  at,
  animate,
  puffs = 6,
  color = '#d9d4cc',
}: {
  at: readonly [number, number, number];
  animate: boolean;
  puffs?: number;
  color?: string;
}) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (animate) t.current += Math.min(dt, 0.1);
    g.children.forEach((c, i) => {
      const k = (((t.current * 0.22 + i / puffs) % 1) + 1) % 1;
      c.position.set(Math.sin(k * 4 + i) * 0.25 + k * 0.8, k * 3.2, Math.cos(k * 3 + i) * 0.15);
      c.scale.setScalar(0.25 + k * 0.9);
      const mat = (c as Mesh).material as MeshStandardMaterial;
      mat.opacity = (1 - k) * 0.55;
    });
  });
  return (
    <group ref={ref} position={[...at]}>
      {Array.from({ length: puffs }, (_, i) => (
        <mesh key={i}>
          <icosahedronGeometry args={[0.5, 0]} />
          <meshStandardMaterial
            color={color}
            transparent
            opacity={0.4}
            flatShading
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Butterflies fluttering around a flower bed. Daytime only: the caller decides. */
export function Butterflies({
  center,
  count = 4,
  radius = 1.6,
  animate,
  colors = ['#f6c94a', '#f08ab0', '#8fd0ff', '#ffffff'],
}: {
  center: readonly [number, number, number];
  count?: number;
  radius?: number;
  animate: boolean;
  colors?: readonly string[];
}) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (animate) t.current += Math.min(dt, 0.1);
    g.children.forEach((b, i) => {
      const s = t.current * (0.5 + i * 0.13) + i * 1.7;
      b.position.set(
        Math.cos(s) * radius * (0.6 + 0.4 * Math.sin(s * 0.7)),
        0.5 + Math.sin(s * 1.9) * 0.25,
        Math.sin(s * 1.3) * radius * 0.7,
      );
      b.rotation.y = -s;
      const flap = Math.sin(t.current * 22 + i) * 0.9;
      b.children[0]!.rotation.z = flap;
      b.children[1]!.rotation.z = -flap;
    });
  });
  return (
    <group ref={ref} position={[...center]}>
      {Array.from({ length: count }, (_, i) => (
        <group key={i}>
          <Box
            size={[0.12, 0.005, 0.09]}
            position={[0.06, 0, 0]}
            color={colors[i % colors.length]}
            shadow={false}
            noGlow
          />
          <Box
            size={[0.12, 0.005, 0.09]}
            position={[-0.06, 0, 0]}
            color={colors[i % colors.length]}
            shadow={false}
            noGlow
          />
        </group>
      ))}
    </group>
  );
}

/** A small flock circling high up (seabirds, tropical birds, swallows). */
export function Birds({
  center,
  count = 5,
  radius = 14,
  animate,
  color = '#2b2f36',
}: {
  center: readonly [number, number, number];
  count?: number;
  radius?: number;
  animate: boolean;
  color?: string;
}) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (animate) t.current += Math.min(dt, 0.1);
    g.children.forEach((b, i) => {
      const s = t.current * 0.18 + (i / count) * 0.9;
      b.position.set(
        Math.cos(s) * radius + i * 0.8,
        Math.sin(t.current * 0.6 + i) * 0.8 + i * 0.4,
        Math.sin(s) * radius * 0.6,
      );
      b.rotation.y = -s - Math.PI / 2;
      const flap = Math.sin(t.current * 9 + i * 2) * 0.6;
      b.children[0]!.rotation.z = flap;
      b.children[1]!.rotation.z = -flap;
    });
  });
  return (
    <group ref={ref} position={[...center]}>
      {Array.from({ length: count }, (_, i) => (
        <group key={i}>
          <Box
            size={[0.5, 0.02, 0.14]}
            position={[0.25, 0, 0]}
            color={color}
            shadow={false}
            noGlow
          />
          <Box
            size={[0.5, 0.02, 0.14]}
            position={[-0.25, 0, 0]}
            color={color}
            shadow={false}
            noGlow
          />
        </group>
      ))}
    </group>
  );
}

/** Rain: streaks falling around the view, frozen under reduced motion. */
export function Rain({
  animate,
  count = 500,
  area = 40,
  height = 22,
}: {
  animate: boolean;
  count?: number;
  area?: number;
  height?: number;
}) {
  const ref = useRef<InstancedMesh>(null);
  const drops = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: (hash01(i * 1.7) - 0.5) * area * 2,
        z: (hash01(i * 3.3) - 0.5) * area * 2,
        y: hash01(i * 5.9) * height,
        v: 14 + hash01(i * 7.1) * 6,
      })),
    [count, area, height],
  );
  const dummy = useMemo(() => new Object3D(), []);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const step = animate ? Math.min(dt, 0.1) : 0;
    drops.forEach((d, i) => {
      d.y -= d.v * step;
      if (d.y < 0) d.y += height;
      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(0, 0, 0.12);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[0.02, 0.5, 0.02]} />
      <meshBasicMaterial color="#D8D4CC" transparent opacity={0.45} depthWrite={false} />
    </instancedMesh>
  );
}

/** Fireflies at dusk and night, drifting over a meadow or a forest edge. */
export function Fireflies({
  center,
  count = 14,
  radius = 6,
  animate,
}: {
  center: readonly [number, number, number];
  count?: number;
  radius?: number;
  animate: boolean;
}) {
  const ref = useRef<Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (animate) t.current += Math.min(dt, 0.1);
    ref.current?.children.forEach((f, i) => {
      const s = t.current * (0.2 + (i % 5) * 0.05) + i * 1.3;
      f.position.set(
        Math.cos(s) * radius * hash01(i + 1),
        0.6 + Math.sin(s * 1.7) * 0.5,
        Math.sin(s * 0.8) * radius * hash01(i + 7),
      );
      f.scale.setScalar(0.6 + Math.max(0, Math.sin(t.current * 3 + i * 2.1)) * 0.8);
    });
  });
  return (
    <group ref={ref} position={[...center]}>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[0.05, 6, 4]} />
          <meshBasicMaterial color="#f6f29a" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
