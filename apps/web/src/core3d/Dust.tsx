import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  IcosahedronGeometry,
  Matrix4,
  MeshStandardMaterial,
  type Group,
  type InstancedMesh,
} from 'three';
import type { ProgressCardRef } from './progressMapping';

/** Just outside the outer ring and its mounts, and inside the frame at the camera's distance. */
const INNER_RADIUS = 3.45;
const OUTER_RADIUS = 3.7;
const DRIFT = 0.02;
/** The canvas is wider than tall, and a speck near the camera projects further out, so the cloud is flattened to fit. */
const FLATTEN_Y = 0.85;

const GEOMETRY = new IcosahedronGeometry(0.075, 0);
const MATERIAL = new MeshStandardMaterial({
  color: 0x8a7f72,
  roughness: 1,
  transparent: true,
  opacity: 0.55,
});

/** FNV-1a. A speck stays where it is between snapshots, whatever else joins or leaves the Backlog. */
export function hash(text: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

const placed = new Matrix4();

function specPosition(cardId: string): [number, number, number] {
  const z = hash(cardId, 1) * 2 - 1;
  const around = hash(cardId, 2) * Math.PI * 2;
  const r = INNER_RADIUS + hash(cardId, 3) * (OUTER_RADIUS - INNER_RADIUS);
  const flat = Math.sqrt(1 - z * z);
  return [r * flat * Math.cos(around), r * flat * Math.sin(around) * FLATTEN_Y, r * z];
}

/**
 * Backlog as a dim cloud outside the sphere. It only reports what was pointed at: the write itself belongs to
 * the confirm dialog outside the canvas.
 */
export function Dust({
  cards,
  animate,
  onPick,
  onHover,
}: {
  cards: readonly ProgressCardRef[];
  animate: boolean;
  onPick: (card: ProgressCardRef) => void;
  onHover: (card: ProgressCardRef | null) => void;
}) {
  const group = useRef<Group>(null);
  const mesh = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(
    () => () => {
      GEOMETRY.dispose();
      MATERIAL.dispose();
      document.body.style.cursor = '';
    },
    [],
  );

  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    cards.forEach((card, i) => {
      const [x, y, z] = specPosition(card.cardId);
      target.setMatrixAt(i, placed.makeTranslation(x, y, z));
    });
    target.instanceMatrix.needsUpdate = true;
    // Raycasting tests these bounds first, and three caches them.
    target.computeBoundingSphere();
    invalidate();
  }, [cards, invalidate]);

  useFrame((_, delta) => {
    if (animate && group.current) group.current.rotation.y += DRIFT * Math.min(delta, 0.1);
  });

  if (cards.length === 0) return null;

  const pointed = (event: ThreeEvent<PointerEvent | MouseEvent>) =>
    event.instanceId === undefined ? null : (cards[event.instanceId] ?? null);
  const hover = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    document.body.style.cursor = 'pointer';
    onHover(pointed(event));
  };

  return (
    <group ref={group}>
      <instancedMesh
        key={cards.length}
        ref={mesh}
        args={[GEOMETRY, MATERIAL, cards.length]}
        onPointerMove={hover}
        onPointerOut={() => {
          document.body.style.cursor = '';
          onHover(null);
        }}
        onClick={(event) => {
          event.stopPropagation();
          // The speck is about to leave, and a removed mesh sends no pointer-out.
          document.body.style.cursor = '';
          const card = pointed(event);
          if (card) onPick(card);
        }}
      />
    </group>
  );
}
