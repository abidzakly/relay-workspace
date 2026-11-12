import { useQuery } from '@tanstack/react-query';
import type { FeatureId, SystemInfo } from '@relay/shared';
import { get } from './api';

/** Where the server runs (macOS, Linux, WSL or Windows) and which features cannot run there. Never changes at runtime. */
export function useSystem() {
  return useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => get<SystemInfo>('/api/system', { signal }),
    staleTime: Infinity,
  });
}

/** Why a feature cannot run on this machine, or null. */
export function useUnsupported(): Map<FeatureId, string> {
  const s = useSystem().data;
  return new Map((s?.unsupported ?? []).map((u) => [u.id, u.reason]));
}
