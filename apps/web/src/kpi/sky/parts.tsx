import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import type { GaugeTone } from '../model';
import type { BodyKey, KpiSkyModel } from './model';

/** What every theme gets from the shell. */
export interface SceneProps {
  model: KpiSkyModel;
  /** The body the pointer or the legend is on: the scene lights it and dims the rest. */
  focus: BodyKey | null;
  onFocus: (key: BodyKey | null) => void;
  /** A click on a body: the shell opens its section. */
  onPick: (key: BodyKey) => void;
  /** A click on a late card's stone. */
  onPickLate: () => void;
  compact: boolean;
  /** Still frame: reduced motion, or the tab is hidden. */
  still: boolean;
}

export const SPARKLE = 'M0 -9 L2 -2 L9 0 L2 2 L0 9 L-2 2 L-9 0 L-2 -2 Z';

/** Ink per state. Text in the scenes stays in text tokens; only marks wear the state. */
export const TONE_FILL: Record<GaugeTone, string> = {
  good: 'fill-foreground',
  warning: 'fill-warning',
  critical: 'fill-destructive',
  neutral: 'fill-foreground',
};
export const TONE_STROKE: Record<GaugeTone, string> = {
  good: 'stroke-foreground',
  warning: 'stroke-warning',
  critical: 'stroke-destructive',
  neutral: 'stroke-foreground',
};
/** A CSS colour per state, for gradients and glows. */
export const TONE_VAR: Record<GaugeTone, string> = {
  good: 'var(--emphasis)',
  warning: 'var(--warning)',
  critical: 'var(--destructive)',
  neutral: 'var(--terracotta)',
};

/** A stable [0, 1) from a string, so a card keeps its place between renders. */
export function hashUnit(id: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * One animation clock per scene. Calls `frame(t)` (seconds) every frame while `active`; a still scene gets one frame
 * at t = 0 so it is still drawn. Writes go straight to the DOM through refs, so React does not re-render per frame.
 */
export function useFrame(frame: (t: number, dt: number) => void, active: boolean) {
  const cb = useRef(frame);
  cb.current = frame;
  useEffect(() => {
    if (!active) {
      cb.current(0, 0);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      cb.current((now - start) / 1000, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Once per month and session: a flare should celebrate a crossing, not every visit. */
export function useOnce(key: string, when: boolean): boolean {
  const fired = useRef<boolean | null>(null);
  if (fired.current === null) {
    let seen: boolean;
    try {
      seen = sessionStorage.getItem(key) === '1';
    } catch {
      seen = false;
    }
    fired.current = when && !seen;
    if (fired.current) {
      try {
        sessionStorage.setItem(key, '1');
      } catch {
        /* private mode: flare every time */
      }
    }
  }
  return fired.current;
}

/** Remembers the last value so a rise can be celebrated (a shooting star, a ripple). */
export function useRose(value: number | null): boolean {
  const prev = useRef(value);
  const rose = prev.current !== null && value !== null && value > prev.current + 1e-6;
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return rose;
}

/**
 * The lens: a small card that floats over the scene where the pointer is, in percent of the stage. Like the Meetings
 * Horizon's lens, it says in words what the mark under it means.
 */
export function Lens({
  at,
  children,
}: {
  at: { x: number; y: number } | null;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {at && (
        <motion.div
          key="lens"
          role="presentation"
          className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 rounded-md border border-hairline px-3 py-2 text-xs shadow-lg"
          style={{
            left: `${Math.min(88, Math.max(12, at.x * 100))}%`,
            top: `calc(${at.y * 100}% - 12px)`,
            translateY: '-100%',
            background: 'var(--glass-bg)',
            backdropFilter: 'var(--glass-blur)',
          }}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={SPRING.settle}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The lens body for a KPI: label, value, state, detail. */
export function BodyLens({ model, k }: { model: KpiSkyModel; k: BodyKey }) {
  const b = model.byKey[k];
  if (!b) return null;
  return (
    <div className="grid gap-0.5">
      <span className="type-micro text-muted-foreground">{b.gauge.label}</span>
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-base tabular-nums">{b.gauge.valueText}</span>
        <span
          className={cn(
            'text-xs',
            b.tone === 'critical' && 'text-destructive',
            b.tone === 'warning' && 'text-warning',
          )}
        >
          {b.gauge.status.label}
        </span>
      </span>
      {b.gauge.threshold && (
        <span className="text-muted-foreground">Line: {b.gauge.threshold.label}</span>
      )}
      <span className="text-muted-foreground">{b.gauge.detail}</span>
    </div>
  );
}

/** Pointer position inside an element, 0..1 on both axes. */
export function relPoint(e: { clientX: number; clientY: number }, el: Element) {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

/** Seeded dust for a sky: positions, sizes and twinkle phases that never move between renders. */
export function dust(n: number, seed: number, w: number, h: number) {
  return Array.from({ length: n }, (_, i) => ({
    x: hashUnit(`d${i}`, seed) * w,
    y: hashUnit(`e${i}`, seed) * h,
    r: 0.4 + hashUnit(`r${i}`, seed) * 1.2,
    phase: hashUnit(`p${i}`, seed) * 6,
  }));
}
