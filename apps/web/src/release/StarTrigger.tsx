import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { rnd } from '@/components/glass/parts';
import { vibrate } from '@/lib/haptics';
import { playSound } from '@/lib/sound/engine';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';

const W = 520;
const H = 210;
/** The constellation: a cut gem, traced from the bottom tip round its crown and back. */
const STARS = [
  { x: 260, y: 184 },
  { x: 166, y: 98 },
  { x: 206, y: 46 },
  { x: 314, y: 46 },
  { x: 354, y: 98 },
] as const;
/** The tracing order: every star, then home to the first to close the gem. */
const ORDER = [0, 1, 2, 3, 4, 0] as const;
const START_R = 34;
const CATCH_R = 26;
/** Facets that appear inside the gem once it is closed. */
const FACETS = [
  [1, 4],
  [2, 0],
  [3, 0],
] as const;
const DUST = 34;

const star = (i: number) => STARS[ORDER[i] ?? 0];
const SPARKLE = 'M0 -9 L2 -2 L9 0 L2 2 L0 9 L-2 2 L-9 0 L-2 -2 Z';

/**
 * Trace to release. Start at the bright star and draw through the constellation in one stroke, round the gem and home
 * again: when it closes, the form is submitted exactly as if Start had been pressed (same checks, same preview). Lift
 * the finger early and the line breaks. A release is a deliberate act, so it asks for a shape, not a tap. Enter or Space
 * traces it for you, and the Start button stays.
 */
export function StarTrigger({
  ready,
  busy,
  failed,
  action,
  onFire,
}: {
  ready: boolean;
  busy: boolean;
  /** The last start was refused: the gem dims back without ceremony (errors are a calm zone). */
  failed: boolean;
  /** After "to": "start the release", "simulate the release". */
  action: string;
  onFire: () => void;
}) {
  const reduced = useReducedMotion();
  const uid = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [lit, setLit] = useState(0);
  const [tracing, setTracing] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [broke, setBroke] = useState(false);
  const [closed, setClosed] = useState(false);
  const [comet, setComet] = useState(0);
  const flash = useMotionValue(0);
  const fade = useMotionValue(1);
  const closedRef = useRef(false);
  const sawBusy = useRef(false);
  const auto = useRef<number[]>([]);
  const locked = !ready || busy;

  const reset = () => {
    closedRef.current = false;
    sawBusy.current = false;
    setClosed(false);
    setLit(0);
    fade.set(1);
  };

  useEffect(() => () => auto.current.forEach((t) => window.clearTimeout(t)), []);

  // Hold the closed gem while the start is in flight; then a comet carries it off, or it dims back if refused.
  useEffect(() => {
    if (!closedRef.current) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      if (failed || reduced || !sawBusy.current) {
        reset();
        return;
      }
      setComet((n) => n + 1);
      void animate(fade, 0, { duration: 0.9, delay: 0.25, ease: 'easeIn' }).then(reset);
    }, 450);
    return () => window.clearTimeout(t);
  }, [busy, closed]);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    sawBusy.current = false;
    setClosed(true);
    setTracing(false);
    setTip(null);
    setLit(ORDER.length);
    if (!reduced) void animate(flash, [0, 1, 0.35], { duration: 0.7, times: [0, 0.15, 1] });
    playSound('tick');
    vibrate('pop');
    onFire();
  };

  const toView = (e: PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return null;
    return {
      x: ((e.clientX - box.left) * W) / box.width,
      y: ((e.clientY - box.top) * H) / box.height,
    };
  };
  const near = (p: { x: number; y: number }, s: { x: number; y: number }, r: number) =>
    Math.hypot(p.x - s.x, p.y - s.y) <= r;

  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (locked || closedRef.current) return;
    const p = toView(e);
    if (!p || !near(p, star(0), START_R)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setBroke(false);
    setTracing(true);
    setLit(1);
    setTip(p);
    vibrate('tick');
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!tracing) return;
    const p = toView(e);
    if (!p) return;
    setTip(p);
    if (lit < ORDER.length && near(p, star(lit), CATCH_R)) {
      const next = lit + 1;
      if (next === ORDER.length) close();
      else {
        setLit(next);
        vibrate('tick');
      }
    }
  };
  const up = () => {
    if (!tracing || closedRef.current) return;
    setTracing(false);
    setTip(null);
    setBroke(lit > 1);
    setLit(0);
  };
  const key = (e: KeyboardEvent<SVGGElement>) => {
    if (locked || closedRef.current || tracing || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    setBroke(false);
    if (reduced) {
      close();
      return;
    }
    auto.current = ORDER.map((_, i) =>
      window.setTimeout(() => (i === ORDER.length - 1 ? close() : setLit(i + 1)), 110 * (i + 1)),
    );
  };

  const word = busy
    ? 'Starting…'
    : closed
      ? 'The gem is closed'
      : !ready
        ? 'Locked until the preview is ready'
        : tracing
          ? `Keep tracing: ${lit} of ${ORDER.length - 1} stars`
          : broke
            ? 'The line broke. Trace it in one stroke'
            : `Start at the bright star and trace the gem to ${action}`;
  const shown = Math.min(lit, ORDER.length - 1);
  const prev = lit > 0 ? star(lit - 1) : null;

  return (
    <div className="grid gap-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className={cn(
          'block h-auto w-full max-w-xl touch-none select-none overflow-visible',
          locked && !closed && 'opacity-45',
          !locked && !closed && (tracing ? 'cursor-crosshair' : 'cursor-pointer'),
        )}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <defs>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0.55} />
            <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`${uid}-tail`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0} />
            <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0.9} />
          </linearGradient>
        </defs>

        {/* the night behind it: dust, a few of them breathing */}
        {Array.from({ length: DUST }, (_, i) => {
          const twinkle = !reduced && i % 4 === 0;
          return (
            <motion.circle
              key={i}
              cx={20 + rnd(i, 31) * (W - 40)}
              cy={10 + rnd(i, 32) * (H - 20)}
              r={0.5 + rnd(i, 33) * 1.1}
              className="fill-foreground"
              initial={{ opacity: 0.12 + rnd(i, 34) * 0.25 }}
              animate={twinkle ? { opacity: [0.1, 0.6, 0.1] } : undefined}
              transition={
                twinkle
                  ? { duration: 2 + rnd(i, 35) * 3, repeat: Infinity, delay: rnd(i, 36) * 2 }
                  : undefined
              }
            />
          );
        })}

        {/* the HUD: stars caught */}
        <text x={20} y={22} className="fill-muted-foreground text-micro font-semibold uppercase">
          Stars
        </text>
        <text
          x={W - 20}
          y={34}
          textAnchor="end"
          className={cn('font-mono', tracing || closed ? 'fill-foreground' : 'fill-foreground/40')}
          fontSize={28}
          letterSpacing={-1}
        >
          {`${String(shown).padStart(2, '0')}/${String(ORDER.length - 1).padStart(2, '0')}`}
        </text>

        <motion.g style={{ opacity: fade }}>
          {/* the gem waiting to be drawn */}
          <path
            d={`M${STARS.map((s) => `${s.x} ${s.y}`).join(' L')} Z`}
            fill="none"
            className="stroke-foreground/15"
            strokeDasharray="2 6"
            strokeLinecap="round"
          />

          {/* closed: the glass fills with light and its facets appear */}
          {closed && (
            <>
              <motion.path
                d={`M${STARS.map((s) => `${s.x} ${s.y}`).join(' L')} Z`}
                className="fill-terracotta"
                style={{ opacity: flash }}
              />
              {FACETS.map(([a, b], k) => (
                <motion.line
                  key={k}
                  x1={STARS[a].x}
                  y1={STARS[a].y}
                  x2={STARS[b].x}
                  y2={STARS[b].y}
                  className="stroke-foreground/40"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.4, delay: 0.1 + k * 0.08 }}
                />
              ))}
            </>
          )}

          {/* the traced line */}
          <AnimatePresence>
            {Array.from({ length: Math.max(0, lit - 1) }, (_, i) => {
              const a = star(i);
              const b = star(i + 1);
              return (
                <motion.line
                  key={`seg-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="stroke-foreground"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  initial={{ pathLength: reduced ? 1 : 0, opacity: 1 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.35 } }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                />
              );
            })}
          </AnimatePresence>
          {tracing && prev && tip && (
            <line
              x1={prev.x}
              y1={prev.y}
              x2={tip.x}
              y2={tip.y}
              className="stroke-terracotta"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              strokeLinecap="round"
            />
          )}

          {/* where to go next */}
          {!locked && !closed && !reduced && (
            <motion.circle
              key={`hint-${lit}`}
              cx={star(lit).x}
              cy={star(lit).y}
              fill="none"
              className="stroke-terracotta"
              initial={{ r: 6, opacity: 0.9 }}
              animate={{ r: 24, opacity: 0 }}
              transition={{ duration: 1.3, repeat: Infinity, ease: 'easeOut' }}
            />
          )}

          {/* the stars */}
          {STARS.map((s, i) => {
            const on = closed || (lit > 0 && ORDER.slice(0, lit).some((o) => o === i));
            const first = i === 0;
            return (
              <g key={i} transform={`translate(${s.x} ${s.y})`}>
                {on && <circle r={16} fill={`url(#${uid}-glow)`} />}
                <motion.path
                  d={SPARKLE}
                  className={
                    on ? 'fill-foreground' : first ? 'fill-foreground/70' : 'fill-foreground/35'
                  }
                  initial={false}
                  animate={{
                    scale: on ? 1.15 : first ? 0.85 : 0.6,
                    rotate: closed && !reduced ? 90 : 0,
                  }}
                  transition={{ type: 'spring', visualDuration: 0.3, bounce: 0.5 }}
                />
              </g>
            );
          })}
        </motion.g>

        {/* launched: a comet leaves from the crown */}
        {comet > 0 && (
          <motion.g
            key={`comet-${comet}`}
            initial={{ x: STARS[3].x, y: STARS[3].y, opacity: 1 }}
            animate={{ x: W + 80, y: -70, opacity: [1, 1, 0] }}
            transition={{ duration: 0.9, ease: [0.4, 0, 0.9, 0.6] }}
          >
            <g transform="rotate(-27)">
              <path d="M-90 -2.5 L0 -1.5 L0 1.5 L-90 2.5 Z" fill={`url(#${uid}-tail)`} />
              <path d={SPARKLE} className="fill-foreground" />
            </g>
          </motion.g>
        )}

        {/* the keyboard's way in, on the bright star */}
        <g
          role="button"
          tabIndex={locked ? -1 : 0}
          aria-disabled={locked}
          aria-label={`Trace the stars to ${action}`}
          className="outline-none focus-visible:[&>circle]:stroke-ring"
          onKeyDown={key}
        >
          <circle
            cx={STARS[0].x}
            cy={STARS[0].y}
            r={START_R - 10}
            fill="transparent"
            stroke="transparent"
            strokeWidth={2}
          />
        </g>
      </svg>
      <p
        aria-live="polite"
        className={cn(
          'type-micro',
          tracing || closed ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {word}
      </p>
    </div>
  );
}
