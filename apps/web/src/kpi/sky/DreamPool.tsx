import { motion } from 'motion/react';
import { useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { useNarrow } from '@/workspace/useMedia';
import type { BodyKey } from './model';
import { BodyLens, hashUnit, Lens, relPoint, useFrame, useOnce, type SceneProps } from './parts';

const W = 1000;
const H = 440;
const CX = 500;
const CY = 222;
const R = 176;
const FLOOR = CY + R;
const MAX_MOTES = 24;
const MAX_PEARLS = 12;
const MAX_STONES = 8;
const SHAFTS = 5;

const halfChord = (y: number) => Math.sqrt(Math.max(0, R * R - (y - CY) * (y - CY)));
const levelY = (f: number) => FLOOR - f * 2 * R;

/** A pebble: a rounded box whose corners wobble with its seed. */
function stonePath(x: number, y: number, s: number, seed: number) {
  const j = (k: number) => (hashUnit(`s${seed}`, k) - 0.5) * s * 0.35;
  return `M${x - s + j(1)} ${y + j(2)} Q${x - s} ${y - s * 0.7} ${x + j(3)} ${y - s * 0.75 + j(4)} Q${x + s} ${y - s * 0.6} ${x + s + j(5)} ${y + j(6)} Q${x + s * 0.6} ${y + s * 0.55} ${x + j(7)} ${y + s * 0.5} Q${x - s * 0.7} ${y + s * 0.55} ${x - s + j(1)} ${y + j(2)} Z`;
}

interface Callout {
  key: BodyKey;
  x: number;
  y: number;
  anchor: [number, number];
  align: 'start' | 'end';
}

/**
 * Theme 1, the Dream pool: the month as a glass orb. The water is the work done (task completion) and the etched
 * ring is its target. Earned research floats as pearls, missing research
 * waits on the floor as hollow ones. Bugs are ink that sinks through the water and clouds it red over the limit.
 * Light falls in as the SLA hit-rate; a breached card breaks a shaft. Late cards are stones on the bottom. Move the
 * pointer to tip the water; click it to ripple. The legend beside the orb says all of it in words.
 */
export function DreamPool({
  model,
  focus,
  onFocus,
  onPick,
  onPickLate,
  compact,
  still,
}: SceneProps) {
  const uid = useId().replace(/:/g, '');
  const narrow = useNarrow();
  const bare = compact || narrow;
  const svgRef = useRef<SVGSVGElement>(null);
  const front = useRef<SVGPathElement>(null);
  const back = useRef<SVGPathElement>(null);
  const pearlRefs = useRef<(SVGGElement | null)[]>([]);
  const moteRefs = useRef<(SVGCircleElement | null)[]>([]);
  const tilt = useRef({ v: 0, x: 0, target: 0 });
  const [lens, setLens] = useState<{
    x: number;
    y: number;
    body: BodyKey | `late:${number}`;
  } | null>(null);
  const [ripples, setRipples] = useState<{ id: number; x: number }[]>([]);

  const level = model.level.fraction ?? 0;
  const yLevel = levelY(level);
  const target = model.level.target;
  const showBug = !!model.byKey.bug;
  const showResearch = !!model.byKey.research;
  const showSla = !!model.byKey.sla;
  const murky = showBug && model.bugs.overLimit;
  const flare = useOnce(
    `kpi-pool-flare-${model.month}`,
    target !== null && model.level.fraction !== null && model.level.fraction >= target,
  );

  const motes = useMemo(
    () =>
      Array.from({ length: showBug ? Math.min(MAX_MOTES, model.bugs.count) : 0 }, (_, i) => ({
        u: hashUnit(`m${i}`, 3),
        speed: 0.035 + hashUnit(`v${i}`, 4) * 0.05,
        phase: hashUnit(`p${i}`, 5),
        r: 2.2 + hashUnit(`r${i}`, 6) * 2.2,
      })),
    [showBug, model.bugs.count],
  );
  const earned = showResearch ? Math.min(MAX_PEARLS, model.research.count) : 0;
  const missing = showResearch
    ? Math.min(MAX_PEARLS - earned, Math.max(0, model.research.required - model.research.count))
    : 0;
  const stones = model.late.slice(0, MAX_STONES);
  const longest = Math.max(1, ...stones.map((s) => s.lateByMs));

  const finished = model.sla.met + model.sla.breached;
  const broken = finished === 0 ? 0 : Math.round((model.sla.breached / finished) * SHAFTS);
  const light = model.sla.hitRate ?? 0;

  useFrame((t, dt) => {
    const k = tilt.current;
    // A damped spring towards the pointer's tip: water with some weight.
    k.v += ((k.target - k.x) * 40 - k.v * 7) * dt;
    k.x += k.v * dt;
    const amp = level <= 0.001 || level >= 0.999 ? 0 : 5;
    const surface = (x: number, phase: number) =>
      yLevel +
      k.x * (x - CX) +
      amp * Math.sin(x * 0.021 + t * 1.5 + phase) +
      amp * 0.5 * Math.sin(x * 0.053 - t * 2.2 + phase * 2);
    const wave = (phase: number) => {
      let d = `M${CX - R - 12} ${surface(CX - R - 12, phase).toFixed(1)}`;
      for (let x = CX - R; x <= CX + R + 12; x += 16) d += ` L${x} ${surface(x, phase).toFixed(1)}`;
      return `${d} L${CX + R + 12} ${FLOOR + 12} L${CX - R - 12} ${FLOOR + 12} Z`;
    };
    front.current?.setAttribute('d', wave(0));
    back.current?.setAttribute('d', wave(1.7));
    // Pearls ride the surface.
    const span = halfChord(yLevel) * 1.5;
    pearlRefs.current.forEach((el, i) => {
      if (!el) return;
      const x = CX - span / 2 + ((i + 0.5) / Math.max(1, earned)) * span;
      el.setAttribute('transform', `translate(${x.toFixed(1)} ${(surface(x, 0) - 3).toFixed(1)})`);
    });
    // Ink sinks from the surface to the floor, and starts again.
    moteRefs.current.forEach((el, i) => {
      const m = motes[i];
      if (!el || !m) return;
      const p = (t * m.speed + m.phase) % 1;
      const y = yLevel + 8 + p * (FLOOR - yLevel - 22);
      const x = CX + (m.u - 0.5) * 1.7 * halfChord(y) + Math.sin(t * 0.8 + m.phase * 9) * 5;
      el.setAttribute('cx', x.toFixed(1));
      el.setAttribute('cy', y.toFixed(1));
      el.setAttribute('opacity', (Math.sin(p * Math.PI) * 0.9).toFixed(2));
    });
  }, !still);

  const dim = (key: BodyKey) => (focus && focus !== key ? 0.22 : 1);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const p = relPoint(e, svgRef.current);
    tilt.current.target = still ? 0 : (p.x - 0.5) * -0.16;
  };
  const onLeave = () => {
    tilt.current.target = 0;
    setLens(null);
    onFocus(null);
  };
  const hover = (body: BodyKey | `late:${number}`) => (e: PointerEvent<SVGElement>) => {
    if (!svgRef.current) return;
    const p = relPoint(e, svgRef.current);
    setLens({ ...p, body });
    if (!body.startsWith('late:')) onFocus(body as BodyKey);
  };
  const ripple = (e: { clientX: number; clientY: number }) => {
    if (!svgRef.current || still) return;
    const r = svgRef.current.getBoundingClientRect();
    const vb = svgRef.current.viewBox.baseVal;
    const x = vb.x + ((e.clientX - r.left) / r.width) * vb.width;
    setRipples((rs) => [...rs.slice(-3), { id: Date.now(), x }]);
  };

  const callouts: Callout[] = [
    {
      key: 'completion',
      x: 80,
      y: 120,
      anchor: [CX - halfChord(yLevel) + 6, yLevel],
      align: 'start',
    },
    { key: 'sla', x: W - 80, y: 120, anchor: [CX + 70, CY - R + 60], align: 'end' },
    {
      key: 'bug',
      x: 80,
      y: 330,
      anchor: [CX - 90, Math.min(FLOOR - 40, yLevel + 90)],
      align: 'start',
    },
    { key: 'research', x: W - 80, y: 330, anchor: [CX + 120, FLOOR - 40], align: 'end' },
  ];
  const lensBody = lens?.body;
  const lateIdx =
    typeof lensBody === 'string' && lensBody.startsWith('late:') ? Number(lensBody.slice(5)) : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={
          bare ? `${CX - R - 40} ${CY - R - 30} ${2 * R + 80} ${2 * R + 70}` : `0 0 ${W} ${H}`
        }
        className="block w-full touch-pan-y select-none"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        aria-hidden
      >
        <defs>
          <clipPath id={`${uid}-orb`}>
            <circle cx={CX} cy={CY} r={R} />
          </clipPath>
          <radialGradient id={`${uid}-aura`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: 'var(--emphasis)', stopOpacity: 0.2 }} />
            <stop offset="60%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0.08 }} />
            <stop offset="100%" style={{ stopColor: 'var(--terracotta)', stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={`${uid}-water`} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              style={{
                stopColor: murky
                  ? 'color-mix(in oklch, var(--terracotta) 78%, var(--destructive))'
                  : 'var(--terracotta)',
                stopOpacity: 0.85,
              }}
            />
            <stop
              offset="100%"
              style={{
                stopColor: murky
                  ? 'color-mix(in oklch, var(--emphasis) 82%, var(--destructive))'
                  : 'var(--emphasis)',
                stopOpacity: 0.95,
              }}
            />
          </linearGradient>
          <radialGradient id={`${uid}-glass`} cx="35%" cy="28%" r="75%">
            <stop offset="0%" style={{ stopColor: 'var(--card)', stopOpacity: 0.55 }} />
            <stop offset="70%" style={{ stopColor: 'var(--card)', stopOpacity: 0.12 }} />
            <stop offset="100%" style={{ stopColor: 'var(--foreground)', stopOpacity: 0.08 }} />
          </radialGradient>
          <linearGradient id={`${uid}-shaft`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity={0.55} />
            <stop offset="100%" stopColor="white" stopOpacity={0} />
          </linearGradient>
          <radialGradient id={`${uid}-pearl`} cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="white" />
            <stop offset="100%" style={{ stopColor: 'var(--terracotta)' }} />
          </radialGradient>
        </defs>

        {/* the aura, and the orb's shadow on the desk */}
        <circle cx={CX} cy={CY} r={R * 1.55} fill={`url(#${uid}-aura)`} className="kpi-breathe" />
        <ellipse cx={CX} cy={FLOOR + 18} rx={R * 0.78} ry={12} className="fill-foreground/10" />

        <g clipPath={`url(#${uid}-orb)`} onClick={ripple} className="cursor-pointer">
          <circle cx={CX} cy={CY} r={R} className="fill-card" />
          {/* the back wave, then the front: two layers of the same water */}
          <path ref={back} fill={`url(#${uid}-water)`} opacity={0.45} />
          <g opacity={dim('completion')} className="transition-opacity duration-300">
            <path ref={front} fill={`url(#${uid}-water)`} />
          </g>

          {/* light: the hit-rate. A breached card breaks its shaft. */}
          {showSla && (
            <g
              opacity={dim('sla')}
              className="mix-blend-screen transition-opacity duration-300"
              onPointerMove={hover('sla')}
            >
              {Array.from({ length: SHAFTS }, (_, i) => {
                const x = CX - 120 + i * 60;
                const bad = i >= SHAFTS - broken;
                return (
                  <g
                    key={i}
                    className={still ? undefined : 'kpi-sway'}
                    style={{
                      transformOrigin: `${x}px ${CY - R}px`,
                      animationDelay: `${-i * 1.3}s`,
                    }}
                  >
                    <path
                      d={`M${x - 7} ${CY - R} L${x - 26} ${FLOOR} L${x + 26} ${FLOOR} L${x + 7} ${CY - R} Z`}
                      fill={bad ? 'var(--destructive)' : `url(#${uid}-shaft)`}
                      opacity={bad ? 0.22 : 0.25 + light * 0.75}
                    />
                    {bad && (
                      <line
                        x1={x - 16}
                        y1={CY + 10}
                        x2={x + 16}
                        y2={CY - 6}
                        className="stroke-destructive"
                        strokeWidth={2}
                        strokeLinecap="round"
                      />
                    )}
                  </g>
                );
              })}
            </g>
          )}

          {/* ink: the bugs */}
          <g opacity={dim('bug')} className="transition-opacity duration-300">
            {motes.map((m, i) => (
              <circle
                key={i}
                ref={(el) => {
                  moteRefs.current[i] = el;
                }}
                r={m.r}
                className={murky ? 'fill-destructive' : 'fill-foreground/70'}
              />
            ))}
          </g>

          {/* stones: the late cards */}
          {stones.map((s, i) => {
            const n = stones.length;
            const x = CX + (i - (n - 1) / 2) * 36;
            const size = 9 + (s.lateByMs / longest) * 10;
            const yy = CY + Math.sqrt(Math.max(0, R * R - (x - CX) * (x - CX))) - 10 - size * 0.4;
            return (
              <path
                key={s.id}
                d={stonePath(x, yy, size, i)}
                className={cn(
                  'cursor-pointer fill-foreground/80 stroke-background transition-opacity duration-300',
                  lateIdx === i && 'fill-destructive',
                )}
                strokeWidth={1.5}
                opacity={focus ? 0.3 : 1}
                onPointerMove={hover(`late:${i}`)}
                onClick={(e) => {
                  e.stopPropagation();
                  onPickLate();
                }}
              />
            );
          })}

          {/* missing research: hollow pearls waiting on the floor */}
          <g opacity={dim('research')} className="transition-opacity duration-300">
            {Array.from({ length: missing }, (_, i) => {
              const x = CX + 90 + i * 22 - missing * 4;
              const y = CY + Math.sqrt(Math.max(0, R * R - (x - CX) * (x - CX))) - 12;
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={7}
                  fill="none"
                  className="stroke-foreground/60"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
              );
            })}
          </g>

          {/* ripples from a click, and the flare when the target was reached */}
          {ripples.map((r) => (
            <motion.ellipse
              key={r.id}
              cx={r.x}
              cy={yLevel}
              fill="none"
              className="stroke-background"
              strokeWidth={2}
              initial={{ rx: 4, ry: 1.5, opacity: 0.9 }}
              animate={{ rx: 90, ry: 9, opacity: 0 }}
              transition={{ duration: 1.4, ease: 'easeOut' }}
              onAnimationComplete={() => setRipples((rs) => rs.filter((x) => x.id !== r.id))}
            />
          ))}
          {flare && !still && (
            <motion.ellipse
              cx={CX}
              cy={yLevel}
              fill="none"
              className="stroke-background"
              strokeWidth={3}
              initial={{ rx: 10, ry: 2, opacity: 1 }}
              animate={{ rx: R, ry: 16, opacity: 0 }}
              transition={{
                duration: 2.2,
                ease: 'easeOut',
                delay: 0.6,
                repeat: 2,
                repeatDelay: 0.4,
              }}
            />
          )}
        </g>

        {/* earned research: pearls riding the surface (outside the clip so they can sit proud) */}
        <g
          opacity={dim('research')}
          className="transition-opacity duration-300"
          onPointerMove={hover('research')}
        >
          {Array.from({ length: earned }, (_, i) => (
            <g
              key={i}
              ref={(el) => {
                pearlRefs.current[i] = el;
              }}
              transform={`translate(${CX} ${yLevel})`}
            >
              <circle
                r={8}
                fill={`url(#${uid}-pearl)`}
                className="stroke-background"
                strokeWidth={1}
              />
              <circle cx={-2.5} cy={-2.5} r={2} fill="white" opacity={0.85} />
            </g>
          ))}
        </g>

        {/* the target ring, etched on the glass */}
        {target !== null && (
          <g opacity={dim('completion')} className="transition-opacity duration-300">
            <line
              x1={CX - halfChord(levelY(target))}
              x2={CX + halfChord(levelY(target))}
              y1={levelY(target)}
              y2={levelY(target)}
              className="stroke-foreground/70"
              strokeWidth={1.5}
              strokeDasharray="2 5"
              strokeLinecap="round"
            />
            <line
              x1={CX + halfChord(levelY(target))}
              x2={CX + halfChord(levelY(target)) + 14}
              y1={levelY(target)}
              y2={levelY(target)}
              className="stroke-foreground/70"
              strokeWidth={1.5}
            />
            <text
              x={CX + halfChord(levelY(target)) + 18}
              y={levelY(target) + 4}
              textAnchor="start"
              className="fill-foreground font-mono"
              fontSize={12}
            >
              target {Math.round(target * 100)}%
            </text>
          </g>
        )}

        {/* the glass: a soft body, a rim, a highlight */}
        <circle cx={CX} cy={CY} r={R} fill={`url(#${uid}-glass)`} pointerEvents="none" />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          className="stroke-foreground/25"
          strokeWidth={1.5}
        />
        <path
          d={`M${CX - R * 0.72} ${CY - R * 0.38} A${R * 0.82} ${R * 0.82} 0 0 1 ${CX - R * 0.1} ${CY - R * 0.86}`}
          fill="none"
          stroke="white"
          strokeOpacity={0.7}
          strokeWidth={7}
          strokeLinecap="round"
          pointerEvents="none"
        />
        <circle
          cx={CX + R * 0.5}
          cy={CY - R * 0.62}
          r={4}
          fill="white"
          opacity={0.6}
          pointerEvents="none"
        />

        {/* the level, in the water */}
        <text
          x={CX}
          y={Math.min(FLOOR - 24, Math.max(CY - R + 60, yLevel + 46))}
          textAnchor="middle"
          className="fill-background font-semibold tabular-nums"
          fontSize={bare ? 44 : 52}
          letterSpacing={-2}
          pointerEvents="none"
          opacity={level > 0.2 ? 1 : 0}
        >
          {model.level.valueText}
        </text>
        <text
          x={CX}
          y={Math.min(FLOOR - 6, Math.max(CY - R + 78, yLevel + 66))}
          textAnchor="middle"
          className="fill-background text-micro font-semibold uppercase"
          letterSpacing={1.2}
          pointerEvents="none"
          opacity={level > 0.2 ? 0.85 : 0}
        >
          {model.level.label}
        </text>

        {/* callouts: each KPI's name and number, tied to its part of the pool */}
        {!bare &&
          callouts.map((c) => {
            const b = model.byKey[c.key];
            if (!b) return null;
            const on = focus === c.key;
            const end = c.align === 'end';
            const tx = c.x;
            const lineFrom: [number, number] = [end ? c.x - 150 : c.x + 150, c.y + 6];
            return (
              <g
                key={c.key}
                className="cursor-pointer transition-opacity duration-300"
                opacity={focus && !on ? 0.35 : 1}
                onPointerEnter={() => onFocus(c.key)}
                onPointerLeave={() => onFocus(null)}
                onClick={() => onPick(c.key)}
              >
                <rect
                  x={end ? c.x - 170 : c.x - 10}
                  y={c.y - 34}
                  width={180}
                  height={70}
                  fill="transparent"
                />
                <path
                  d={`M${lineFrom[0]} ${lineFrom[1]} C${(lineFrom[0] + c.anchor[0]) / 2} ${lineFrom[1]} ${(lineFrom[0] + c.anchor[0]) / 2} ${c.anchor[1]} ${c.anchor[0]} ${c.anchor[1]}`}
                  fill="none"
                  className={on ? 'stroke-foreground' : 'stroke-foreground/30'}
                  strokeWidth={1}
                  strokeDasharray={on ? undefined : '2 4'}
                />
                <circle cx={c.anchor[0]} cy={c.anchor[1]} r={3} className="fill-foreground" />
                <text
                  x={tx}
                  y={c.y - 16}
                  textAnchor={c.align}
                  className="fill-muted-foreground text-micro font-semibold uppercase"
                  letterSpacing={1}
                >
                  {b.gauge.label}
                </text>
                <text
                  x={tx}
                  y={c.y + 14}
                  textAnchor={c.align}
                  className="fill-foreground font-semibold tabular-nums"
                  fontSize={30}
                  letterSpacing={-1}
                >
                  {b.gauge.valueText}
                </text>
                <text
                  x={tx}
                  y={c.y + 32}
                  textAnchor={c.align}
                  className={cn(
                    'text-micro',
                    b.tone === 'critical'
                      ? 'fill-destructive'
                      : b.tone === 'warning'
                        ? 'fill-warning'
                        : 'fill-muted-foreground',
                  )}
                >
                  {b.tone === 'critical' ? '● ' : b.tone === 'warning' ? '▲ ' : b.met ? '✓ ' : ''}
                  {b.gauge.status.label}
                </text>
              </g>
            );
          })}
      </svg>
      <Lens at={lens}>
        {lateIdx !== null && stones[lateIdx] ? (
          <div className="grid gap-0.5">
            <span className="type-micro text-muted-foreground">Late card</span>
            <span className="font-medium">{stones[lateIdx].title}</span>
            <span className="font-mono text-destructive">+{stones[lateIdx].lateBy}</span>
          </div>
        ) : lens && !String(lens.body).startsWith('late:') ? (
          <BodyLens model={model} k={lens.body as BodyKey} />
        ) : null}
      </Lens>
    </div>
  );
}
