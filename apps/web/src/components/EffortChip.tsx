import { Microscope, Timer } from 'lucide-react';
import { formatEffort, formatHours, pointEffort, sumEffort } from '@relay/shared';
import { Badge } from '@/components/Badge';

/** "3pt · 4h" (or "6pt · Research"); nothing when the card has no Point. */
export function EffortChip({ point }: { point: number | null | undefined }) {
  const label = formatEffort(point);
  if (!label) return null;
  const e = pointEffort(point);
  return (
    <Badge
      variant={e?.kind === 'research' ? 'secondary' : 'outline'}
      title="Estimated effort from the Notion Point"
      className="tabular-nums"
    >
      {e?.kind === 'research' ? <Microscope aria-hidden /> : <Timer aria-hidden />}
      {label}
    </Badge>
  );
}

/** Warns when the estimate no longer fits before the SLA deadline (calendar hours, so it is a soft signal). */
export function EffortFit({
  point,
  deadline,
  now,
}: {
  point: number | null | undefined;
  deadline: number | null;
  now: number;
}) {
  const e = pointEffort(point);
  if (!e || e.kind !== 'hours' || deadline === null) return null;
  const leftH = (deadline - now) / 3_600_000;
  if (leftH < 0 || leftH >= e.hours) return null;
  return (
    <Badge
      variant="warning"
      title="Estimated effort is more than the time left before the deadline"
    >
      needs {formatHours(e.hours)}, {formatHours(Math.max(0, Math.floor(leftH)))} left
    </Badge>
  );
}

/** Total estimated hours of a group of cards (column, sprint, release). */
export function ColumnEffort({ points }: { points: readonly (number | null | undefined)[] }) {
  const sum = sumEffort(points);
  if (sum.hours === 0 && sum.research === 0) return null;
  const parts = [
    sum.hours > 0 ? formatHours(sum.hours) : null,
    sum.research > 0 ? `${sum.research} research` : null,
  ]
    .filter(Boolean)
    .join(' + ');
  return (
    <span
      className="text-xs text-muted-foreground tabular-nums"
      title={`Estimated effort${sum.unestimated ? `, ${sum.unestimated} card(s) without a Point` : ''}`}
    >
      <Timer aria-hidden className="mr-1 inline size-3" />
      {parts}
    </span>
  );
}
