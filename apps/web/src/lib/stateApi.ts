import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HealthFindingRef,
  HealthRangeQuery,
  HealthReport,
  StateSnapshot,
} from '@relay/shared';
import { api, get } from './api';
import { useFallbackPollMs } from './sseState';

export const stateKeys = {
  state: ['state'] as const,
  health: ['sync-health'] as const,
};

/**
 * Both endpoints are read-only views of the server's local cache (they never trigger a sync).
 * Push-driven: SSE invalidates them (`lib/sse.ts`); they poll every 30 s ONLY while the stream is down.
 */
export function useStateSnapshot() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: stateKeys.state,
    queryFn: ({ signal }) => get<StateSnapshot>('/api/state', { signal }),
    refetchInterval: pollMs,
  });
}

/** `range` limits the findings to a period (Sync Health page). Absent = every finding (board, palette). */
export function useHealthReport(range?: HealthRangeQuery) {
  const pollMs = useFallbackPollMs();
  const qs = new URLSearchParams();
  if (range?.from) qs.set('from', range.from);
  if (range?.to) qs.set('to', range.to);
  const query = qs.toString();
  return useQuery({
    // Same prefix for every range, so every invalidation of `stateKeys.health` reaches them all.
    queryKey: range ? [...stateKeys.health, query] : stateKeys.health,
    queryFn: ({ signal }) =>
      get<HealthReport>(`/api/sync/health${query ? `?${query}` : ''}`, { signal }),
    refetchInterval: pollMs,
    placeholderData: (prev) => prev,
  });
}

/** Mark a Sync Health finding as a false positive (`dismiss: true`) or bring it back. Local only. */
export function useFalsePositive() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { ref: HealthFindingRef; dismiss: boolean }>({
    mutationFn: ({ ref, dismiss }) =>
      api(dismiss ? 'POST' : 'DELETE', '/api/sync/health/false-positives', ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: stateKeys.health });
      void qc.invalidateQueries({ queryKey: stateKeys.state });
    },
  });
}
