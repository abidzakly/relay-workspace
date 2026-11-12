import { useCallback, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, type Mesh, type MeshBasicMaterial } from 'three';
import { PULSE_S } from '../worldEvents';

/**
 * A short, non-blocking light pulse: attach `ref` to a mesh with a transparent basic material, call
 * `fire(color, strength)`. The mesh grows by `spread` and fades over `PULSE_S`, then hides. It asks for frames only
 * while it runs, so a demand-rendered world stays idle.
 */
export function usePulse(spread = 1.6) {
  const ref = useRef<Mesh>(null);
  const state = useRef<{ t: number; strength: number } | null>(null);
  const color = useRef(new Color());
  const invalidate = useThree((s) => s.invalidate);

  const fire = useCallback(
    (c: string, strength: number) => {
      color.current.set(c);
      state.current = { t: 0, strength };
      invalidate();
    },
    [invalidate],
  );

  useFrame((_, delta) => {
    const m = ref.current;
    if (!m) return;
    const p = state.current;
    if (!p) {
      m.visible = false;
      return;
    }
    p.t += Math.min(delta, 0.05);
    const k = p.t / PULSE_S;
    if (k >= 1) {
      state.current = null;
      m.visible = false;
      invalidate();
      return;
    }
    const mat = m.material as MeshBasicMaterial;
    m.visible = true;
    m.scale.setScalar(1 + k * spread);
    mat.color.copy(color.current);
    mat.opacity = (1 - k) * 0.75 * p.strength;
    invalidate();
  });

  return { ref, fire, active: () => state.current !== null };
}
