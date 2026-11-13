import { useDrag } from '@use-gesture/react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import { SPRING } from '@/lib/motion/presets';

export type SwipeDir = 'right' | 'left' | 'up';

const THRESHOLD = 110;
const VELOCITY = 0.5;

/**
 * A flashcard on the desk: right = understood, left = not yet, up = issue.
 * Gestures come from `@use-gesture/react`, motion from `motion`. A drag locks to its first axis: sideways is a swipe,
 * vertical on touch is left to the browser's scroll (`touch-action: pan-y`) and never opens "Issue". `swipe` (from the buttons / keyboard) plays the
 * same fly-out. Reduced motion: no fly-out, the card just changes.
 */
export function SwipeCard({
  children,
  onSwipe,
  disabled,
  pending,
  reduced,
  allow = ['right', 'left', 'up'],
  stay = ['left', 'up'],
}: {
  children: ReactNode;
  onSwipe: (dir: SwipeDir) => void;
  disabled?: boolean;
  /** A swipe triggered from outside (buttons/keys): animate it, then call `onSwipe`. */
  pending?: SwipeDir | null;
  reduced?: boolean;
  /** Directions this card accepts; others spring back. */
  allow?: readonly SwipeDir[];
  /** Directions that act without the card leaving (left = flip to Explain, up = issue sheet). */
  stay?: readonly SwipeDir[];
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-12, 12]);
  // The card leans away as it is pulled, like paper lifted off a desk.
  const rotateY = useTransform(x, [-300, 300], [10, -10]);
  const rightHint = useTransform(x, [20, THRESHOLD], [0, 1]);
  const leftHint = useTransform(x, [-THRESHOLD, -20], [1, 0]);
  const upHint = useTransform(y, [-THRESHOLD, -20], [1, 0]);

  const springBack = () => {
    if (reduced) {
      x.set(0);
      y.set(0);
      return;
    }
    void animate(x, 0, SPRING.wobble);
    void animate(y, 0, SPRING.wobble);
  };
  const flyOut = (dir: SwipeDir) => {
    if (!allow.includes(dir)) {
      springBack();
      return;
    }
    if (stay.includes(dir)) {
      springBack();
      onSwipe(dir);
      return;
    }
    if (reduced) {
      onSwipe(dir);
      return;
    }
    const w = typeof window !== 'undefined' ? window.innerWidth : 800;
    if (dir === 'up') void animate(y, -900, SPRING.press).then(() => onSwipe(dir));
    else void animate(x, dir === 'right' ? w : -w, SPRING.press).then(() => onSwipe(dir));
  };

  useEffect(() => {
    if (pending) flyOut(pending);
  }, [pending]);

  const bind = useDrag(
    ({ down, movement: [mx, my], velocity: [vx, vy], direction: [dx, dy], cancel, tap, event, axis }) => {
      if (disabled || tap) return;
      // On a phone the card body scrolls: a vertical drag is always a scroll there, never a swipe. "Issue" is the
      // button below the card. Mouse and pen keep the swipe up.
      const touch = (event as PointerEvent).pointerType === 'touch' || 'touches' in event;
      const vertical = axis === 'y';
      if (down) {
        if (touch && vertical) return;
        x.set(vertical ? 0 : mx);
        y.set(touch ? 0 : Math.min(0, my));
        return;
      }
      // Selecting code (long-press, or a drag with the mouse) is not a swipe.
      const selecting = (window.getSelection()?.toString().length ?? 0) > 0;
      const sideways = !vertical && Math.abs(mx) > 2 * Math.abs(my);
      if (selecting) springBack();
      else if (sideways && (mx > THRESHOLD || (vx > VELOCITY && dx > 0 && mx > 40)))
        flyOut('right');
      else if (sideways && (mx < -THRESHOLD || (vx > VELOCITY && dx < 0 && mx < -40)))
        flyOut('left');
      else if (!touch && vertical && (my < -THRESHOLD || (vy > VELOCITY && dy < 0 && my < -40)))
        flyOut('up');
      else springBack();
      cancel?.();
    },
    { filterTaps: true, axis: 'lock', pointer: { touch: true } },
  );

  return (
    <motion.div
      {...(bind() as object)}
      style={{ x, y, rotate, rotateY, transformPerspective: 900, touchAction: 'pan-y' }}
      initial={reduced ? false : { scale: 0.96, opacity: 0, y: 12 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      transition={SPRING.settle}
      className="relative flex min-h-0 flex-1 flex-col rounded-sheet border bg-card shadow-float will-change-transform"
    >
      <motion.span
        aria-hidden
        style={{ opacity: rightHint }}
        className="pointer-events-none absolute top-4 left-4 z-10 rounded-control border-2 border-success px-2 py-0.5 text-sm font-bold text-success"
      >
        Understood
      </motion.span>
      <motion.span
        aria-hidden
        style={{ opacity: leftHint }}
        className="pointer-events-none absolute top-4 right-4 z-10 rounded-control border-2 border-primary px-2 py-0.5 text-sm font-bold text-primary-ink"
      >
        Explain
      </motion.span>
      <motion.span
        aria-hidden
        style={{ opacity: upHint }}
        className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-control border-2 border-warning px-2 py-0.5 text-sm font-bold text-warning"
      >
        Issue
      </motion.span>
      {children}
    </motion.div>
  );
}
