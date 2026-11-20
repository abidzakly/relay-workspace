import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MrChatRequest,
  MrChatResult,
  MrCreatePreview,
  MrCreateRequest,
  MrCreateResult,
  MrSummaryResult,
  ReadyForMrList,
} from '@relay/shared';
import { get, post } from './api';
import { mrKeys } from './mrApi';

/** "Ready for MR" + Create MR. SSE `cockpit.changed {what:'ready'}` refreshes. */
export const readyKeys = {
  list: ['cockpit', 'ready'] as const,
  preview: (repo: string, branch: string) => ['cockpit', 'ready', 'preview', repo, branch] as const,
};

export function useReadyForMr() {
  return useQuery({
    queryKey: readyKeys.list,
    queryFn: ({ signal }) => get<ReadyForMrList>('/api/cockpit/ready', { signal }),
    staleTime: 30_000,
  });
}

export function useRefreshReady() {
  const qc = useQueryClient();
  return useMutation<ReadyForMrList, Error, void>({
    mutationFn: () => post('/api/cockpit/ready/refresh'),
    onSuccess: (d) => qc.setQueryData(readyKeys.list, d),
  });
}

export function useMrCreatePreview(repo: string, branch: string) {
  const q = new URLSearchParams({ repo, branch });
  return useQuery({
    queryKey: readyKeys.preview(repo, branch),
    queryFn: ({ signal }) =>
      get<MrCreatePreview>(`/api/mr-create/preview?${q.toString()}`, { signal }),
    enabled: Boolean(repo && branch),
    staleTime: 10_000,
    retry: false,
  });
}

export function useMrSummary() {
  return useMutation<MrSummaryResult, Error, { repo: string; branch: string }>({
    mutationFn: (b) => post('/api/mr-create/summary', b),
  });
}

/**
 * "Explain branch" in Code Review: Create MR's summary as a query (kept for the session, so reopening is instant).
 * The server's AI cache shares the answer with Create MR when `base` is the repo's base.
 */
export function useBranchSummary(repo: string, branch: string, base: string | undefined) {
  return useQuery({
    queryKey: ['mr-summary', repo, branch, base ?? ''] as const,
    queryFn: () =>
      post<MrSummaryResult>('/api/mr-create/summary', { repo, branch, ...(base ? { base } : {}) }),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

export function useMrChat() {
  return useMutation<MrChatResult, Error, MrChatRequest>({
    mutationFn: (b) => post('/api/mr-create/chat', b),
  });
}

export function useCreateMr() {
  const qc = useQueryClient();
  return useMutation<MrCreateResult, Error, MrCreateRequest>({
    mutationFn: (b) => post('/api/mr-create', b),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['cockpit', 'ready'] });
      void qc.invalidateQueries({ queryKey: mrKeys.inboxRoot });
    },
  });
}

export const mrCreatePath = (repo: string, branch: string) =>
  `/mr-create/${encodeURIComponent(repo)}?branch=${encodeURIComponent(branch)}`;
