import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from 'motion/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { vibrate } from '@/lib/haptics';
import { SPRING } from '@/lib/motion/presets';
import { playSound } from '@/lib/sound/engine';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { BASE, Dust, Gem, GlassGradients, Mote, SealBurst, prism } from './parts';

const W = 520;
const H = 186;
const CX = 260;
/** How far the progress rule runs out from the seed, each way. */
const RULE = 220;
/** How long a full hold takes. Long enough to be a choice, short enough not to be a chore. */
const GROW_S = 1.4;
const REDUCED_HOLD_S = 0.6;
const MOTES = 22;
/** The crystal gains a facet at each of these, and the finger feels it. */
const STAGES = [1 / 3, 2 / 3, 1];

/**
 * Hold to start. Press and hold the seed: grains stream in from the air and a crystal grows up from the ink line, facet
 * by facet. Let go early and it breaks back into dust; hold until it seals and `onFire` runs, exactly as if the page's
 * own button had been pressed (same checks, same refusals). Two labels grow twins, one per artefact. Enter or Space on
 * it fires too, and the page keeps its button for anyone who would rather press. Builds and Release both use it.
 */
export function CrystalTrigger({
  ready,
  busy,
  failed,
  labels,
  action,
  lockedHint,
  onFire,
}: {
  ready: boolean;
  busy: boolean;
  /** The last start was refused. The crystal then settles back quietly: errors are a calm zone. */
  failed: boolean;
  /** One label per crystal, under it: one or two. */
  labels: string[];
  /** What a full hold does, after "Hold to": "start a staging build", "simulate the release". */
  action: string;
  /** Why it is locked when `ready` is false. */
  lockedHint: string;
  onFire: () => void;
}) {
  const reduced = useReducedMotion();
  const uid = useId();
  const glowId = `${uid}-glow`;
  const haloId = `${uid}-halo`;
  const allId = `${uid}-all`;

  const growth = useMotionValue(0);
  const stream = useMotionValue(0);
  const flash = useMotionValue(0);
  const pop = useMotionValue(1);
  const lift = useMotionValue(0);
  const fade = useMotionValue(1);
  const seedPop = useMotionValue(1);
  const twinGrowth = useTransform(growth, [0.12, 1], [0, 1]);
  const seedScale = useTransform(growth, [0, 0.2], [1, 0.3]);
  const halo = useTransform(growth, [0, 1], [0, 0.85]);
  const ruleLeft = useTransform(growth, (g) => CX - g * RULE);
  const ruleRight = useTransform(growth, (g) => CX + g * RULE);

  const [pct, setPct] = useState(0);
  const stage = useRef(0);
  const [holding, setHolding] = useState(false);
  const [hover, setHover] = useState(false);
  const [sealed, setSealed] = useState(false);
  const [dissolved, setDissolved] = useState(false);
  const [burst, setBurst] = useState(0);
  const [dust, setDust] = useState<{ n: number; reached: number } | null>(null);
  const run = useRef<ReturnType<typeof animate> | null>(null);
  const sealedRef = useRef(false);
  /** Whether the start this seal fired was seen in flight. If it never was (a form check stopped it), nothing left. */
  const sawBusy = useRef(false);
  const locked = !ready || busy;

  useMotionValueEvent(growth, 'change', (g) => {
    setPct(Math.round(g * 100));
    const passed = STAGES.filter((s) => g >= s - 0.001).length;
    if (passed > stage.current && g < 1) vibrate('tick');
    stage.current = passed;
  });

  const twin = labels.length > 1;
  const shapes = twin ? [prism(236, 52, 128), prism(298, 40, 96)] : [prism(CX, 52, 128)];
  const growthOf = (i: number) => (i === 0 ? growth : twinGrowth);

  const backToSeed = () => {
    sealedRef.current = false;
    sawBusy.current = false;
    setSealed(false);
    seedPop.set(0);
    void animate(seedPop, 1, reduced ? { duration: 0 } : SPRING.wobble);
  };

  // Hold the sealed crystal while the start is in flight. Then it lifts off, or, if the start was refused or never
  // went out, settles back without ceremony.
  useEffect(() => {
    if (!sealedRef.current) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      if (failed || reduced || !sawBusy.current) {
        void animate(growth, 0, reduced ? { duration: 0 } : SPRING.settle);
        backToSeed();
        return;
      }
      void animate(lift, -34, { duration: 0.5, ease: [0.5, 0, 0.75, 0] });
      void animate(fade, 0, { duration: 0.5, ease: 'easeIn' }).then(() => {
        growth.set(0);
        lift.set(0);
        fade.set(1);
        backToSeed();
      });
    }, 550);
    return () => window.clearTimeout(t);
  }, [busy, sealed]);

  const seal = () => {
    if (sealedRef.current) return;
    sealedRef.current = true;
    sawBusy.current = false;
    setSealed(true);
    setHolding(false);
    void animate(stream, 0, { duration: 0.2 });
    if (!reduced) {
      setBurst((n) => n + 1);
      void animate(flash, [0, 0.65, 0], { duration: 0.6, times: [0, 0.12, 1] });
      void animate(pop, [1, 1.09, 0.98, 1], { duration: 0.6, ease: 'easeOut' });
    }
    playSound('tick');
    vibrate('pop');
    onFire();
  };

  const grow = (duration: number, ease: 'linear' | 'easeOut', delay = 0) => {
    run.current?.stop();
    void animate(stream, 1, { duration: 0.15 });
    run.current = animate(growth, 1, { duration, ease, delay });
    run.current.then(() => {
      if (growth.get() >= 1) seal();
    });
  };

  const down = (e: PointerEvent<SVGGElement>) => {
    if (locked || sealedRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setHolding(true);
    setDissolved(false);
    if (reduced) grow(0, 'linear', REDUCED_HOLD_S);
    else grow(GROW_S * (1 - growth.get()), 'linear');
  };
  const up = () => {
    if (!holding || sealedRef.current) return;
    setHolding(false);
    run.current?.stop();
    void animate(stream, 0, { duration: 0.2 });
    const reached = growth.get();
    if (reached >= 1) return;
    setDissolved(reached > 0.05);
    if (!reduced && reached > 0.05) setDust((d) => ({ n: (d?.n ?? 0) + 1, reached }));
    void animate(growth, 0, reduced ? { duration: 0 } : { duration: 0.3, ease: 'easeIn' });
  };
  const key = (e: KeyboardEvent<SVGGElement>) => {
    if (locked || sealedRef.current || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    grow(reduced ? 0 : 0.45, 'easeOut');
  };

  const word = busy
    ? 'Starting…'
    : sealed
      ? 'Sealed'
      : !ready
        ? lockedHint
        : holding
          ? pct >= 85
            ? 'Almost…'
            : 'Growing…'
          : dissolved
            ? 'Too soon, it broke. Hold until it seals'
            : `Hold the seed to ${action}`;
  const facets = STAGES.filter((s) => pct >= Math.round(s * 100)).length;
  const live = holding || sealed;
  const idle = ready && !live && !busy && !reduced;

  return (
    <div className="grid gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={cn(
          'block h-auto w-full max-w-xl touch-none select-none overflow-visible',
          locked && !sealed && 'opacity-45',
        )}
      >
        <defs>
          <GlassGradients glowId={glowId} haloId={haloId} />
          <clipPath id={allId}>
            {shapes.map((s) => (
              <path key={s.outline} d={s.outline} />
            ))}
          </clipPath>
        </defs>

        {/* the HUD: facets cut so far, and a three-digit counter like the loader's */}
        <g className={cn('transition-opacity duration-300', live ? 'opacity-100' : 'opacity-40')}>
          <text x={40} y={26} className="fill-muted-foreground text-micro font-semibold uppercase">
            Facets
          </text>
          {STAGES.map((s, i) => (
            <rect
              key={s}
              x={44 + i * 14}
              y={36}
              width={7}
              height={7}
              transform={`rotate(45 ${47.5 + i * 14} 39.5)`}
              className={
                i < facets ? 'fill-foreground' : 'fill-none stroke-foreground/40 [stroke-width:1]'
              }
            />
          ))}
          <text
            x={W - 40}
            y={40}
            textAnchor="end"
            className="fill-foreground font-mono"
            fontSize={30}
            letterSpacing={-1}
          >
            {String(pct).padStart(3, '0')}
          </text>
        </g>

        {/* the halo under the crystal, like the light under the 3D ones */}
        <motion.ellipse
          cx={CX + (twin ? 6 : 0)}
          cy={BASE}
          rx={110}
          ry={14}
          fill={`url(#${haloId})`}
          style={{ opacity: halo }}
        />

        {/* the ink line, and the rule that runs out from the seed as it grows */}
        <line x1={40} x2={W - 40} y1={BASE} y2={BASE} className="stroke-foreground/20" />
        <motion.line
          x1={CX}
          x2={ruleLeft}
          y1={BASE}
          y2={BASE}
          className="stroke-foreground"
          strokeWidth={1.5}
        />
        <motion.line
          x1={CX}
          x2={ruleRight}
          y1={BASE}
          y2={BASE}
          className="stroke-foreground"
          strokeWidth={1.5}
        />
        {STAGES.flatMap((s, i) =>
          [-1, 1].map((side) => (
            <line
              key={`${s}${side}`}
              x1={CX + side * s * RULE}
              x2={CX + side * s * RULE}
              y1={BASE - 4}
              y2={BASE + 4}
              className={cn(
                'transition-[stroke] duration-200',
                i < facets ? 'stroke-foreground' : 'stroke-foreground/25',
              )}
            />
          )),
        )}

        {/* growth rings while held; one slow pulse inviting a hold when idle */}
        {holding &&
          !reduced &&
          [0, 1, 2].map((i) => (
            <motion.ellipse
              key={`ring-${i}`}
              cx={CX}
              cy={BASE}
              fill="none"
              className="stroke-foreground/40"
              initial={{ rx: 6, ry: 1.5, opacity: 0.7 }}
              animate={{ rx: 140, ry: 13, opacity: 0 }}
              transition={{ duration: 1.3, repeat: Infinity, delay: i * 0.43, ease: 'easeOut' }}
            />
          ))}
        {idle && (
          <motion.ellipse
            cx={CX}
            cy={BASE}
            fill="none"
            className="stroke-foreground/30"
            initial={{ rx: 4, ry: 1, opacity: 0.8 }}
            animate={{ rx: 60, ry: 6, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 1.4, ease: 'easeOut' }}
          />
        )}

        {/* the crystals; they tremble with strain near the end, pop on the seal, and lift off once started */}
        <motion.g
          style={{ scale: pop, y: lift, opacity: fade, originX: 0.5, originY: 1 }}
          className={cn(holding && pct >= 85 && !reduced && 'crystal-strain')}
        >
          {shapes.map((shape, i) => (
            <Gem
              key={shape.outline}
              shape={shape}
              growth={growthOf(i)}
              flash={flash}
              hover={hover && !locked && !live}
              glowId={glowId}
            />
          ))}
        </motion.g>

        {/* grains drawn in to the growth front */}
        {!reduced &&
          Array.from({ length: MOTES }, (_, i) => {
            const shape = shapes[i % shapes.length]!;
            const g = growthOf(i % shapes.length);
            return (
              <Mote
                key={`${shape.outline}-${i}`}
                i={i}
                clock={g}
                growth={g}
                stream={stream}
                shape={shape}
              />
            );
          })}

        {burst > 0 && <SealBurst key={`burst-${burst}`} shapes={shapes} clip={allId} cx={CX} />}
        {dust && <Dust key={`dust-${dust.n}`} shapes={shapes} reached={dust.reached} />}

        {/* labels: one per crystal */}
        {shapes.map((s, i) => (
          <text
            key={`label-${s.outline}`}
            x={s.cx}
            y={BASE + 20}
            textAnchor="middle"
            className="fill-muted-foreground text-micro font-semibold uppercase"
          >
            {labels[i]}
          </text>
        ))}

        {/* the seed: the handle you hold */}
        <g
          role="button"
          tabIndex={locked ? -1 : 0}
          aria-disabled={locked}
          aria-label={`Hold to ${action}`}
          className={cn(
            'outline-none focus-visible:[&>circle]:stroke-ring',
            locked ? 'cursor-not-allowed' : holding ? 'cursor-grabbing' : 'cursor-pointer',
          )}
          onPointerDown={down}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onKeyDown={key}
        >
          {/* a generous hold area over the whole crystal */}
          <circle
            cx={CX}
            cy={(BASE + 22) / 2}
            r={80}
            fill="transparent"
            stroke="transparent"
            strokeWidth={2}
          />
          <motion.g
            style={{ originX: 0.5, originY: 0.5 }}
            animate={idle ? { scale: [1, 1.18, 1] } : { scale: 1 }}
            transition={
              idle ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' } : SPRING.press
            }
          >
            <motion.g style={{ scale: seedPop, originX: 0.5, originY: 0.5 }}>
              <motion.path
                d={`M${CX} ${BASE - 13} L${CX + 9} ${BASE - 4} L${CX} ${BASE + 5} L${CX - 9} ${BASE - 4} Z`}
                style={{ scale: seedScale, originX: 0.5, originY: 0.5 }}
                className={hover && !locked ? 'fill-terracotta' : 'fill-foreground'}
              />
            </motion.g>
          </motion.g>
        </g>
      </svg>
      <p
        aria-live="polite"
        className={cn('type-micro', live ? 'text-foreground' : 'text-muted-foreground')}
      >
        {word}
      </p>
    </div>
  );
}
