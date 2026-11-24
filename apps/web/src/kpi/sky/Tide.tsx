import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { useNarrow } from '@/workspace/useMedia';
import type { BodyKey } from './model';
import { Comet, ConstellationFigure, SkyDefs, type Box } from './Constellations';
import {
  BodyLens,
  dust,
  hashUnit,
  Lens,
  relPoint,
  useFrame,
  useOnce,
  useRose,
  type SceneProps,
} from './parts';

const W = 1000;
const H = 470;
const HZ = 282;
const SKY_DUST = dust(90, 23, W, HZ);
const MAX_MOTES = 20;
const MAX_STONES = 6;
/** The moon's path: rises on the left on the 1st, sets on the right at month end. */
const moonAt = (t: number) => ({ x: 70 + t * 860, y: HZ - 22 - Math.sin(Math.PI * t) * 228 });

/**
 * Theme 3, the Tide: the constellations over a dream pool, and the waterline is the line every KPI is judged against.
 * A KPI rises as it climbs; on target it stands clear of the water and shines, short of it it is still under, seen
 * dim and wavering through the water. The sky is reflected below. The moon crosses the sky with the month, and is as
 * full as the work done. Bugs are ink sinking in the water; late cards are rocks at the shore.
 */
export function Tide({ model, focus, onFocus, onPick, onPickLate, compact, still }: SceneProps) {
  const uid = useId().replace(/:/g, '');
  const narrow = useNarrow();
  const bare = compact || narrow;
  const svgRef = useRef<SVGSVGElement>(null);
  const under = useRef<SVGGElement>(null);
  const mirror = useRef<SVGGElement>(null);
  const moteRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [lens, setLens] = useState<{
    x: number;
    y: number;
    body: BodyKey | `late:${number}`;
  } | null>(null);
  const [comet, setComet] = useState(0);
  const flare = useOnce(
    `kpi-tide-flare-${model.month}`,
    model.bodies.some((b) => b.met),
  );
  const rose = useRose(model.bodies.reduce((s, b) => s + b.rise, 0));
  useEffect(() => {
    if (rose && !still) setComet((c) => c + 1);
  }, [rose, still]);

  const bodies = model.bodies;
  const n = Math.max(1, bodies.length);
  const slot = (W - 160) / n;
  const boxOf = (i: number, rise: number): Box => {
    const w = Math.min(170, slot * 0.72);
    const h = w * 0.78;
    // rise 1: the figure's foot sits just above the water. rise 0: it is drowned to its crown.
    const foot = HZ - 14 + (1 - rise) * (h * 0.95);
    return { x: 160 + i * slot + (slot - w) / 2, y: foot - h, w, h };
  };

  const motes = useMemo(
    () =>
      Array.from(
        { length: model.byKey.bug ? Math.min(MAX_MOTES, model.bugs.count) : 0 },
        (_, i) => ({
          x: 170 + hashUnit(`t${i}`, 7) * (W - 200),
          speed: 0.03 + hashUnit(`s${i}`, 8) * 0.04,
          phase: hashUnit(`q${i}`, 9),
          r: 2 + hashUnit(`z${i}`, 10) * 2,
        }),
      ),
    [model.byKey.bug, model.bugs.count],
  );
  const stones = model.late.slice(0, MAX_STONES);
  const longest = Math.max(1, ...stones.map((s) => s.lateByMs));
  const moon = moonAt(model.monthProgress);
  const full = model.level.fraction ?? 0;
  const murky = !!model.byKey.bug && model.bugs.overLimit;

  useFrame((t) => {
    const sway = Math.sin(t * 0.9) * 3;
    under.current?.setAttribute('transform', `translate(${sway.toFixed(2)} 0)`);
    mirror.current?.setAttribute(
      'transform',
      `translate(${(-sway * 1.4).toFixed(2)} ${2 * HZ + 4}) scale(1 ${(-0.62 - Math.sin(t * 1.3) * 0.02).toFixed(3)})`,
    );
    moteRefs.current.forEach((el, i) => {
      const m = motes[i];
      if (!el || !m) return;
      const p = (t * m.speed + m.phase) % 1;
      el.setAttribute('cy', (HZ + 10 + p * (H - HZ - 30)).toFixed(1));
      el.setAttribute('cx', (m.x + Math.sin(t + m.phase * 7) * 6).toFixed(1));
      el.setAttribute('opacity', (Math.sin(p * Math.PI) * 0.85).toFixed(2));
    });
  }, !still);

  const hover = (body: BodyKey | `late:${number}`) => (e: PointerEvent<SVGElement>) => {
    if (!svgRef.current) return;
    setLens({ ...relPoint(e, svgRef.current), body });
    if (!body.startsWith('late:')) onFocus(body as BodyKey);
  };
  const lateIdx =
    lens && String(lens.body).startsWith('late:') ? Number(String(lens.body).slice(5)) : null;

  const figures = (muted: boolean) =>
    bodies.map((b, i) => (
      <g
        key={b.key}
        opacity={focus && focus !== b.key ? 0.25 : 1}
        className="transition-opacity duration-300"
      >
        <ConstellationFigure
          body={b}
          model={model}
          box={boxOf(i, b.rise)}
          uid={uid}
          flare={flare && !muted}
          still={still || muted}
          muted={muted}
        />
      </g>
    ));

  return (
    <div className="relative overflow-hidden rounded-lg">
      <svg
        ref={svgRef}
        viewBox={bare ? `120 0 ${W - 120} ${H}` : `0 0 ${W} ${H}`}
        className="block w-full touch-pan-y select-none"
        onPointerLeave={() => {
          setLens(null);
          onFocus(null);
        }}
        aria-hidden
      >
        <SkyDefs uid={uid} />
        <defs>
          <clipPath id={`${uid}-sky`}>
            <rect x={0} y={-20} width={W} height={HZ + 20} />
          </clipPath>
          <clipPath id={`${uid}-sea`}>
            <rect x={0} y={HZ} width={W} height={H - HZ} />
          </clipPath>
          <linearGradient id={`${uid}-water`} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              style={{
                stopColor: murky
                  ? 'color-mix(in oklch, var(--terracotta) 78%, var(--destructive))'
                  : 'var(--terracotta)',
                stopOpacity: 0.55,
              }}
            />
            <stop
              offset="100%"
              style={{
                stopColor: 'color-mix(in oklch, var(--emphasis) 45%, var(--scrim))',
                stopOpacity: 0.96,
              }}
            />
          </linearGradient>
          <filter id={`${uid}-ripple`} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.008 0.09" numOctaves={2} seed={4} />
            <feDisplacementMap
              in="SourceGraphic"
              scale={10}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
          <mask id={`${uid}-phase`}>
            <circle cx={moon.x} cy={moon.y} r={24} fill="white" />
            <circle cx={moon.x + 4 + full * 48} cy={moon.y - 4} r={24} fill="black" />
          </mask>
          <radialGradient id={`${uid}-moonglow`}>
            <stop offset="0%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        {/* the sky */}
        <rect x={0} y={0} width={W} height={HZ} fill={`url(#${uid}-nightfall)`} />
        <g pointerEvents="none">
          {SKY_DUST.map((d, i) => (
            <circle
              key={i}
              cx={d.x}
              cy={d.y}
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

        {/* the moon: where we are in the month, as full as the work done */}
        <path
          d={`M70 ${HZ - 22} Q500 ${HZ - 22 - 456} 930 ${HZ - 22}`}
          fill="none"
          className="stroke-foreground/15"
          strokeDasharray="1 7"
          strokeLinecap="round"
        />
        <g
          className="cursor-pointer"
          onPointerMove={hover('completion')}
          onPointerLeave={() => setLens(null)}
          onClick={() => onPick('completion')}
          opacity={focus && focus !== 'completion' ? 0.35 : 1}
        >
          <circle cx={moon.x} cy={moon.y} r={64} fill={`url(#${uid}-moonglow)`} />
          <circle
            cx={moon.x}
            cy={moon.y}
            r={24}
            className="fill-foreground/10 stroke-foreground/30"
            strokeWidth={1}
          />
          <circle
            cx={moon.x}
            cy={moon.y}
            r={24}
            className="fill-foreground"
            mask={`url(#${uid}-phase)`}
          />
          {!bare && (
            <text
              x={moon.x}
              y={moon.y + 44}
              textAnchor="middle"
              className="fill-muted-foreground font-mono"
              fontSize={11}
            >
              {model.current
                ? `${Math.round(model.monthProgress * 100)}% of the month`
                : 'month closed'}
            </text>
          )}
        </g>

        {/* the constellations, the parts above water */}
        <g clipPath={`url(#${uid}-sky)`}>{figures(false)}</g>

        {/* the water */}
        <rect x={0} y={HZ} width={W} height={H - HZ} fill={`url(#${uid}-water)`} />
        <g clipPath={`url(#${uid}-sea)`} filter={`url(#${uid}-ripple)`} pointerEvents="none">
          {/* the reflection of the whole sky, and the drowned parts seen through the water */}
          <g ref={mirror} opacity={0.22} transform={`translate(0 ${2 * HZ + 4}) scale(1 -0.62)`}>
            {figures(true)}
          </g>
          <g ref={under} opacity={0.5}>
            {figures(true)}
          </g>
        </g>
        {Array.from({ length: 6 }, (_, i) => (
          <line
            key={i}
            x1={0}
            x2={W}
            y1={HZ + 14 + i * i * 5}
            y2={HZ + 14 + i * i * 5}
            className={cn('stroke-background/40', !still && 'kpi-drift')}
            strokeWidth={1}
            strokeDasharray={`${30 + i * 14} ${60 + i * 20}`}
            style={{ animationDuration: `${14 + i * 4}s` }}
          />
        ))}
        <g
          opacity={focus && focus !== 'bug' ? 0.25 : 1}
          className="transition-opacity duration-300"
        >
          {motes.map((m, i) => (
            <circle
              key={i}
              ref={(el) => {
                moteRefs.current[i] = el;
              }}
              cx={m.x}
              cy={HZ + 20}
              r={m.r}
              className={murky ? 'fill-destructive' : 'fill-background/80'}
            />
          ))}
        </g>

        {/* the waterline: the line */}
        <line x1={0} x2={W} y1={HZ} y2={HZ} className="stroke-foreground/60" strokeWidth={1.25} />
        {!bare && (
          <text
            x={W - 16}
            y={HZ + 18}
            textAnchor="end"
            className="font-mono"
            style={{ fill: 'var(--harbor-label)', opacity: 0.75 }}
            fontSize={11}
          >
            the line · above the water is on target
          </text>
        )}

        {/* late cards: rocks at the shore */}
        {stones.map((s, i) => {
          const size = 10 + (s.lateByMs / longest) * 12;
          const x = 30 + i * 22 + (i % 2) * 6;
          const y = HZ + 6 - (i % 2) * 4;
          return (
            <path
              key={s.id}
              d={`M${x - size} ${y + 4} Q${x - size * 0.8} ${y - size * 0.9} ${x} ${y - size} Q${x + size * 0.9} ${y - size * 0.8} ${x + size} ${y + 4} Z`}
              className={cn(
                'cursor-pointer fill-foreground/85 stroke-background transition-colors',
                lateIdx === i && 'fill-destructive',
              )}
              strokeWidth={1.5}
              onPointerMove={hover(`late:${i}`)}
              onPointerLeave={() => setLens(null)}
              onClick={onPickLate}
            />
          );
        })}

        {/* plaques under the water: each KPI's name and number, and the hit targets for its figure */}
        {bodies.map((b, i) => {
          const box = boxOf(i, b.rise);
          const x = 160 + i * slot + slot / 2;
          if (compact)
            return (
              <rect
                key={b.key}
                x={box.x - 10}
                y={box.y - 10}
                width={box.w + 20}
                height={H - box.y}
                fill="transparent"
                onPointerEnter={() => onFocus(b.key)}
              />
            );
          return (
            <g
              key={b.key}
              className="cursor-pointer transition-opacity duration-300"
              opacity={focus && focus !== b.key ? 0.35 : 1}
              onPointerEnter={() => onFocus(b.key)}
              onPointerMove={hover(b.key)}
              onPointerLeave={() => setLens(null)}
              onClick={() => onPick(b.key)}
            >
              <rect
                x={box.x - 10}
                y={Math.min(box.y, HZ - 40) - 10}
                width={box.w + 20}
                height={H - Math.min(box.y, HZ - 40)}
                fill="transparent"
              />
              <text
                x={x}
                y={H - 76}
                textAnchor="middle"
                className="text-micro font-semibold uppercase"
                style={{ fill: 'var(--harbor-label)', opacity: 0.8 }}
                letterSpacing={1}
              >
                {b.gauge.label}
              </text>
              <text
                x={x}
                y={H - 42}
                textAnchor="middle"
                className="font-semibold tabular-nums"
                style={{ fill: 'var(--harbor-label)' }}
                fontSize={30}
                letterSpacing={-1}
              >
                {b.gauge.valueText}
              </text>
              <text
                x={x}
                y={H - 22}
                textAnchor="middle"
                className="text-micro"
                style={{ fill: 'var(--harbor-label)', opacity: 0.85 }}
              >
                {b.tone === 'critical' ? '● ' : b.tone === 'warning' ? '▲ ' : b.met ? '✓ ' : ''}
                {b.met === null && b.fraction !== null ? 'no line' : b.gauge.status.label}
              </text>
            </g>
          );
        })}
        <Comet uid={uid} run={comet} />
      </svg>
      <Lens at={lens}>
        {lateIdx !== null && stones[lateIdx] ? (
          <div className="grid gap-0.5">
            <span className="type-micro text-muted-foreground">Late card</span>
            <span className="font-medium">{stones[lateIdx].title}</span>
            <span className="font-mono text-destructive">+{stones[lateIdx].lateBy}</span>
          </div>
        ) : lens ? (
          <BodyLens model={model} k={lens.body as BodyKey} />
        ) : null}
      </Lens>
    </div>
  );
}
