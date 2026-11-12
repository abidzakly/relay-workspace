import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { isFreshRelease } from '@/core3d/effectModel';
import { shipStageFor, type ShipStage } from '@/core3d/shipStage';
import { getEventStream } from '@/lib/sse';

/** How long a release celebration lasts (seconds): a short, non-blocking moment. */
export const CELEBRATION_S = 7;

/** A celebration starts when progress reaches 100% while the world is watching (not on the first reading). */
export function celebrationStarts(prev: ShipStage | null, next: ShipStage): boolean {
  return prev !== null && prev !== 'complete' && next === 'complete';
}

/**
 * The release-completion moment: reaching 100% while watching, or a finished release
 * (`release.done`). Returns a ref holding the seconds since it began (null when none is running); components read it
 * in `useFrame` and advance it with `tick`. Never fires under reduced motion or behind a page.
 */
export function useCelebration(progress: number | null, animate: boolean) {
  const t = useRef<number | null>(null);
  const prev = useRef<ShipStage | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const stage = shipStageFor(progress);
  useEffect(() => {
    if (celebrationStarts(prev.current, stage) && animate) {
      t.current = 0;
      invalidate();
    }
    prev.current = stage;
  }, [stage, animate, invalidate]);
  useEffect(() => {
    if (!animate) return;
    return getEventStream().subscribe((e) => {
      if (e.type !== 'release.done' || !isFreshRelease(e)) return;
      t.current = 0;
      invalidate();
    });
  }, [animate, invalidate]);
  /** Advance by `dt`; returns 0..1 progress through the celebration, or null when none runs. */
  const tick = (dt: number): number | null => {
    if (t.current === null) return null;
    t.current += Math.min(dt, 0.1);
    if (t.current >= CELEBRATION_S) {
      t.current = null;
      return null;
    }
    invalidate();
    return t.current / CELEBRATION_S;
  };
  return { tick };
}
