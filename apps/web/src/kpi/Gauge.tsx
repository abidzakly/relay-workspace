import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';
import type { GaugeModel, GaugeTone } from './model';

const FILL: Record<GaugeTone, string> = {
  good: 'stroke-success',
  warning: 'stroke-warning',
  critical: 'stroke-destructive',
  neutral: 'stroke-primary',
};

/** The dial's half circle and its centre, in the SVG's units. */
const DIAL_ARC = 'M8 52 A42 42 0 0 1 92 52';
const DIAL_CENTRE = '50px 52px';
const angleOf = (percent: number): number => -90 + Math.min(100, Math.max(0, percent)) * 1.8;

const BADGE: Record<GaugeTone, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  good: 'success',
  warning: 'warning',
  critical: 'destructive',
  neutral: 'secondary',
};

const toPercent = (fraction: number): number => Math.round(fraction * 1000) / 10;

/**
 * A dial on the desk: the value and state are always text, and the needle only repeats them. It stays still, because a
 * risk reading is not a toy. Reused by Overview.
 */
export function Gauge({ gauge, className }: { gauge: GaugeModel; className?: string }) {
  const { label, fraction, valueText, status, threshold, detail } = gauge;
  const percent = fraction === null ? null : toPercent(fraction);
  const valueDescription = `${valueText}, ${status.label}${threshold ? `, ${threshold.label}` : ''}`;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant={BADGE[status.tone]}>
          <status.icon aria-hidden />
          {status.label}
        </Badge>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold tabular-nums">{valueText}</div>
        <div
          className="w-24 shrink-0"
          {...(percent === null
            ? { 'aria-hidden': true }
            : {
                role: 'meter',
                'aria-label': label,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': percent,
                'aria-valuetext': valueDescription,
              })}
        >
          <svg viewBox="0 0 100 58" aria-hidden className="block w-full" fill="none">
            <path d={DIAL_ARC} strokeWidth={8} strokeLinecap="round" className="stroke-muted" />
            {percent !== null && percent > 0 && (
              <path
                d={DIAL_ARC}
                pathLength={100}
                strokeDasharray={`${Math.min(100, percent)} 100`}
                strokeWidth={8}
                strokeLinecap="round"
                className={FILL[status.tone]}
              />
            )}
            {threshold && (
              <line
                x1={50}
                y1={2}
                x2={50}
                y2={16}
                strokeWidth={2}
                className="stroke-foreground"
                style={{
                  transform: `rotate(${angleOf(toPercent(threshold.fraction))}deg)`,
                  transformOrigin: DIAL_CENTRE,
                }}
              />
            )}
            {percent !== null && (
              <line
                x1={50}
                y1={52}
                x2={50}
                y2={18}
                strokeWidth={3}
                strokeLinecap="round"
                className="stroke-foreground"
                style={{
                  transform: `rotate(${angleOf(percent)}deg)`,
                  transformOrigin: DIAL_CENTRE,
                }}
              />
            )}
            <circle cx={50} cy={52} r={4} className="fill-foreground" />
          </svg>
        </div>
      </div>
      {threshold && <p className="text-xs text-muted-foreground">Line: {threshold.label}</p>}
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
