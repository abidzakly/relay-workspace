import type { KpiReport } from '@relay/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Ruler } from '@/kpi/Ruler';
import { describeError } from '@/lib/api';
import { monthLabel } from '@/lib/cardScope';
import { kpiItems } from './model';
import { Panel } from './Panel';
import { useKpiPresets } from '@/lib/features';

/** "KPI · November 2026", plus whether the month is still running. */
export function kpiContext(report: KpiReport | undefined, allMonths: boolean): string {
  if (!report) return 'KPI';
  const month = monthLabel(report.month);
  const state = report.frozen ? 'final' : report.current ? 'month in progress' : '';
  return [
    `KPI · ${month}`,
    state,
    allMonths ? 'a scorecard is per month, so All months shows this one' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Engineering health: four KPI cards of equal weight. Each shows its name, value, target or
 * limit, state, and the counts behind it. No data never reads as 0.
 */
export function KpiGrid({
  report,
  allMonths,
  className,
}: {
  report: UseQueryResult<KpiReport>;
  allMonths: boolean;
  className?: string;
}) {
  const kpiPresets = useKpiPresets();
  return (
    <Panel
      n={4}
      title="Engineering health"
      context={kpiContext(report.data, allMonths)}
      actions={
        <Link to="/kpi" className="text-xs text-primary-ink underline-offset-4 hover:underline">
          Open KPI
        </Link>
      }
      className={className}
    >
      {report.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {report.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the scorecard</AlertTitle>
          <AlertDescription>{describeError(report.error)}</AlertDescription>
        </Alert>
      )}
      {report.data && (
        <ul
          className="ov-kpi-grid grid gap-6 sm:grid-cols-2 xl:grid-cols-4 xl:gap-0"
          aria-label="KPI"
        >
          {kpiItems(report.data.scorecard, kpiPresets).map((item) => (
            <li
              key={item.key}
              className="ov-kpi min-w-0 border-hairline xl:border-l xl:px-5 xl:first:border-l-0 xl:first:pl-0 xl:last:pr-0"
            >
              <Ruler gauge={item.gauge} compact />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
