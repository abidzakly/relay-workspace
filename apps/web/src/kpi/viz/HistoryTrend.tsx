import { motion } from 'motion/react';
import { useState, type PointerEvent } from 'react';
import type { KpiHistoryItem } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { formatPercent } from '../model';
import { Key, Tip, useWidth } from './parts';

const RATE_H = 170;
const BAR_H = 70;
const PAD_L = 34;
const PAD_R = 70;
const TOP = 12;

type Series = {
  key: 'completion' | 'hitRate';
  label: string;
  cls: string;
  dot: string;
  of: (h: KpiHistoryItem) => number | null;
};
const SERIES: Series[] = [
  {
    key: 'completion',
    label: 'Completion',
    cls: 'stroke-emphasis',
    dot: 'fill-emphasis',
    of: (h) => h.completionRate,
  },
  {
    key: 'hitRate',
    label: 'SLA hit-rate',
    cls: 'stroke-foreground',
    dot: 'fill-foreground',
    of: (h) => h.hitRate,
  },
];

/** A line through the points it has; a month with no value breaks the line rather than inventing one. */
function linePath(pts: ({ x: number; y: number } | null)[]): string {
  let d = '';
  let pen = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    pen = true;
  }
  return d;
}

/**
 * History: the frozen months, oldest on the left. Above, completion and the SLA hit-rate on one percent scale; below,
 * on its own scale, the late cards, with the research quota as a diamond (filled met, hollow missed). One crosshair
 * runs through both. Click a month to open it.
 */
export function HistoryTrend({
  items,
  selected,
  onPick,
}: {
  items: readonly KpiHistoryItem[];
  selected: string;
  onPick: (month: string) => void;
}) {
  const reduced = useReducedMotion();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const months = [...items].reverse();
  const n = months.length;
  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const x = (i: number) => PAD_L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yRate = (v: number) => TOP + (1 - v) * (RATE_H - TOP - 18);
  const mostLate = Math.max(1, ...months.map((h) => h.lateCards));
  const barW = Math.max(4, Math.min(22, (plotW / Math.max(1, n)) * 0.5));
  const baseY = RATE_H + BAR_H - 14;
  const yLate = (v: number) => baseY - (v / mostLate) * (BAR_H - 30);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = n === 1 ? 0 : Math.round(((px - PAD_L) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const h = hover === null ? null : months[hover];

  return (
    <div className="grid gap-2">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <Key
            key={s.key}
            swatch={
              <span
                className={cn(
                  'h-0.5 w-4 rounded-full',
                  s.key === 'completion' ? 'bg-emphasis' : 'bg-foreground',
                )}
              />
            }
          >
            {s.label}
          </Key>
        ))}
        <Key swatch={<span className="h-2.5 w-1.5 rounded-sm bg-foreground/70" />}>late cards</Key>
        <Key swatch={<span className="size-2 rotate-45 bg-foreground" />}>research met</Key>
        <Key swatch={<span className="size-2 rotate-45 border border-destructive" />}>
          research missed
        </Key>
      </p>
      <div ref={ref} className="relative">
        {w > 0 && (
          <svg
            width={w}
            height={RATE_H + BAR_H + 14}
            className="block cursor-crosshair touch-pan-y"
            role="img"
            aria-label={`History of ${n} frozen months`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={() => h && onPick(h.month)}
          >
            {/* percent grid: 0, 50, 100 */}
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  x2={PAD_L + plotW}
                  y1={yRate(v)}
                  y2={yRate(v)}
                  className="stroke-foreground/10"
                />
                <text
                  x={PAD_L - 6}
                  y={yRate(v) + 3}
                  textAnchor="end"
                  className="fill-muted-foreground font-mono"
                  fontSize={10}
                >
                  {v * 100}%
                </text>
              </g>
            ))}
            {/* the month shown */}
            {months.map((m, i) =>
              m.month === selected ? (
                <rect
                  key={m.month}
                  x={x(i) - 14}
                  y={TOP - 6}
                  width={28}
                  height={baseY - TOP + 10}
                  rx={6}
                  className="fill-terracotta/15"
                />
              ) : null,
            )}
            {SERIES.map((s) => {
              const pts = months.map((m, i) => {
                const v = s.of(m);
                return v === null ? null : { x: x(i), y: yRate(v) };
              });
              const lastIdx = pts
                .map((p, i) => (p ? i : -1))
                .filter((i) => i >= 0)
                .pop();
              const last = lastIdx === undefined ? null : pts[lastIdx];
              return (
                <g key={s.key}>
                  <motion.path
                    d={linePath(pts)}
                    fill="none"
                    className={s.cls}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={reduced ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                  />
                  {pts.map((p, i) =>
                    p && (hover === i || months[i]!.month === selected || n <= 2) ? (
                      <circle
                        key={i}
                        cx={p.x}
                        cy={p.y}
                        r={4.5}
                        className={cn(s.dot, 'stroke-background')}
                        strokeWidth={2}
                      />
                    ) : null,
                  )}
                  {last && lastIdx !== undefined && (
                    <text
                      x={last.x + 8}
                      y={last.y + 4}
                      className="fill-foreground text-micro font-semibold"
                    >
                      {s.label} {formatPercent(s.of(months[lastIdx]!)!)}
                    </text>
                  )}
                </g>
              );
            })}
            {/* late cards on their own scale, and the research diamond over each bar */}
            <line
              x1={PAD_L}
              x2={PAD_L + plotW}
              y1={baseY}
              y2={baseY}
              className="stroke-foreground/25"
            />
            <text
              x={PAD_L - 6}
              y={baseY - (BAR_H - 30) + 3}
              textAnchor="end"
              className="fill-muted-foreground font-mono"
              fontSize={10}
            >
              {mostLate}
            </text>
            {months.map((m, i) => {
              const top = yLate(m.lateCards);
              return (
                <g key={m.month}>
                  <motion.rect
                    x={x(i) - barW / 2}
                    width={barW}
                    rx={Math.min(4, barW / 2)}
                    className={
                      m.month === selected
                        ? 'fill-terracotta'
                        : m.lateCards > 0
                          ? 'fill-foreground/70'
                          : 'fill-foreground/15'
                    }
                    initial={reduced ? false : { y: baseY, height: 0 }}
                    animate={{ y: Math.min(top, baseY - 2), height: Math.max(2, baseY - top) }}
                    transition={{ duration: 0.7, delay: i * 0.02, ease: [0.22, 1, 0.36, 1] }}
                  />
                  <path
                    d={`M${x(i)} ${Math.min(top, baseY - 2) - 13} l4 4 l-4 4 l-4 -4 Z`}
                    className={m.researchMet ? 'fill-foreground' : 'fill-none stroke-destructive'}
                    strokeWidth={1.25}
                  />
                  {(i % Math.max(1, Math.ceil(n / 8)) === 0 || m.month === selected) && (
                    <text
                      x={x(i)}
                      y={baseY + 13}
                      textAnchor="middle"
                      className="fill-muted-foreground font-mono"
                      fontSize={10}
                    >
                      {m.month.slice(2).replace('-', '·')}
                    </text>
                  )}
                </g>
              );
            })}
            {/* the crosshair */}
            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={TOP - 6}
                y2={baseY}
                className="stroke-foreground/40"
                strokeDasharray="2 3"
                pointerEvents="none"
              />
            )}
          </svg>
        )}
        {h && hover !== null && (
          <Tip x={Math.min(w - 90, Math.max(90, x(hover)))} y={TOP + 10}>
            <span className="block font-mono font-semibold">{h.month}</span>
            <span className="grid grid-cols-[auto_auto] gap-x-3">
              <span className="text-muted-foreground">Completion</span>
              <span className="text-right font-mono">
                {h.completionRate === null ? '—' : formatPercent(h.completionRate)}
              </span>
              <span className="text-muted-foreground">Hit-rate</span>
              <span className="text-right font-mono">
                {h.hitRate === null ? '—' : formatPercent(h.hitRate)}
              </span>
              <span className="text-muted-foreground">Bug ratio</span>
              <span className={cn('text-right font-mono', h.bugOverLimit && 'text-destructive')}>
                {formatPercent(h.bugRatio)}
              </span>
              <span className="text-muted-foreground">Research</span>
              <span className={cn('text-right font-mono', !h.researchMet && 'text-destructive')}>
                {h.researchCount} {h.researchMet ? 'met' : 'missed'}
              </span>
              <span className="text-muted-foreground">Late cards</span>
              <span className="text-right font-mono">{h.lateCards}</span>
            </span>
            <span className="mt-1 block text-muted-foreground">Click to open</span>
          </Tip>
        )}
      </div>
    </div>
  );
}
