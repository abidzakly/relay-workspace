import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';

const WINDOW_S = 2;
/** Below the idle pace (30): the world idles at 30 on purpose, so only a device that cannot keep that is slow. */
const SLOW_FPS = 24;
const SLOW_WINDOWS = 3;
/** Longer than this is a one-off (a shader compiling, a chunk loading, the tab coming back), not the frame rate. */
const STALL_S = 0.25;

/**
 * Says when the world has been running slowly for a while, so the canvas can draw less. Only measure a free-running
 * loop: with an FPS cap, or while paused, the frame rate says nothing about the device.
 */
export function FpsWatch({ active, onSlow }: { active: boolean; onSlow: () => void }) {
  const sample = useRef({ time: 0, frames: 0, slow: 0 });
  useEffect(() => {
    sample.current = { time: 0, frames: 0, slow: 0 };
  }, [active]);
  useFrame((_, dt) => {
    if (!active || dt > STALL_S) return;
    const s = sample.current;
    s.time += dt;
    s.frames += 1;
    if (s.time < WINDOW_S) return;
    s.slow = s.frames / s.time < SLOW_FPS ? s.slow + 1 : 0;
    s.time = 0;
    s.frames = 0;
    if (s.slow >= SLOW_WINDOWS) {
      s.slow = 0;
      onSlow();
    }
  });
  return null;
}
