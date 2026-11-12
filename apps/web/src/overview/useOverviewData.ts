import { useCoreProgress } from '@/core3d/useCoreProgress';
import { resolveMonth } from '@/lib/cardScope';
import { useKpiReport } from '@/lib/kpiApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useUiStore } from '@/store/ui';
import { actionCenter, SCOPE_LABEL } from './model';
import { useNeedsActionGroups } from './useNeedsActionGroups';

/**
 * Everything Overview 2.0 shows, from one place. Classic and the Living Workspace both call this, so
 * they cannot drift: same queries, same filters, same view models. Presentation controls (stage view, ASCII) are not
 * read here, so they cannot move a number.
 */
export function useOverviewData() {
  const state = useStateSnapshot();
  const progress = useCoreProgress();
  const scope = useUiStore((s) => s.scope);
  // Period: the KPI month only. "All months" has no scorecard of its own.
  const cardMonth = useUiStore((s) => s.cardMonth);
  const kpi = useKpiReport(resolveMonth(cardMonth) ?? undefined);
  const needs = useNeedsActionGroups();

  const center = actionCenter(needs.groups);

  return {
    cards: state.data?.cards ?? [],
    release: { model: progress.model, error: progress.error, scopeLabel: SCOPE_LABEL[scope] },
    actions: { center, errors: needs.errors, loading: needs.loading },
    kpi: { report: kpi, allMonths: cardMonth === 'all' },
    // Only the stowed worlds (Sick, Leave, previewed in development) are off duty.
    offDuty: false,
  };
}

export type OverviewData = ReturnType<typeof useOverviewData>;
