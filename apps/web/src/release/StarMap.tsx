import { animate, motion, useMotionValue, useMotionValueEvent } from 'motion/react';
import { useEffect, useId, useState } from 'react';
import { rnd } from '@/components/glass/parts';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import type { Stage } from './model';

const W = 1000;
const H = 200;
const LEFT = 70;
const RIGHT = 900;
const DUST = 60;
const SPARKLE = 'M0 -9 L2 -2 L9 0 L2 2 L0 9 L-2 2 L-9 0 L-2 -2 Z';

const finished = (s: Stage) => s.state === 'done' || s.state === 'skipped';

/** How much of the sky is drawn: a finished stage counts whole, a working one half. */
function progress(stages: Stage[]): number {
  if (stages.length === 0) return 0;
  const n = stages.reduce((sum, s) => sum + (finished(s) ? 1 : s.state === 'active' ? 0.5 : 0), 0);
  return Math.min(1, n / stages.length);
}

/**
 * The release as a star map. Each stage is a star; the line reaches a star when its stage finishes. The working stage
 * twinkles with rays and a pulse, a failed one breaks the line and burns red, a skipped one stays hollow. When a live
 * release finishes, the whole constellation flares and a comet leaves from the last star. A dry run never launches.
 * The list below the map says every stage's state in words.
 */
export function StarMap({
  stages,
  shipped,
  allDone,
}: {
  stages: Stage[];
  shipped: boolean;
  allDone: boolean;
}) {
  const reduced = useReducedMotion();
  const uid = useId();
  const n = stages.length;
  const failed = stages.some((s) => s.state === 'failed');
  const pos = stages.map((_, i) => ({
    x: LEFT + (n <= 1 ? 0.5 : i / (n - 1)) * (RIGHT - LEFT),
    y: 58 + rnd(i, 21) * 74,
  }));
  const last = pos[n - 1] ?? { x: RIGHT, y: 90 };

  const target = shipped || allDone ? 1 : progress(stages);
  const value = useMotionValue(target);
  const [pct, setPct] = useState(Math.round(target * 100));
  useMotionValueEvent(value, 'change', (v) => setPct(Math.round(v * 100)));
  useEffect(() => {
    const c = animate(value, target, reduced ? { duration: 0 } : SPRING.windup);
    return () => c.stop();
  }, [target, reduced, value]);

  // Shipped: one flare across the sky and a comet. Fresh each time a release ships.
  const [launch, setLaunch] = useState(0);
  useEffect(() => {
    if (shipped && !reduced) setLaunch((l) => l + 1);
  }, [shipped, reduced]);

  return (
    // Below 720px it scrolls sideways in its own box rather than shrinking past legibility.
    <div className="-mx-1 overflow-x-auto px-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full min-w-180 overflow-visible select-none"
        role="img"
        aria-label={
          shipped
            ? 'The release has shipped: the constellation is complete and a comet has left it.'
            : allDone
              ? 'Released: every star is joined.'
              : failed
                ? 'A stage failed: the line is broken at its star.'
                : `The release constellation is ${pct} percent drawn.`
        }
      >
        <defs>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0.6} />
            <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`${uid}-tail`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0} />
            <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0.9} />
          </linearGradient>
        </defs>

        {/* the night: dust, some of it breathing */}
        {Array.from({ length: DUST }, (_, i) => {
          const twinkle = !reduced && i % 5 === 0;
          return (
            <motion.circle
              key={i}
              cx={10 + rnd(i, 41) * (W - 20)}
              cy={8 + rnd(i, 42) * (H - 16)}
              r={0.5 + rnd(i, 43) * 1.2}
              className="fill-foreground"
              initial={{ opacity: 0.1 + rnd(i, 44) * 0.22 }}
              animate={twinkle ? { opacity: [0.08, 0.55, 0.08] } : undefined}
              transition={
                twinkle
                  ? { duration: 2 + rnd(i, 45) * 3, repeat: Infinity, delay: rnd(i, 46) * 3 }
                  : undefined
              }
            />
          );
        })}

        {/* the counter, like the loader's */}
        <text
          x={20}
          y={34}
          className={cn('font-mono', failed ? 'fill-destructive' : 'fill-foreground')}
          fontSize={30}
          letterSpacing={-1}
        >
          {String(pct).padStart(3, '0')}
        </text>

        {/* the whole route, faint */}
        {pos.length > 1 && (
          <path
            d={`M${pos.map((p) => `${p.x} ${p.y}`).join(' L')}`}
            fill="none"
            className="stroke-foreground/15"
            strokeDasharray="2 6"
            strokeLinecap="round"
          />
        )}

        {/* the line, star to star: drawn when the stage it reaches is finished, half while it works */}
        {stages.slice(1).map((s, k) => {
          const i = k + 1;
          const a = pos[i - 1]!;
          const b = pos[i]!;
          const len = finished(s) || allDone || shipped ? 1 : s.state === 'active' ? 0.5 : 0;
          if (s.state === 'failed') {
            // Broken: two ends that do not meet, in the destructive ink.
            const mx = a.x + (b.x - a.x) * 0.42;
            const my = a.y + (b.y - a.y) * 0.42;
            const nx = a.x + (b.x - a.x) * 0.58;
            const ny = a.y + (b.y - a.y) * 0.58;
            return (
              <g
                key={s.label}
                className="stroke-destructive"
                strokeWidth={1.75}
                strokeLinecap="round"
              >
                <line x1={a.x} y1={a.y} x2={mx} y2={my} />
                <line x1={nx} y1={ny} x2={b.x} y2={b.y} strokeDasharray="3 4" />
              </g>
            );
          }
          return (
            <motion.line
              key={s.label}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={s.state === 'active' ? 'stroke-terracotta' : 'stroke-foreground'}
              strokeWidth={1.75}
              strokeLinecap="round"
              initial={false}
              animate={{ pathLength: len, opacity: len === 0 ? 0 : 1 }}
              transition={reduced ? { duration: 0 } : SPRING.windup}
            />
          );
        })}

        {/* the flare when it ships: every line lights at once */}
        {launch > 0 && pos.length > 1 && (
          <motion.path
            key={`flare-${launch}`}
            d={`M${pos.map((p) => `${p.x} ${p.y}`).join(' L')}`}
            fill="none"
            className="stroke-terracotta"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 1 }}
            animate={{ pathLength: 1, opacity: [1, 1, 0] }}
            transition={{ duration: 1.1, ease: 'easeInOut' }}
          />
        )}

        {/* the stars */}
        {stages.map((s, i) => {
          const p = pos[i]!;
          const lit = finished(s) || shipped || allDone;
          const active = s.state === 'active';
          const bad = s.state === 'failed';
          return (
            <g key={s.label} transform={`translate(${p.x} ${p.y})`}>
              {(lit || active) && <circle r={active ? 22 : 15} fill={`url(#${uid}-glow)`} />}
              {active && !reduced && (
                <>
                  <motion.circle
                    fill="none"
                    className="stroke-terracotta"
                    initial={{ r: 6, opacity: 0.9 }}
                    animate={{ r: 30, opacity: 0 }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                  />
                  <motion.g
                    animate={{ rotate: 360 }}
                    transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
                  >
                    {[0, 60, 120, 180, 240, 300].map((deg) => (
                      <line
                        key={deg}
                        x1={0}
                        y1={-13}
                        x2={0}
                        y2={-19}
                        transform={`rotate(${deg})`}
                        className="stroke-foreground/60"
                        strokeLinecap="round"
                      />
                    ))}
                  </motion.g>
                </>
              )}
              <motion.path
                d={SPARKLE}
                className={cn(
                  bad
                    ? 'fill-destructive'
                    : lit || active
                      ? 'fill-foreground'
                      : s.state === 'skipped'
                        ? 'fill-none stroke-foreground/50'
                        : s.state === 'waiting' || s.state === 'unknown'
                          ? 'fill-warning/70'
                          : 'fill-foreground/30',
                )}
                initial={false}
                animate={
                  active && !reduced
                    ? { scale: [1, 1.35, 1] }
                    : { scale: lit ? 1.15 : bad ? 1.1 : 0.7 }
                }
                transition={
                  active && !reduced
                    ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                    : { type: 'spring', visualDuration: 0.35, bounce: 0.45 }
                }
              />
              {bad && (
                <path
                  d="M-7 -7 L7 7 M7 -7 L-7 7"
                  className="stroke-destructive"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              )}
              {launch > 0 && (
                <motion.path
                  key={`spark-${launch}`}
                  d={SPARKLE}
                  className="fill-terracotta"
                  initial={{ scale: 0, rotate: 0, opacity: 1 }}
                  animate={{ scale: [0, 2.4, 0], rotate: 90, opacity: [1, 1, 0] }}
                  transition={{ duration: 0.8, delay: 0.1 + i * 0.12, ease: 'easeOut' }}
                />
              )}
              <text
                y={30}
                textAnchor="middle"
                className="fill-muted-foreground text-micro font-semibold uppercase"
              >
                {String(i + 1).padStart(2, '0')}
              </text>
            </g>
          );
        })}

        {/* the comet: it leaves from the last star */}
        {launch > 0 && (
          <motion.g
            key={`comet-${launch}`}
            initial={{ x: last.x, y: last.y, opacity: 0 }}
            animate={{ x: W + 120, y: -60, opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.1, delay: 0.9, ease: [0.4, 0, 0.9, 0.6] }}
          >
            <g
              transform={`rotate(${(Math.atan2(-60 - last.y, W + 120 - last.x) * 180) / Math.PI})`}
            >
              <path d="M-120 -3 L0 -1.6 L0 1.6 L-120 3 Z" fill={`url(#${uid}-tail)`} />
              <path d={SPARKLE} className="fill-foreground" />
            </g>
          </motion.g>
        )}

        {(shipped || allDone) && (
          <text
            x={W - 20}
            y={34}
            textAnchor="end"
            className="fill-foreground text-micro font-semibold uppercase"
          >
            {shipped ? 'Shipped ↗' : 'Released'}
          </text>
        )}
      </svg>
    </div>
  );
}
