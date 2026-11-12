import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { SPRING } from './presets';

/** The reduced-motion path for all `motion` components: transforms stop, fades stay. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={SPRING.settle}>
      {children}
    </MotionConfig>
  );
}
