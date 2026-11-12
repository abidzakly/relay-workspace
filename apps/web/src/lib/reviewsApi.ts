import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewDesk, ReviewTokenStatus } from '@relay/shared';
import { get, post, put } from './api';

/** Reviews (the reviewer's desk). The server pushes `reviews.changed` over SSE, so these rarely refetch on their own. */
export const reviewsKeys = {
  root: ['reviews'] as const,
  desk: ['reviews', 'desk'] as const,
  token: ['reviews', 'token'] as const,
};

export function useReviewDesk(enabled = true) {
  return useQuery({
    queryKey: reviewsKeys.desk,
    queryFn: ({ signal }) => get<ReviewDesk>('/api/reviews', { signal }),
    enabled,
    // The "asked 3h ago" ages and the poll clock move even without events.
    refetchInterval: 60_000,
  });
}

/** The desk item for one review session (`~<projectId>` + iid), if it is on the desk. */
export function useDeskItem(repoId: string, iid: number) {
  const q = useReviewDesk(repoId.startsWith('~'));
  return q.data?.items.find((i) => i.repoId === repoId && i.iid === iid) ?? null;
}

function useDeskWrite<A>(fn: (a: A) => Promise<ReviewDesk>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (desk) => qc.setQueryData(reviewsKeys.desk, desk),
  });
}

export function useRefreshDesk() {
  return useDeskWrite(() => post<ReviewDesk>('/api/reviews/refresh', {}));
}

export function useMarkReviewed() {
  return useDeskWrite((a: { key: string; sha: string | null }) =>
    post<ReviewDesk>(`/api/reviews/${encodeURIComponent(a.key)}/mark`, { sha: a.sha }),
  );
}

export function useSnooze() {
  return useDeskWrite((a: { key: string; until: number | null }) =>
    post<ReviewDesk>(`/api/reviews/${encodeURIComponent(a.key)}/snooze`, { until: a.until }),
  );
}

export function useTodoDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (todoId: number) =>
      post<{ dryRun: boolean; auditId: number }>(`/api/reviews/todos/${todoId}/done`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: reviewsKeys.desk }),
  });
}

export function useReviewToken() {
  return useQuery({
    queryKey: reviewsKeys.token,
    queryFn: ({ signal }) => get<ReviewTokenStatus>('/api/reviews/token', { signal }),
  });
}

export function useSaveReviewToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string | null) => put<ReviewTokenStatus>('/api/reviews/token', { token }),
    onSuccess: (status) => {
      qc.setQueryData(reviewsKeys.token, status);
      void qc.invalidateQueries({ queryKey: reviewsKeys.desk });
    },
  });
}

/** Creates (first time) and returns the Reviews webhook secret, to paste into GitLab. */
export function useRevealWebhookSecret() {
  return useMutation({
    mutationFn: () =>
      post<{ secret: string; url: string | null }>('/api/reviews/webhook-secret', {}),
  });
}
