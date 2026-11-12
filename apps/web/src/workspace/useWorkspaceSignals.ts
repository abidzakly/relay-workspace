import { useMemo } from 'react';
import { COLUMNS, columnFor } from '@/board/model';
import { useCoreProgress } from '@/core3d/useCoreProgress';
import { useAuditLog } from '@/lib/auditApi';
import { useBuilds } from '@/lib/buildApi';
import { visibleCards } from '@/lib/cardScope';
import { useKpiReport } from '@/lib/kpiApi';
import { useSettings } from '@/lib/settingsApi';
import { useSprints } from '@/lib/sprintsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useNeedsActionGroups } from '@/overview/useNeedsActionGroups';
import { DEFAULT_ENV, isStowed } from './envFor';
import { buildSceneData, NOTES_PER_COLUMN, type SceneData } from './signals';

const UNDOABLE = { action: '', actor: '', targetType: '', onlyUndoable: true } as const;

/**
 * Every indicator of the world, from the queries the tabs already use (so SSE keeps them live). Read outside the
 * canvas, which is a separate React root, and handed in as plain data.
 */
export function useWorkspaceSignals(): SceneData {
  const needs = useNeedsActionGroups();
  const state = useStateSnapshot();
  const settings = useSettings();
  const kpi = useKpiReport();
  const { model } = useCoreProgress();
  const builds = useBuilds();
  const sprints = useSprints();
  const audit = useAuditLog(UNDOABLE);

  const count = (id: string) => needs.groups.find((g) => g.id === id)?.rows.length ?? 0;
  const mrsWaiting = count('mrs');
  const pipelinesFailed = count('pipelines');
  const mismatches = count('mismatches');
  const slaRisks = count('sla');
  const awaitingRelease = count('release');
  const mrTitles = needs.inboxItems.map((m) => m.title);
  const reviewMrs = needs.inboxItems.filter((m) => m.action.kind === 'review_requested');
  const reviewTitles = reviewMrs.map((m) => m.title);
  const reviewKeys = reviewMrs.map((m) => `${m.repoId}#${m.iid}`);

  const cards = state.data?.cards;
  const readyStatus = settings.data?.notion.readyStatus;
  const completeStatuses = settings.data?.notion.statusGroups.complete;
  const columns = useMemo(() => {
    const mine = visibleCards(cards ?? [], 'current');
    return COLUMNS.map((name) => {
      const inColumn = mine
        .filter((c) => columnFor(c, readyStatus, completeStatuses) === name)
        .sort((a, b) => b.lastEditedAt - a.lastEditedAt);
      return {
        name,
        count: inColumn.length,
        notes: inColumn.slice(0, NOTES_PER_COLUMN).map((c) => ({ id: c.id, title: c.title })),
      };
    });
  }, [cards, readyStatus, completeStatuses]);

  const scorecard = kpi.data?.scorecard;
  const buildItems = builds.data?.items ?? [];
  const activeSprint = sprints.data?.sprints.find((s) => s.active) ?? null;
  const undoable = audit.data?.pages[0]?.entries.filter((e) => e.undoable).length ?? 0;

  const input = {
    loading: needs.loading && !state.data,
    mrTitles,
    mrsWaiting,
    reviewTitles,
    // Until every source has answered, an empty queue means "not read yet", not "nothing requested".
    reviewKeys: needs.loading ? null : reviewKeys,
    offDuty: isStowed(DEFAULT_ENV),
    pipelinesFailed,
    mismatches,
    slaRisks,
    awaitingRelease,
    columns,
    completion: scorecard?.completion
      ? { rate: scorecard.completion.rate, target: scorecard.completion.target }
      : null,
    slaHitRate: scorecard?.sla.overall.hitRate ?? null,
    bugs: scorecard
      ? {
          ratio: scorecard.bugRatio.ratio,
          max: scorecard.bugRatio.max,
          total: scorecard.bugRatio.total,
        }
      : null,
    research: scorecard
      ? { count: scorecard.research.count, required: scorecard.research.required }
      : null,
    progress: model?.percent ?? null,
    sources: state.data?.health.sync.sources ?? [],
    syncRunning: state.data?.health.sync.running ?? false,
    buildRunning: builds.data?.runningJobId != null,
    buildsQueued: buildItems.filter((b) => b.queuePosition !== null).length,
    sprint: activeSprint
      ? { name: activeSprint.name, done: activeSprint.doneHours, load: activeSprint.loadHours }
      : null,
    undoable,
  };
  // A new object every render would redraw every canvas texture; the key is the data, not the identity.
  const key = JSON.stringify(input);
  return useMemo(() => buildSceneData(input), [key]);
}
