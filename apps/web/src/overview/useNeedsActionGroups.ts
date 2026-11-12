import { mineSets, monthKey, verdictIsMine } from '@/lib/cardScope';
import { useKpiFocus } from '@/lib/kpiApi';
import { useMrInbox } from '@/lib/mrApi';
import { useRepos, useSettings } from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import {
  failedPipelineRows,
  mismatchRows,
  relevantVerdicts,
  releaseRows,
  slaRows,
  waitingMrRows,
  type ActionGroup,
} from './needsActionModel';

export const OPEN_MRS = { repo: '', state: 'open', reviewer: '' } as const;
/** The route's maximum: a risk further down the list must still be counted. */
const FOCUS_LIMIT = 100;

/**
 * Everything on your plate, grouped, most urgent kind first. Shared by the Overview's "Needs your action" card and the
 * Living Workspace indicators, so both always count the same thing.
 */
export function useNeedsActionGroups() {
  const state = useStateSnapshot();
  const inbox = useMrInbox(OPEN_MRS);
  const focus = useKpiFocus(FOCUS_LIMIT);
  const settings = useSettings();
  const repos = useRepos();

  const verdicts = state.data?.health.verdicts ?? [];
  // Someone else's card or MR is not mine to fix.
  const sets = mineSets(state.data);
  // Overview shows only current, actionable findings; Sync Health keeps the full analysis.
  const now = Date.now();
  const myVerdicts = relevantVerdicts(
    verdicts.filter((v) => verdictIsMine(v, sets)),
    {
      now,
      currentMonth: monthKey(new Date(now)),
      cards: state.data?.cards ?? [],
      mrs: state.data?.mrs ?? [],
      statusGroups: settings.data?.notion.statusGroups,
    },
  );
  const items = (inbox.data?.items ?? []).filter((m) => m.mine);
  const names = new Map((repos.data ?? []).map((r) => [r.id, r.name] as const));

  const groups: ActionGroup[] = [
    { id: 'mismatches', title: 'Mismatches', to: '/sync', rows: mismatchRows(myVerdicts) },
    {
      id: 'mrs',
      title: 'MRs waiting on you',
      to: '/mrs',
      rows: waitingMrRows(items),
    },
    {
      id: 'pipelines',
      title: 'Failed pipelines',
      to: '/mrs',
      rows: failedPipelineRows(items, settings.data?.gitlab.myUsername),
    },
    { id: 'sla', title: 'SLA risks', to: '/kpi', rows: slaRows(focus.data?.rows ?? []) },
    {
      id: 'release',
      title: 'Awaiting release',
      to: '/release',
      rows: releaseRows(
        state.data?.pendingReleases.items ?? [],
        verdicts,
        (id) => names.get(id) ?? id,
      ),
    },
  ];
  const errors = [state.error, inbox.error, focus.error].filter(Boolean);
  const loading = state.isPending || inbox.isPending || focus.isPending;
  // Until settings answer, the failed-pipeline rows still include other people's MRs.
  const settled = !loading && errors.length === 0 && !settings.isPending && !settings.error;
  return { groups, errors, loading, settled, inboxItems: items };
}
