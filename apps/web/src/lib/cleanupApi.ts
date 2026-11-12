import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CleanupResult, CleanupScan } from '@relay/shared';
import { get, post } from './api';

const key = ['cockpit', 'cleanup'] as const;

/** The last cleanup run (manual or the daily safe run); null until one ran since the server started. */
export function useCleanupLast() {
  return useQuery({
    queryKey: [...key, 'last'],
    queryFn: async () =>
      (await get<{ result: CleanupResult | null }>('/api/cockpit/cleanup/last')).result,
  });
}

/** A scan only reads; it can take a while (git and `du` on every workspace and clone). */
export function useCleanupScan() {
  return useMutation<CleanupScan, Error, void>({
    mutationFn: () => post('/api/cockpit/cleanup/scan', {}),
  });
}

export function useCleanupApply() {
  const qc = useQueryClient();
  return useMutation<CleanupResult, Error, string[]>({
    mutationFn: (ids) => post('/api/cockpit/cleanup/apply', { ids }),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}
