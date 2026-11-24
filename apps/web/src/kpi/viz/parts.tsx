import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { useKpiView } from './store';

/**
 * The table behind a chart. Folded by default, so the page reads as pictures first; the choice is remembered per
 * section. A click on a chart that filters the table opens it.
 */
export function Fold({
  id,
  label = 'table',
  count,
  children,
}: {
  id: string;
  label?: string;
  count?: number;
  children: ReactNode;
}) {
  const open = useKpiView((s) => s.open[id] ?? false);
  const setOpen = useKpiView((s) => s.setOpen);
  const reduced = useReducedMotion();
  const panel = `kpi-fold-${id}`;
  return (
    <div className="grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(id, !open)}
        className="tactile inline-flex items-center gap-1.5 justify-self-start rounded-full border border-hairline px-3 py-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden
          className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')}
        />
        {open ? `Hide the ${label}` : `Show the ${label}`}
        {count !== undefined && <span className="font-mono tabular-nums">({count})</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panel}
            key="panel"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={SPRING.settle}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The width of an element, so a chart draws in real pixels and its text never scales. */
export function useWidth<T extends Element>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => entry && setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A chart tooltip, placed in px inside a `relative` parent. Text stays in text tokens. */
export function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-full rounded-md border border-hairline px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        left: x,
        top: y - 10,
        background: 'var(--glass-bg)',
        backdropFilter: 'var(--glass-blur)',
      }}
    >
      {children}
    </div>
  );
}

/** A legend key: a small swatch and its name. */
export function Key({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
  );
}
