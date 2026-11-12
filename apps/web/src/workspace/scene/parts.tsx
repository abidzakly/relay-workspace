import type { ReactNode } from 'react';
import type { Texture } from 'three';

/** Low-poly building blocks: flat-shaded standard materials, so every face reads as its own facet. */
type V3 = [number, number, number];

interface PartProps {
  position?: V3;
  rotation?: V3;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  map?: Texture | null;
  transparent?: boolean;
  opacity?: number;
  shadow?: boolean;
  noGlow?: boolean;
  children?: ReactNode;
}

function Material({
  color = '#ffffff',
  emissive = '#000000',
  emissiveIntensity = 1,
  roughness = 0.85,
  metalness = 0,
  map = null,
  transparent = false,
  opacity = 1,
  noGlow = false,
}: PartProps) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={emissive}
      emissiveIntensity={emissiveIntensity}
      roughness={roughness}
      metalness={metalness}
      map={map}
      transparent={transparent}
      opacity={opacity}
      flatShading
      userData={{ noGlow }}
    />
  );
}

export function Box({ size, position, rotation, shadow = true, ...m }: PartProps & { size: V3 }) {
  return (
    <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
      <boxGeometry args={size} />
      <Material {...m} />
    </mesh>
  );
}

export function Cyl({
  r,
  rBottom,
  h,
  segments = 8,
  position,
  rotation,
  shadow = true,
  ...m
}: PartProps & { r: number; rBottom?: number; h: number; segments?: number }) {
  return (
    <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
      <cylinderGeometry args={[r, rBottom ?? r, h, segments]} />
      <Material {...m} />
    </mesh>
  );
}

export function Ball({
  r,
  detail = 0,
  position,
  rotation,
  scale,
  shadow = true,
  ...m
}: PartProps & { r: number; detail?: number; scale?: V3 | number }) {
  return (
    <mesh position={position} rotation={rotation} scale={scale} castShadow={shadow} receiveShadow>
      <icosahedronGeometry args={[r, detail]} />
      <Material {...m} />
    </mesh>
  );
}

export function Cone({
  r,
  h,
  segments = 6,
  position,
  rotation,
  shadow = true,
  ...m
}: PartProps & { r: number; h: number; segments?: number }) {
  return (
    <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
      <coneGeometry args={[r, h, segments]} />
      <Material {...m} />
    </mesh>
  );
}

/** A flat textured surface (screens, boards, paper): unlit-looking via emissive, so it stays readable at night. */
export function Panel({
  size,
  map,
  position,
  rotation,
  glow = 0.85,
}: {
  size: [number, number];
  map: Texture;
  position?: V3;
  rotation?: V3;
  glow?: number;
}) {
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={size} />
      <meshStandardMaterial
        map={map}
        emissiveMap={map}
        emissive="#ffffff"
        emissiveIntensity={glow}
        roughness={0.9}
        userData={{ noGlow: true }}
      />
    </mesh>
  );
}
