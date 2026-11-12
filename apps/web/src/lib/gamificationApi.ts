import { useQuery } from '@tanstack/react-query';
import type { GamificationReport } from '@relay/shared';
import { get } from './api';
import { useFallbackPollMs } from './sseState';

/** `lib/sse.ts` invalidates `root` on `gamification.changed`. */
export const gamificationKeys = { root: ['gamification'] as const };

export function useGamification() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: gamificationKeys.root,
    queryFn: ({ signal }) => get<GamificationReport>('/api/gamification', { signal }),
    refetchInterval: pollMs,
  });
}
