import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  Color,
  MathUtils,
  type CanvasTexture,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
} from 'three';
import { emit } from '@/lib/reward/engine';
import type { V3 } from '../layout';
import type { PickId } from '../registry';

/** A tapped object's wobble: how long it lasts (s), how far it squashes, how fast it shakes and settles. */
const WOBBLE_S = 0.7;
const WOBBLE_DEPTH = 0.07;
const WOBBLE_RATE = 22;
const WOBBLE_DECAY = 6;

const HIGHLIGHT = new Color('#b9c8ff');
const ORIGINAL = new WeakMap<MeshStandardMaterial, { color: Color; intensity: number }>();

export interface PickHandlers {
  /** False while the camera flies or a page is open: the world ignores the pointer then. */
  interactive: boolean;
  highlighted: PickId | null;
  /** A tap still gets its tick, but the object stays still. */
  reducedMotion: boolean;
  onHover: (id: PickId | null) => void;
  onPick: (id: PickId, touch: boolean) => void;
  /** Held down on an object (`null` when let go): the crystals crack while pressed. */
  onPress?: (id: PickId | null) => void;
}

/**
 * One clickable object. Hover → a warm emissive glow and a small lift; click → `onPick`. The same highlight shows when
 * the object's item in the 2D menu is hovered or focused, so the two stay visibly linked.
 */
export function Interactive({
  id,
  pivot,
  handlers,
  children,
  position,
  rotation,
  hit,
}: {
  id: PickId;
  /** An invisible box (w, h, d) standing on the base that also takes the pointer (outdoor worlds). */
  hit?: readonly [number, number, number];
  /** Where the object rests on its support (the environment's layout). */
  pivot: V3;
  handlers: PickHandlers;
  children: ReactNode;
  position?: [number, number, number];
  rotation?: [number, number, number];
}) {
  const ref = useRef<Group>(null);
  const on = handlers.highlighted === id;
  const invalidate = useThree((s) => s.invalidate);
  const lift = useRef(1);
  const pokedAt = useRef<number | null>(null);

  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    group.traverse((o) => {
      const mesh = o as Mesh;
      const mat = mesh.material as MeshStandardMaterial | undefined;
      if (!mesh.isMesh || !mat || !('emissive' in mat) || mat.userData.noGlow) return;
      // Kept outside the material: R3F replaces `userData` whenever the object re-renders.
      let base = ORIGINAL.get(mat);
      if (!base) {
        base = { color: mat.emissive.clone(), intensity: mat.emissiveIntensity };
        ORIGINAL.set(mat, base);
      }
      if (on) {
        mat.emissive.copy(HIGHLIGHT);
        mat.emissiveIntensity = 0.28;
      } else {
        mat.emissive.copy(base.color);
        mat.emissiveIntensity = base.intensity;
      }
    });
  }, [on]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    lift.current = MathUtils.damp(lift.current, on ? 1.04 : 1, 12, dt);
    let wobble = 0;
    if (pokedAt.current !== null) {
      const t = (performance.now() - pokedAt.current) / 1000;
      if (t >= WOBBLE_S) {
        pokedAt.current = null;
      } else {
        wobble = Math.exp(-WOBBLE_DECAY * t) * Math.sin(t * WOBBLE_RATE) * WOBBLE_DEPTH;
        // The world may draw on demand: a frame only comes if one is asked for.
        invalidate();
      }
    }
    const wide = lift.current * (1 + wobble * 0.5);
    g.scale.set(wide, lift.current * (1 - wobble), wide);
  });

  const events = handlers.interactive
    ? {
        onPointerOver: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
          handlers.onHover(id);
        },
        onPointerOut: () => {
          document.body.style.cursor = '';
          handlers.onHover(null);
          handlers.onPress?.(null);
        },
        onPointerDown: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          handlers.onPress?.(id);
        },
        onPointerUp: () => handlers.onPress?.(null),
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          // The end of a drag to look around is not a click.
          if (e.delta > 6) return;
          // Every tap answers, including the first of the two on touch. Opening is still `onPick`'s call.
          if (!handlers.reducedMotion) {
            pokedAt.current = performance.now();
            invalidate();
          }
          emit({ level: 'tick', key: 'poke:object', repeatable: true });
          const type = (e.nativeEvent as PointerEvent).pointerType;
          handlers.onPick(id, type === 'touch' || type === 'pen');
        },
      }
    : {};

  return (
    // The hover lift scales about where the object rests (PIVOT), so it never sinks into the floor, desk or wall.
    <group position={position} rotation={rotation} {...events}>
      <group ref={ref} position={pivot}>
        <group position={[-pivot[0], -pivot[1], -pivot[2]]}>
          {children}
          {hit && (
            <mesh position={[0, hit[1] / 2, 0]}>
              <boxGeometry args={[...hit]} />
              {/* draws nothing, but is hit by the pointer */}
              <meshBasicMaterial colorWrite={false} depthWrite={false} transparent opacity={0} />
            </mesh>
          )}
        </group>
      </group>
    </group>
  );
}

/** A canvas texture rebuilt only when `key` changes, and disposed when replaced. */
export function useCanvasTexture(make: () => CanvasTexture, key: string): CanvasTexture {
  const texture = useMemo(make, [key]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
