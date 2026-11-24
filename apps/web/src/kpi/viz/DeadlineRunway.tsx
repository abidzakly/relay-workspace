import { motion } from 'motion/react';
import { useState } from 'react';
import type { KpiCardRow } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useNow } from '@/lib/useNow';
import { useReducedMotion } from '@/workspace/useMedia';
import { SLA_META, slaTimeLabel } from '../model';
import { Key, Tip, useWidth } from './parts';
import { scrollToSection, useKpiView } from './store';

const H = 112;
const AXIS = 86;
const LANES = 3;
const DAY = 86_400_000;

type Look = { shape: 'dot' | 'ring' | 'tri' | 'diamond' | 'cross'; cls: string };
/** Shape carries the state as well as colour, as SLA_META's icons do in the table. */
const LOOK: Partial<Record<KpiCardRow['sla']['state'], Look>> = {
  not_started: { shape: 'ring', cls: 'stroke-foreground/60 fill-background' },
  on_track: { shape: 'dot', cls: 'fill-foreground stroke-background' },
  over_70: { shape: 'tri', cls: 'fill-warning stroke-background' },
  over_90: { shape: 'diamond', cls: 'fill-terracotta stroke-background' },
  breached: { shape: 'cross', cls: 'fill-destructive stroke-background' },
};

function Mark({ look, x, y, r }: { look: Look; x: number; y: number; r: number }) {
  if (look.shape === 'tri')
    return (
      <path
        d={`M${x} ${y - r} L${x + r} ${y + r * 0.8} L${x - r} ${y + r * 0.8} Z`}
        className={look.cls}
        strokeWidth={2}
      />
    );
  if (look.shape === 'diamond')
    return (
      <path
        d={`M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z`}
        className={look.cls}
        strokeWidth={2}
      />
    );
  if (look.shape === 'cross')
    return (
      <g>
        <circle cx={x} cy={y} r={r} className={look.cls} strokeWidth={2} />
        <path
          d={`M${x - 3} ${y - 3} L${x + 3} ${y + 3} M${x + 3} ${y - 3} L${x - 3} ${y + 3}`}
          className="stroke-background"
          strokeWidth={1.5}
        />
      </g>
    );
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      className={look.cls}
      strokeWidth={look.shape === 'ring' ? 1.5 : 2}
    />
  );
}

/**
 * The runway: every running timer as a bead at its deadline, on a line from today to the end of the month. What is
 * close to the "now" line needs a push; what is left of it is already late. Click a bead to find its card.
 */
export function DeadlineRunway({ rows, month }: { rows: readonly KpiCardRow[]; month: string }) {
  const now = useNow();
  const reduced = useReducedMotion();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const setFilter = useKpiView((s) => s.setFilter);
  const running = rows.filter(
    (r) =>
      r.month === month && r.sla.stoppedAt === null && r.sla.deadline !== null && LOOK[r.sla.state],
  );
  if (running.length === 0) return null;

  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1;
  const monthEnd = new Date(y, m + 1, 1).getTime();
  const earliest = Math.min(now - 2 * DAY, ...running.map((r) => r.sla.deadline!));
  const latest = Math.max(monthEnd, ...running.map((r) => r.sla.deadline!));
  const pad = 16;
  const x = (t: number) => pad + ((t - earliest) / (latest - earliest)) * Math.max(1, w - pad * 2);
  const sorted = [...running].sort((a, b) => a.sla.deadline! - b.sla.deadline!);
  // Lanes so beads close in time do not sit on top of each other.
  const lastInLane: number[] = Array(LANES).fill(-Infinity);
  const placed = sorted.map((r) => {
    const px = x(r.sla.deadline!);
    let lane = lastInLane.findIndex((l) => px - l > 18);
    if (lane < 0) lane = lastInLane.indexOf(Math.min(...lastInLane));
    lastInLane[lane] = px;
    return { r, px, py: AXIS - 16 - lane * 22 };
  });
  const ticks: number[] = [];
  for (let d = new Date(earliest); d.getTime() <= latest; d.setDate(d.getDate() + 1)) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (day >= earliest && new Date(day).getDay() === 1) ticks.push(day);
  }
  const h = hover === null ? null : placed[hover];

  return (
    <div className="grid gap-2">
      <div ref={ref} className="relative">
        {w > 0 && (
          <svg
            width={w}
            height={H}
            className="block overflow-visible"
            role="img"
            aria-label={`${running.length} running timers by deadline`}
          >
            <rect
              x={pad}
              y={AXIS - 4}
              width={Math.max(0, x(now) - pad)}
              height={8}
              rx={4}
              className="fill-destructive/10"
            />
            <line x1={pad} x2={w - pad} y1={AXIS} y2={AXIS} className="stroke-foreground/25" />
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={x(t)}
                  x2={x(t)}
                  y1={AXIS - 3}
                  y2={AXIS + 3}
                  className="stroke-foreground/30"
                />
                <text
                  x={x(t)}
                  y={AXIS + 16}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono"
                  fontSize={10}
                >
                  {new Date(t).getDate()}/{new Date(t).getMonth() + 1}
                </text>
              </g>
            ))}
            <line
              x1={x(monthEnd)}
              x2={x(monthEnd)}
              y1={8}
              y2={AXIS + 4}
              className="stroke-foreground/30"
              strokeDasharray="2 3"
            />
            <text
              x={x(monthEnd)}
              y={6}
              textAnchor="end"
              className="fill-muted-foreground font-mono"
              fontSize={10}
            >
              month end
            </text>
            {/* now */}
            <line
              x1={x(now)}
              x2={x(now)}
              y1={4}
              y2={AXIS + 6}
              className="stroke-terracotta"
              strokeWidth={2}
            />
            <text
              x={x(now) + 5}
              y={14}
              className="fill-foreground text-micro font-semibold uppercase"
            >
              now
            </text>
            {placed.map((p, i) => {
              const look = LOOK[p.r.sla.state]!;
              return (
                <motion.g
                  key={p.r.cardId}
                  className="cursor-pointer"
                  initial={reduced ? false : { opacity: 0, y: -8 }}
                  animate={{ opacity: hover === null || hover === i ? 1 : 0.35, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : i * 0.02 }}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => {
                    setFilter({ cardId: p.r.cardId, label: p.r.title });
                    requestAnimationFrame(() => scrollToSection('kpi-sla-table'));
                  }}
                >
                  <line x1={p.px} x2={p.px} y1={p.py} y2={AXIS} className="stroke-foreground/20" />
                  <circle cx={p.px} cy={p.py} r={12} fill="transparent" />
                  <Mark look={look} x={p.px} y={p.py} r={hover === i ? 7 : 5.5} />
                </motion.g>
              );
            })}
          </svg>
        )}
        {h && (
          <Tip x={h.px} y={h.py}>
            <span className="block font-medium">{h.r.title}</span>
            <span className={cn('block', h.r.sla.state === 'breached' && 'text-destructive')}>
              {SLA_META[h.r.sla.state].label} · {slaTimeLabel(h.r.sla, now)}
            </span>
            <span className="text-muted-foreground">{h.r.type ?? 'no type'}</span>
          </Tip>
        )}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(['on_track', 'over_70', 'over_90', 'breached', 'not_started'] as const).map((s) => {
          const look = LOOK[s]!;
          const n = running.filter((r) => r.sla.state === s).length;
          if (n === 0) return null;
          return (
            <Key
              key={s}
              swatch={
                <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
                  <Mark look={look} x={6} y={6} r={4.5} />
                </svg>
              }
            >
              {n} {SLA_META[s].label}
            </Key>
          );
        })}
      </p>
    </div>
  );
}
