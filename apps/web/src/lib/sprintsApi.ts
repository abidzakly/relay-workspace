import { useQuery } from '@tanstack/react-query';
import type { SprintsResponse } from '@relay/shared';
import { get } from './api';
import { useFallbackPollMs } from './sseState';

/** Under `['state']`, so every SSE event that refreshes the snapshot (cards, links, MRs, settings) refreshes it too. */
export const sprintKeys = { sprints: ['state', 'sprints'] as const };

export function useSprints() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: sprintKeys.sprints,
    queryFn: ({ signal }) => get<SprintsResponse>('/api/sprints', { signal }),
    refetchInterval: pollMs,
  });
}
