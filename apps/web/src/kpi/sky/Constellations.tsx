import { animate, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useNarrow } from '@/workspace/useMedia';
import type { GaugeTone } from '../model';
import type { BodyKey, KpiSkyModel, SkyBody } from './model';
import {
  BodyLens,
  dust,
  Lens,
  relPoint,
  SPARKLE,
  TONE_VAR,
  useOnce,
  useRose,
  type SceneProps,
} from './parts';
import { litOf, shapeOf } from './shapes';

const W = 1000;
const H = 440;
const SKY_DUST = dust(110, 11, W, H);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One KPI as a constellation in `box`. Lit stars are reached, joined by lines; the rest are dim with dashed lines.
 * The target's star wears a halo. The bug ratio is a lantern instead: its dashed ring is the limit, and a cloud as wide
 * as the ratio fills it, spilling out red when it is over. Shared by Constellations and Tide.
 */
export function ConstellationFigure({
  body,
  model,
  box,
  uid,
  flare,
  still,
  muted = false,
}: {
  body: SkyBody;
  model: KpiSkyModel;
  box: Box;
  uid: string;
  flare: boolean;
  still: boolean;
  /** Drawn under water: no glow, no motion. */
  muted?: boolean;
}) {
  const shape = shapeOf(body.key, model.research.required);
  const n = shape.stars.length;
  const research = body.key === 'research';
  const { lit: litRaw, targetStar } = litOf(body, n);
  const lit = research
    ? Math.min(n, Math.round((model.research.count / Math.max(1, model.research.required)) * n))
    : litRaw;
  const pt = (i: number) => {
    const [u, v] = shape.stars[i]!;
    return [box.x + u * box.w, box.y + v * box.h] as const;
  };
  const critical = body.tone === 'critical';
  const met = body.met === true;
  const edges: [number, number][] = [
    ...Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]),
    ...(shape.close ?? []).map(([a, b]) => [a, b] as [number, number]),
  ];

  // The lantern: a ring for the limit, a cloud for the ratio, both scaled from the same radius.
  const lantern = body.inverse;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.55;
  const ringR = box.h * 0.36;
  const max = Math.max(model.bugs.max, 0.0001);
  const cloudR = ringR * Math.min(1.6, model.bugs.ratio / max);

  return (
    <g>
      {lantern && (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={Math.max(2, cloudR)}
            fill={`url(#${uid}-${model.bugs.overLimit ? 'fog-bad' : 'fog'})`}
            className={!still && !muted ? 'kpi-breathe' : undefined}
            style={{ transformOrigin: `${cx}px ${cy}px` }}
          />
          <circle
            cx={cx}
            cy={cy}
            r={ringR}
            fill="none"
            className="stroke-foreground/50"
            strokeWidth={1.25}
            strokeDasharray="3 5"
          />
          <text
            x={cx + ringR * 0.74}
            y={cy + ringR * 0.92}
            className="fill-muted-foreground font-mono"
            fontSize={11}
          >
            limit
          </text>
        </>
      )}

      {/* the lines, star to star */}
      {edges.map(([a, b]) => {
        const on = lantern ? true : Math.max(a, b) < lit;
        const [x1, y1] = pt(a);
        const [x2, y2] = pt(b);
        return (
          <motion.line
            key={`${a}-${b}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            className={
              on
                ? critical && !lantern
                  ? 'stroke-destructive'
                  : 'stroke-foreground'
                : 'stroke-foreground/25'
            }
            strokeWidth={on ? 1.6 : 1}
            strokeDasharray={on ? undefined : '2 5'}
            strokeLinecap="round"
            initial={still ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.7, delay: 0.25 + a * 0.08, ease: [0.22, 1, 0.36, 1] }}
          />
        );
      })}

      {/* the flare when its line is met */}
      {flare && met && !still && !muted && (
        <motion.path
          d={`M${shape.stars.map((_, i) => pt(i).join(' ')).join(' L')}`}
          fill="none"
          className="stroke-terracotta"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 1 }}
          animate={{ pathLength: 1, opacity: [1, 1, 0] }}
          transition={{ duration: 1.4, delay: 1, ease: 'easeInOut' }}
        />
      )}

      {/* the stars */}
      {shape.stars.map((_, i) => {
        const [x, y] = pt(i);
        const on = lantern ? true : i < lit;
        const isTarget = targetStar === i;
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            {on && !muted && <circle r={met ? 16 : 11} fill={`url(#${uid}-glow-${body.tone})`} />}
            {isTarget && (
              <circle
                r={13}
                fill="none"
                className={cn(
                  on ? 'stroke-foreground' : 'stroke-foreground/60',
                  critical && !on && 'stroke-destructive',
                )}
                strokeWidth={1.25}
              />
            )}
            {isTarget && critical && !on && !still && !muted && (
              <motion.circle
                fill="none"
                className="stroke-destructive"
                initial={{ r: 10, opacity: 0.9 }}
                animate={{ r: 30, opacity: 0 }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
              />
            )}
            <path
              d={SPARKLE}
              transform={`scale(${on ? (met ? 0.95 : 0.8) : 0.5})`}
              className={cn(
                on ? 'fill-foreground' : 'fill-none stroke-foreground/50',
                on && !still && !muted && 'kpi-twinkle',
              )}
              strokeWidth={on ? 0 : 2}
              style={{
                animationDelay: `${-i * 0.7}s`,
                transformBox: 'fill-box',
                transformOrigin: 'center',
              }}
            />
          </g>
        );
      })}
    </g>
  );
}

/** The shared sky defs: the star glow, the lantern's two clouds, the comet's tail. */
export function SkyDefs({ uid }: { uid: string }) {
  return (
    <defs>
      {(Object.keys(TONE_VAR) as GaugeTone[]).map((t) => (
        <radialGradient key={t} id={`${uid}-glow-${t}`}>
          <stop offset="0%" style={{ stopColor: TONE_VAR[t], stopOpacity: 0.6 }} />
          <stop offset="100%" style={{ stopColor: TONE_VAR[t], stopOpacity: 0 }} />
        </radialGradient>
      ))}
      <radialGradient id={`${uid}-fog`}>
        <stop offset="0%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0.55 }} />
        <stop offset="100%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0 }} />
      </radialGradient>
      <radialGradient id={`${uid}-fog-bad`}>
        <stop offset="0%" style={{ stopColor: 'var(--destructive)', stopOpacity: 0.55 }} />
        <stop offset="100%" style={{ stopColor: 'var(--destructive)', stopOpacity: 0 }} />
      </radialGradient>
      <linearGradient id={`${uid}-tail`} x1="0" x2="1">
        <stop offset="0%" style={{ stopColor: 'var(--foreground)', stopOpacity: 0 }} />
        <stop offset="100%" style={{ stopColor: 'var(--foreground)', stopOpacity: 0.85 }} />
      </linearGradient>
      <radialGradient id={`${uid}-nightfall`} cx="50%" cy="0%" r="100%">
        <stop offset="0%" style={{ stopColor: 'var(--emphasis)', stopOpacity: 0.14 }} />
        <stop offset="100%" style={{ stopColor: 'var(--emphasis)', stopOpacity: 0 }} />
      </radialGradient>
    </defs>
  );
}

/** A comet across the sky, when a number rose since the last render. */
export function Comet({ uid, run }: { uid: string; run: number }) {
  if (run === 0) return null;
  return (
    <motion.g
      key={run}
      initial={{ x: -60, y: 40, opacity: 0 }}
      animate={{ x: W + 120, y: 180, opacity: [0, 1, 1, 0] }}
      transition={{ duration: 1.6, ease: [0.4, 0, 0.9, 0.6] }}
    >
      <g transform={`rotate(${(Math.atan2(140, W + 180) * 180) / Math.PI})`}>
        <path d="M-140 -2.5 L0 -1.4 L0 1.4 L-140 2.5 Z" fill={`url(#${uid}-tail)`} />
        <path d={SPARKLE} className="fill-foreground" />
      </g>
    </motion.g>
  );
}

/** Label under a figure: name, poster number, state with its mark. */
function FigureLabel({
  body,
  x,
  y,
  align = 'middle',
}: {
  body: SkyBody;
  x: number;
  y: number;
  align?: 'middle' | 'start';
}) {
  return (
    <g>
      <text
        x={x}
        y={y}
        textAnchor={align}
        className="fill-muted-foreground text-micro font-semibold uppercase"
        letterSpacing={1}
      >
        {body.gauge.label}
      </text>
      <text
        x={x}
        y={y + 34}
        textAnchor={align}
        className="fill-foreground font-semibold tabular-nums"
        fontSize={32}
        letterSpacing={-1}
      >
        {body.gauge.valueText}
      </text>
      <text
        x={x}
        y={y + 54}
        textAnchor={align}
        className={cn(
          'text-micro',
          body.tone === 'critical'
            ? 'fill-destructive'
            : body.tone === 'warning'
              ? 'fill-warning'
              : 'fill-muted-foreground',
        )}
      >
        {body.tone === 'critical' ? '● ' : body.tone === 'warning' ? '▲ ' : body.met ? '✓ ' : ''}
        {body.gauge.status.label}
      </text>
    </g>
  );
}

/**
 * Theme 2, Constellations: one constellation per KPI across the night. A KPI lights its stars as it climbs and joins
 * them with lines; the target star wears a halo and, while it is out of reach on a failing KPI, pulses red. A met line
 * flares once a month. The sky drifts with the pointer; click a constellation to fly to it.
 */
export function Constellations({ model, focus, onFocus, onPick, compact, still }: SceneProps) {
  const uid = useId().replace(/:/g, '');
  const narrow = useNarrow();
  const svgRef = useRef<SVGSVGElement>(null);
  const far = useRef<SVGGElement>(null);
  const near = useRef<SVGGElement>(null);
  const [lens, setLens] = useState<{ x: number; y: number; body: BodyKey } | null>(null);
  const [zoom, setZoom] = useState<BodyKey | null>(null);
  const [vb, setVb] = useState<Box>({ x: 0, y: 0, w: W, h: H });
  const [comet, setComet] = useState(0);
  const flare = useOnce(
    `kpi-stars-flare-${model.month}`,
    model.bodies.some((b) => b.met),
  );
  const rose = useRose(model.bodies.reduce((s, b) => s + (b.fraction ?? 0), 0));
  useEffect(() => {
    if (rose && !still) setComet((c) => c + 1);
  }, [rose, still]);

  const bodies = model.bodies;
  const cols = narrow || compact ? Math.min(2, bodies.length) : bodies.length;
  const rows = Math.ceil(bodies.length / Math.max(1, cols));
  const cellW = W / Math.max(1, cols);
  const cellH = (narrow || compact ? 520 : H) / rows;
  const viewH = narrow || compact ? 520 : H;
  const boxOf = (i: number): Box => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const pad = cellW * 0.16;
    const figH = cellH * (compact ? 0.74 : narrow ? 0.5 : 0.56);
    return { x: c * cellW + pad, y: r * cellH + 28, w: cellW - pad * 2, h: figH };
  };
  const full: Box = { x: 0, y: 0, w: W, h: viewH };

  // Fly the camera between the whole sky and one constellation.
  useEffect(() => {
    const i = zoom ? bodies.findIndex((b) => b.key === zoom) : -1;
    const b = i >= 0 ? boxOf(i) : null;
    const to: Box = b
      ? { x: b.x - b.w * 0.35, y: b.y - b.h * 0.25, w: b.w * 1.7, h: (b.w * 1.7 * viewH) / W }
      : full;
    const from = vb;
    if (still) {
      setVb(to);
      return;
    }
    const ctl = animate(0, 1, {
      duration: 0.9,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (p) =>
        setVb({
          x: from.x + (to.x - from.x) * p,
          y: from.y + (to.y - from.y) * p,
          w: from.w + (to.w - from.w) * p,
          h: from.h + (to.h - from.h) * p,
        }),
    });
    return () => ctl.stop();
    // The camera animates from wherever it is now, so `vb` is read, not watched.
  }, [zoom, cols, viewH, still]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (still || !svgRef.current) return;
    const p = relPoint(e, svgRef.current);
    const dx = (p.x - 0.5) * 2;
    const dy = (p.y - 0.5) * 2;
    far.current?.setAttribute(
      'transform',
      `translate(${(-dx * 10).toFixed(1)} ${(-dy * 6).toFixed(1)})`,
    );
    near.current?.setAttribute(
      'transform',
      `translate(${(dx * 4).toFixed(1)} ${(dy * 3).toFixed(1)})`,
    );
  };
  const zoomed = zoom ? model.byKey[zoom] : undefined;

  return (
    <div className="relative overflow-hidden rounded-lg">
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        className="block w-full touch-pan-y select-none"
        style={{ aspectRatio: `${W} / ${viewH}` }}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setLens(null);
          onFocus(null);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setZoom(null);
        }}
        aria-hidden
      >
        <SkyDefs uid={uid} />
        <rect
          x={-50}
          y={-50}
          width={W + 100}
          height={viewH + 100}
          fill={`url(#${uid}-nightfall)`}
          onClick={() => setZoom(null)}
        />
        <g ref={far} pointerEvents="none">
          {SKY_DUST.filter((d) => d.y < viewH).map((d, i) => (
            <circle
              key={i}
              cx={d.x}
              cy={d.y * (viewH / H)}
              r={d.r}
              className={cn('fill-foreground/40', !still && 'kpi-twinkle')}
              style={{
                animationDelay: `${-d.phase}s`,
                transformBox: 'fill-box',
                transformOrigin: 'center',
              }}
            />
          ))}
        </g>
        <g ref={near}>
          {bodies.map((b, i) => {
            const box = boxOf(i);
            const on = focus === b.key || zoom === b.key;
            return (
              <g
                key={b.key}
                className="cursor-pointer transition-opacity duration-300"
                opacity={(focus || zoom) && !on ? 0.28 : 1}
                onPointerEnter={() => onFocus(b.key)}
                onPointerMove={(e) =>
                  svgRef.current && setLens({ ...relPoint(e, svgRef.current), body: b.key })
                }
                onPointerLeave={() => setLens(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setLens(null);
                  setZoom((z) => (z === b.key ? null : b.key));
                }}
              >
                <rect
                  x={box.x - 20}
                  y={box.y - 20}
                  width={box.w + 40}
                  height={box.h + 110}
                  fill="transparent"
                />
                <ConstellationFigure
                  body={b}
                  model={model}
                  box={box}
                  uid={uid}
                  flare={flare}
                  still={still}
                />
                {!compact && <FigureLabel body={b} x={box.x + box.w / 2} y={box.y + box.h + 30} />}
              </g>
            );
          })}
        </g>
        <Comet uid={uid} run={comet} />
      </svg>
      {!zoom && <Lens at={lens}>{lens && <BodyLens model={model} k={lens.body} />}</Lens>}
      {zoomed && (
        <motion.div
          className="absolute right-3 bottom-3 z-10 grid w-72 max-w-[calc(100%-1.5rem)] gap-2 rounded-lg border border-hairline p-4 text-sm shadow-lg"
          style={{ background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)' }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: still ? 0 : 0.4 }}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="type-micro text-muted-foreground">
              {shapeOf(zoomed.key, model.research.required).name}
            </span>
            <button
              type="button"
              aria-label="Back to the whole sky"
              className="tactile -m-1 rounded p-1 hover:bg-accent/70"
              onClick={() => setZoom(null)}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <BodyLens model={model} k={zoomed.key} />
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => onPick(zoomed.key)}
          >
            <ArrowDownRight aria-hidden />
            Open the numbers
          </Button>
        </motion.div>
      )}
    </div>
  );
}
