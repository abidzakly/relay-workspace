import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MeshStandardMaterial, PlaneGeometry, type Mesh } from 'three';
import { windUniforms } from './wind';

/**
 * An open sea: a wide plane whose vertices roll in gentle waves on the shared wind clock (so it
 * stops under reduced motion), plus a foam ring where the waves meet the island and approach and recede.
 */
function seaMaterial(color: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0.92,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  float w = sin(position.x * 0.18 + uTime * 0.9) * 0.18 + cos(position.y * 0.23 + uTime * 0.7) * 0.14;
  transformed.z += w;`,
      );
  };
  m.customProgramCacheKey = () => 'sea';
  return m;
}

export function Sea({
  color,
  size = 700,
  y = 0,
  foam,
  animate = false,
}: {
  color: string;
  size?: number;
  y?: number;
  /** The shoreline as a ring (centre and radius), for the foam. */
  foam?: { x: number; z: number; radius: number; sx?: number; sz?: number };
  /** The surf approaches and recedes. */
  animate?: boolean;
}) {
  const surf = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = surf.current;
    if (!m || !foam || !animate) return;
    const k = 1 + Math.sin(clock.elapsedTime * 0.6) * 0.025;
    m.scale.set((foam.sx ?? 1) * k, (foam.sz ?? 1) * k, 1);
  });
  const geo = useMemo(() => new PlaneGeometry(size, size, 90, 90), [size]);
  const mat = useMemo(() => seaMaterial(color), [color]);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  return (
    <group position={[0, y, 0]}>
      <mesh geometry={geo} material={mat} rotation={[-Math.PI / 2, 0, 0]} receiveShadow />
      {foam && (
        <mesh
          ref={surf}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[foam.x, 0.12, foam.z]}
          scale={[foam.sx ?? 1, foam.sz ?? 1, 1]}
        >
          <ringGeometry args={[foam.radius - 0.6, foam.radius + 0.9, 72]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.45} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
