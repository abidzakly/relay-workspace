import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Matrix4, TorusGeometry, Vector3, type InstancedMesh, type Material } from 'three';
import type { ProgressSegment, Stage } from './progressMapping';

const FLY_SECONDS = 0.9;
const FLY_DISTANCE = 2.6;
/** Share of a slice's angle it fills; the rest is the gap that makes it read as one card. */
export const SLICE_FILL = 0.86;
const MAX_FRAME_SECONDS = 0.1;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export function sliceGeometry(radius: number, tube: number, n: number) {
  const step = (Math.PI * 2) / n;
  const arc = n === 1 ? Math.PI * 2 : step * SLICE_FILL;
  const tubular = Math.min(32, Math.max(2, Math.ceil(128 / n)));
  return new TorusGeometry(radius, tube, 8, tubular, arc);
}

const placed = new Matrix4();
const turned = new Matrix4();
const shift = new Vector3();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * One arc slice per counted card, on one ring, instanced. A slice is shown once its card reaches `threshold`, flying in
 * along the ring's own plane and snapping into place. Mount it inside the ring's pivot so it moves with the ring.
 *
 * Remount (by `key`) to show a new set of cards without flights, as a scope change does: only an advance should fly.
 */
export function RingSegments({
  segments,
  threshold,
  radius,
  tube,
  material,
  rotation,
  animate,
}: {
  segments: readonly ProgressSegment[];
  threshold: Stage;
  radius: number;
  tube: number;
  material: Material;
  rotation: readonly [number, number, number];
  animate: boolean;
}) {
  const n = segments.length;
  const mesh = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  /** Lit cards, by id, and how far through the flight: 0 to 1. Survives a change of N, which remounts the mesh. */
  const flight = useRef(new Map<string, number>());
  const flying = useRef(false);
  const seeded = useRef(false);

  const geometry = useMemo(
    () => (n > 0 ? sliceGeometry(radius, tube, n) : null),
    [radius, tube, n],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const write = (list: readonly ProgressSegment[]) => {
    const target = mesh.current;
    if (!target) return;
    const step = (Math.PI * 2) / list.length;
    list.forEach((segment, i) => {
      const t = flight.current.get(segment.cardId);
      if (t === undefined) {
        target.setMatrixAt(i, HIDDEN);
        return;
      }
      const angle = i * step;
      const middle = angle + (step * SLICE_FILL) / 2;
      const away = FLY_DISTANCE * (1 - easeOutCubic(t));
      shift.set(Math.cos(middle) * away, Math.sin(middle) * away, 0);
      placed.makeTranslation(shift);
      target.setMatrixAt(i, placed.multiply(turned.makeRotationZ(angle)));
    });
    target.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    let anyFlying = false;
    for (const segment of segments) {
      if (segment.stage < threshold) continue;
      // The first picture is not an advance, so it arrives already assembled.
      const t = animate ? (flight.current.get(segment.cardId) ?? (seeded.current ? 0 : 1)) : 1;
      next.set(segment.cardId, t);
      if (t < 1) anyFlying = true;
    }
    seeded.current = true;
    flight.current = next;
    flying.current = anyFlying;
    write(segments);
    invalidate();
  }, [segments, threshold, animate, invalidate]);

  useFrame((_, delta) => {
    if (!flying.current) return;
    const dt = Math.min(delta, MAX_FRAME_SECONDS);
    let anyFlying = false;
    for (const [id, t] of flight.current) {
      if (t >= 1) continue;
      const moved = Math.min(1, t + dt / FLY_SECONDS);
      flight.current.set(id, moved);
      if (moved < 1) anyFlying = true;
    }
    flying.current = anyFlying;
    write(segments);
  });

  if (!geometry) return null;
  return (
    <group rotation={[...rotation]}>
      {/* The count is fixed when an instanced mesh is created. Flights leave its bounds, so it is never culled. */}
      <instancedMesh key={n} ref={mesh} args={[geometry, material, n]} frustumCulled={false} />
    </group>
  );
}
