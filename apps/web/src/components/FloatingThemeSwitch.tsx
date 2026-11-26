import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { WakeDreamSwitch } from '@/components/ThemeToggle';
import { SPRING } from '@/lib/motion/presets';

/** Where the pill rests: `bottom-5`, centred. */
const HOME_BOTTOM = 20;
/** Air between the pill and a bar it steps over. */
const GAP = 12;

/**
 * Marks a bar pinned to the bottom of the screen (a bulk-action bar, a sticky footer). While one sits under the
 * floating theme pill, the pill steps up and rests just above it, so it never covers the bar's buttons or text.
 */
export const BOTTOM_BAR = { 'data-bottom-bar': '' } as const;

/**
 * The Wake / Dream / Auto pill, floating at the bottom centre. It watches for bottom bars (`BOTTOM_BAR`) and lifts
 * itself clear of any that would sit under it, then settles back once they are gone.
 */
export function FloatingThemeSwitch() {
  const ref = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const pill = ref.current;
      if (!pill) return;
      // The pill's resting place, whatever its lift is now.
      const width = pill.offsetWidth;
      const left = (window.innerWidth - width) / 2;
      const right = left + width;
      const bottom = window.innerHeight - HOME_BOTTOM;
      const top = bottom - pill.offsetHeight;
      let need = 0;
      for (const bar of document.querySelectorAll<HTMLElement>('[data-bottom-bar]')) {
        const r = bar.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right <= left || r.left >= right || r.bottom <= top || r.top >= bottom) continue;
        need = Math.max(need, bottom - r.top + GAP);
      }
      // A bar taller than half the screen is content, not a bar: stepping over it would fling the pill away.
      setLift(need > window.innerHeight / 2 ? 0 : need);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
      <motion.div
        ref={ref}
        className="pointer-events-auto"
        animate={{ y: -lift }}
        transition={reduced ? { duration: 0 } : SPRING.settle}
      >
        <WakeDreamSwitch />
      </motion.div>
    </div>
  );
}
