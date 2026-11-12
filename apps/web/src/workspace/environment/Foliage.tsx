import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Object3D,
  type BufferGeometry,
  type InstancedMesh,
} from 'three';
import type { Scattered } from './scatter';
import { windMaterial } from './wind';

/**
 * Instanced vegetation: every tree of a kind is one draw call, swaying in the shared wind. Pines (cone
 * crowns) and broadleaf trees (ball crowns); colours vary per instance within the environment's palette.
 */
export type TreeKind = 'pine' | 'round' | 'palm';

const dummy = new Object3D();

function useInstances(
  ref: React.RefObject<InstancedMesh | null>,
  items: readonly Scattered[],
  place: (o: Object3D, it: Scattered) => void,
  colors?: readonly string[],
) {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new Color();
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.turn, 0);
      dummy.scale.setScalar(it.scale);
      place(dummy, it);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      if (colors)
        m.setColorAt(i, c.set(colors[Math.floor(it.variant * colors.length) % colors.length]!));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
}

/** Geometry with its base at y = 0 (the wind bends by height above the base). */
function based<T extends BufferGeometry>(g: T, lift: number): T {
  g.translate(0, lift, 0);
  return g;
}

export function Trees({
  items,
  kind,
  crowns,
  trunk = '#6b4a33',
}: {
  items: readonly Scattered[];
  kind: TreeKind;
  /** Crown colours, picked per tree. */
  crowns: readonly string[];
  trunk?: string;
}) {
  const trunkRef = useRef<InstancedMesh>(null);
  const crownRef = useRef<InstancedMesh>(null);
  const geo = useMemo(() => {
    if (kind === 'pine')
      return {
        trunk: based(new CylinderGeometry(0.12, 0.16, 0.9, 5), 0.45),
        crown: based(new ConeGeometry(0.9, 2.6, 6), 0.8 + 1.3),
      };
    if (kind === 'palm')
      return {
        trunk: based(new CylinderGeometry(0.1, 0.16, 3.2, 5), 1.6),
        crown: based(new ConeGeometry(1.3, 0.5, 7), 3.2),
      };
    return {
      trunk: based(new CylinderGeometry(0.12, 0.17, 1.2, 5), 0.6),
      crown: based(new IcosahedronGeometry(0.95, 0), 1.2 + 0.7),
    };
  }, [kind]);
  const trunkMat = useMemo(() => windMaterial(trunk, { strength: 0.3 }), [trunk]);
  const crownMat = useMemo(() => windMaterial('#ffffff', { strength: 1 }), []);
  useEffect(
    () => () => {
      geo.trunk.dispose();
      geo.crown.dispose();
      trunkMat.dispose();
      crownMat.dispose();
    },
    [geo, trunkMat, crownMat],
  );
  useInstances(trunkRef, items, () => {});
  useInstances(crownRef, items, () => {}, crowns);
  if (items.length === 0) return null;
  return (
    <group>
      <instancedMesh
        ref={trunkRef}
        args={[geo.trunk, trunkMat, items.length]}
        castShadow
        receiveShadow
      />
      <instancedMesh
        ref={crownRef}
        args={[geo.crown, crownMat, items.length]}
        castShadow
        receiveShadow
      />
    </group>
  );
}

/** Grass tufts: three-sided blades, instanced, the liveliest swayers. */
export function Grass({
  items,
  colors,
}: {
  items: readonly Scattered[];
  colors: readonly string[];
}) {
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => based(new ConeGeometry(0.07, 0.38, 3), 0.19), []);
  const mat = useMemo(() => windMaterial('#ffffff', { strength: 4 }), []);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  useInstances(ref, items, () => {}, colors);
  if (items.length === 0) return null;
  return <instancedMesh ref={ref} args={[geo, mat, items.length]} receiveShadow />;
}

/** Rocks: faceted, still, instanced. */
export function Rocks({ items, color }: { items: readonly Scattered[]; color: string }) {
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => based(new IcosahedronGeometry(0.5, 0), 0.15), []);
  useEffect(() => () => geo.dispose(), [geo]);
  useInstances(ref, items, (o, it) => o.scale.set(it.scale, it.scale * 0.6, it.scale * 0.9));
  if (items.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[geo, undefined, items.length]} castShadow receiveShadow>
      <meshStandardMaterial color={color} flatShading roughness={1} />
    </instancedMesh>
  );
}
