import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toBase64 } from './base64';
import type {
  BuildList,
  BuildPreviewRequest,
  PreviewCandidates,
  BuildStartRequest,
  BuildView,
  ShareRequest,
  ShareResult,
  SigningStatus,
} from '@relay/shared';
import { get, post } from './api';
import { useFallbackPollMs } from './sseState';

/** `job.updated` invalidates this root (`lib/sse.ts`), so queue and history follow every change. */
export const buildKeys = { root: ['builds'] as const };

export function useBuilds() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: buildKeys.root,
    queryFn: ({ signal }) => get<BuildList>('/api/builds', { signal }),
    refetchInterval: pollMs,
  });
}

export function useStartBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BuildStartRequest) => post<BuildView>('/api/builds', body),
    onSettled: () => qc.invalidateQueries({ queryKey: buildKeys.root }),
  });
}

export function useCancelBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      post<BuildView>(`/api/builds/${encodeURIComponent(jobId)}/cancel`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: buildKeys.root }),
  });
}

/** Answers once started. Progress and the end arrive through the bus, as a refetch of the list. */
export function useUploadBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      post<BuildView>(`/api/builds/${encodeURIComponent(jobId)}/upload`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: buildKeys.root }),
  });
}

const signingPath = (repo: string) => `/api/builds/signing/${encodeURIComponent(repo)}`;

/** Read when asked for, not kept: the files can change on disk at any time. */
export function useSigningStatus(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: [...buildKeys.root, 'signing', repo],
    queryFn: ({ signal }) => get<SigningStatus>(signingPath(repo), { signal }),
    enabled,
    staleTime: 0,
  });
}

/** The properties file goes first, since it tells the server what the keystore is called. */
export function useUploadSigningFiles(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: readonly File[]) => {
      const ordered = [...files].sort(
        (a, b) => Number(b.name.endsWith('.properties')) - Number(a.name.endsWith('.properties')),
      );
      for (const file of ordered) {
        await post<SigningStatus>(signingPath(repo), {
          fileName: file.name,
          contentBase64: await toBase64(file),
        });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [...buildKeys.root, 'signing', repo] }),
  });
}

export function useShareBuild() {
  return useMutation({
    mutationFn: ({ jobId, ...body }: ShareRequest & { jobId: string }) =>
      post<ShareResult>(`/api/share/${encodeURIComponent(jobId)}`, body),
  });
}

/** The open MRs of a repo in merge order. Read when the dialog opens: MRs change under it. */
export function usePreviewCandidates(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: [...buildKeys.root, 'preview', repo],
    queryFn: ({ signal }) =>
      get<PreviewCandidates>(`/api/builds/preview/${encodeURIComponent(repo)}`, { signal }),
    enabled,
    staleTime: 0,
  });
}

export function useStartPreviewBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BuildPreviewRequest) => post<BuildView>('/api/builds/preview', body),
    onSettled: () => qc.invalidateQueries({ queryKey: buildKeys.root }),
  });
}
