import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from './api';

const KEY = ['showcase'] as const;

interface ShowcaseState {
  seen: boolean;
}

/** Whether the feature tour was already shown once (kept on the server, so every browser agrees). */
export function useShowcaseSeen() {
  return useQuery({ queryKey: KEY, queryFn: () => get<ShowcaseState>('/api/showcase') });
}

export function useMarkShowcaseSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => put<ShowcaseState>('/api/showcase', { seen: true }),
    onMutate: () => qc.setQueryData<ShowcaseState>(KEY, { seen: true }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
