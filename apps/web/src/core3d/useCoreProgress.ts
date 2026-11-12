import { useMemo } from 'react';
import { visibleCards } from '@/lib/cardScope';
import { useSettings } from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useUiStore } from '@/store/ui';
import { buildProgress } from './progressMapping';

/** The live progress model for the persisted scope. Free of three.js, so Overview can use it from the main chunk. */
export function useCoreProgress() {
  const state = useStateSnapshot();
  const settings = useSettings();
  const scope = useUiStore((s) => s.scope);
  // Only my cards. The month does not apply: the core already has its cycle / all-time scope.
  // Waits for settings: a custom Ready to Test spelling would otherwise count as outside the flow for a moment.
  const readyStatus = settings.data?.notion.readyStatus;
  const completeStatuses = settings.data?.notion.statusGroups.complete;
  const settled = !settings.isPending;
  const data = state.data;

  const model = useMemo(
    () =>
      data && settled
        ? buildProgress(
            {
              cards: visibleCards(data.cards, 'all'),
              mrs: data.mrs,
              links: data.links,
              releases: data.pendingReleases.items,
              readyStatus,
              completeStatuses,
            },
            scope,
          )
        : null,
    [data, settled, readyStatus, completeStatuses, scope],
  );

  return { model, error: state.error };
}
