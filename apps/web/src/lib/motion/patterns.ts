import type { Variants } from 'motion/react';
import { SPRING } from './presets';

/** Enter and exit patterns. Under `MotionProvider`, reduced motion drops the transforms and keeps the fades. */

/** Calm: a fade with a slight rise. Safe in calm zones. */
export const FADE_RISE: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: SPRING.settle },
  gone: { opacity: 0, y: 4, transition: SPRING.settle },
};

/** Something small lands: a squash, then rest. */
export const LAND: Variants = {
  hidden: { opacity: 0, scale: 0.86 },
  shown: { opacity: 1, scale: 1, transition: SPRING.wobble },
  gone: { opacity: 0, scale: 0.94, transition: SPRING.settle },
};

/** A real win winds up before it lands. */
export const WIND_UP: Variants = {
  hidden: { opacity: 0, scale: 0.7, rotate: -8 },
  shown: { opacity: 1, scale: 1, rotate: 0, transition: SPRING.windup },
  gone: { opacity: 0, scale: 0.96, transition: SPRING.settle },
};
