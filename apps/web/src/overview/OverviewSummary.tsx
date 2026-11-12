import { kpiItems, releaseSummary } from './model';
import type { OverviewData } from './useOverviewData';
import { useKpiPresets } from '@/lib/features';

/**
 * The whole Overview in one sentence for screen readers: the scene is never the only source, and a
 * reader hears release, what needs attention, and each KPI state before the blocks themselves.
 */
export function OverviewSummary({ data }: { data: OverviewData }) {
  const kpiPresets = useKpiPresets();
  const parts: string[] = [];
  const model = data.release.model;
  if (model) {
    const r = releaseSummary(model);
    parts.push(
      `Release, ${r.scopeLabel}: ${r.percent === null ? 'no data' : `${r.percent}%`}${r.partial ? ', partial' : ''}.`,
    );
  }
  if (!data.actions.loading) {
    const { center } = data.actions;
    parts.push(
      center.total === 0
        ? 'Nothing needs your attention.'
        : `${center.total} item${center.total === 1 ? '' : 's'} need attention: ${center.categories
            .map((c) => `${c.count} ${c.title}`)
            .join(', ')}.`,
    );
  }
  const report = data.kpi.report.data;
  if (report) {
    parts.push(
      `KPI: ${kpiItems(report.scorecard, kpiPresets)
        .map(
          (i) =>
            `${i.gauge.label} ${i.gauge.valueText === '—' ? 'no data' : i.gauge.valueText}, ${i.gauge.status.label}`,
        )
        .join('; ')}.`,
    );
  }
  if (data.offDuty) parts.push('You are off duty today.');
  if (parts.length === 0) return null;
  return <p className="sr-only">{parts.join(' ')}</p>;
}
