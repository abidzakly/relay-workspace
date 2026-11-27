import { useTranslation } from 'react-i18next';
import { kpiItems, releaseSummary } from './model';
import type { OverviewData } from './useOverviewData';
import { useKpiPresets } from '@/lib/features';

/**
 * The whole Overview in one sentence for screen readers: the scene is never the only source, and a
 * reader hears release, what needs attention, and each KPI state before the blocks themselves.
 */
export function OverviewSummary({ data }: { data: OverviewData }) {
  const kpiPresets = useKpiPresets();
  const { t } = useTranslation();
  const parts: string[] = [];
  const model = data.release.model;
  if (model) {
    const r = releaseSummary(model);
    parts.push(
      t('overview.summary.release', {
        scope: r.scopeLabel,
        value: r.percent === null ? t('overview.summary.noData') : `${r.percent}%`,
        partial: r.partial ? t('overview.summary.partial') : '',
      }),
    );
  }
  if (!data.actions.loading) {
    const { center } = data.actions;
    parts.push(
      center.total === 0
        ? t('overview.summary.nothing')
        : t('overview.summary.items', {
            count: center.total,
            list: center.categories.map((c) => `${c.count} ${c.title}`).join(', '),
          }),
    );
  }
  const report = data.kpi.report.data;
  if (report) {
    parts.push(
      t('overview.summary.kpi', {
        list: kpiItems(report.scorecard, kpiPresets)
          .map(
            (i) =>
              `${i.gauge.label} ${i.gauge.valueText === '—' ? t('overview.summary.noData') : i.gauge.valueText}, ${i.gauge.status.label}`,
          )
          .join('; '),
      }),
    );
  }
  if (data.offDuty) parts.push(t('overview.summary.offDuty'));
  if (parts.length === 0) return null;
  return <p className="sr-only">{parts.join(' ')}</p>;
}
