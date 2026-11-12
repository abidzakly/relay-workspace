import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  JobMode,
  ReleaseEngines,
  ReleaseJobView,
  ReleasePreview,
  ReleaseStartRequest,
} from '@relay/shared';
import { ApiError, get, post } from './api';
import { useFallbackPollMs } from './sseState';
import { stateKeys } from './stateApi';

/** `job.updated` invalidates the whole `release` root (`lib/sse.ts`), so the job view follows every step change. */
export const releaseKeys = {
  root: ['release'] as const,
  engines: ['release', 'engines'] as const,
  jobs: ['release', 'job'] as const,
  job: (repo: string) => ['release', 'job', repo] as const,
  preview: (repo: string, mode: JobMode, version: string) =>
    ['release', repo, 'preview', mode, version] as const,
};

const repoPath = (repo: string) => `/api/release/${encodeURIComponent(repo)}`;

/** The repo's newest release job. Null when it has none: the route answers 404 `job_not_found`. */
export function useReleaseJob(repo: string) {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: releaseKeys.job(repo),
    queryFn: async ({ signal }) => {
      try {
        return await get<ReleaseJobView>(`${repoPath(repo)}/job`, { signal });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'job_not_found') return null;
        throw e;
      }
    },
    refetchInterval: pollMs,
  });
}

/** The engine in Settings, and whether PTY can run on this machine. Re-read on each mount: Settings may have changed it. */
export function useReleaseEngines() {
  return useQuery({
    queryKey: releaseKeys.engines,
    queryFn: ({ signal }) => get<ReleaseEngines>('/api/release-engines', { signal }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** A live read of pubspec on GitLab, so callers enable it only while the form is open and its input is valid. */
export function useReleasePreview(repo: string, mode: JobMode, version: string, enabled: boolean) {
  return useQuery({
    queryKey: releaseKeys.preview(repo, mode, version),
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ mode });
      if (version) qs.set('version', version);
      return get<ReleasePreview>(`${repoPath(repo)}/preview?${qs.toString()}`, { signal });
    },
    enabled,
  });
}

function useJobMutation<A>(repo: string, send: (arg: A) => Promise<ReleaseJobView>) {
  const qc = useQueryClient();
  return useMutation<ReleaseJobView, Error, A>({
    mutationFn: send,
    onSuccess: (view) => {
      qc.setQueryData(releaseKeys.job(repo), view);
    },
    // A refused call usually means the job moved on elsewhere, so the view is re-read either way.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: releaseKeys.job(repo) });
      void qc.invalidateQueries({ queryKey: stateKeys.state });
    },
  });
}

export function useStartRelease(repo: string) {
  return useJobMutation<ReleaseStartRequest>(repo, (body) =>
    post<ReleaseJobView>(`${repoPath(repo)}/start`, body),
  );
}

/** Resume after BUILD stopped to ask for a flavor. */
export function useResumeWithFlavor(repo: string, jobId: string) {
  return useJobMutation<string>(repo, (flavor) =>
    post<ReleaseJobView>(`/api/release/${encodeURIComponent(jobId)}/resume`, { flavor }),
  );
}

export type JobAction = 'continue' | 'cancel' | 'resume';

export function useJobAction(repo: string, jobId: string, action: JobAction) {
  return useJobMutation<void>(repo, () =>
    post<ReleaseJobView>(`/api/release/${encodeURIComponent(jobId)}/${action}`, {}),
  );
}
