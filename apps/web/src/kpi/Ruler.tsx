import { motion } from 'motion/react';
import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import type { GaugeModel, GaugeTone } from './model';

const INK: Record<GaugeTone, string> = {
  good: 'stroke-foreground',
  warning: 'stroke-warning',
  critical: 'stroke-destructive',
  neutral: 'stroke-foreground',
};
const BADGE: Record<GaugeTone, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  good: 'success',
  warning: 'warning',
  critical: 'destructive',
  neutral: 'secondary',
};
const W = 200;
const Y = 24;

/**
 * A scorecard column (Paper & Ink): the label, the state in words, the value as a poster number and a ruler under it,
 * 0 to 100 with a tick every ten. The ink runs to the value; the line it is judged against stands as a violet mark
 * with its number. The value and state are always text; the ruler only repeats them.
 */
export function Ruler({
  gauge,
  className,
  compact = false,
}: {
  gauge: GaugeModel;
  className?: string;
  /** Overview: a smaller number, for a strip of four. */
  compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const { label, fraction, valueText, status, threshold, detail } = gauge;
  const value = fraction === null ? null : Math.min(1, Math.max(0, fraction));
  const percent = value === null ? null : Math.round(value * 1000) / 10;
  const line = threshold ? Math.min(1, Math.max(0, threshold.fraction)) : null;
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="type-micro">{label}</span>
        <Badge variant={BADGE[status.tone]}>
          <status.icon aria-hidden />
          {status.label}
        </Badge>
      </div>
      <div
        className={cn(
          'leading-none font-semibold tracking-[-0.04em] tabular-nums',
          compact ? 'text-4xl' : 'text-5xl lg:text-6xl',
        )}
      >
        {valueText}
      </div>
      <svg
        viewBox={`0 0 ${W} 36`}
        className="block w-full overflow-visible"
        {...(percent === null
          ? { 'aria-hidden': true }
          : {
              role: 'meter',
              'aria-label': label,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': percent,
              'aria-valuetext': `${valueText}, ${status.label}${threshold ? `, ${threshold.label}` : ''}`,
            })}
      >
        <line x1={0} x2={W} y1={Y} y2={Y} className="stroke-foreground/15" />
        {Array.from({ length: 11 }, (_, i) => (
          <line
            key={i}
            x1={i * (W / 10)}
            x2={i * (W / 10)}
            y1={Y - (i % 5 === 0 ? 6 : 3)}
            y2={Y}
            className="stroke-foreground/25"
          />
        ))}
        {value !== null && value > 0 && (
          <motion.line
            x1={0}
            y1={Y}
            x2={value * W}
            y2={Y}
            strokeWidth={3}
            strokeLinecap="round"
            className={INK[status.tone]}
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        {value !== null && (
          <motion.path
            d="M0 -4 L4 0 L0 4 L-4 0 Z"
            className="fill-foreground"
            initial={{ x: reduced ? value * W : 0, y: Y }}
            animate={{ x: value * W, y: Y }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        {line !== null && (
          <g>
            <line
              x1={line * W}
              x2={line * W}
              y1={Y - 12}
              y2={Y + 6}
              className="stroke-terracotta"
              strokeWidth={2}
            />
            <text
              x={line * W}
              y={Y - 15}
              textAnchor={line > 0.85 ? 'end' : line < 0.15 ? 'start' : 'middle'}
              className="fill-muted-foreground font-mono"
              fontSize={8}
            >
              {Math.round(line * 100)}
            </text>
          </g>
        )}
        <text x={0} y={Y + 11} className="fill-muted-foreground font-mono" fontSize={7}>
          0
        </text>
        <text
          x={W}
          y={Y + 11}
          textAnchor="end"
          className="fill-muted-foreground font-mono"
          fontSize={7}
        >
          100
        </text>
      </svg>
      {threshold && <p className="text-xs text-muted-foreground">Line: {threshold.label}</p>}
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
