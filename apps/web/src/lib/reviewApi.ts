import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BranchList,
  CompareReview,
  MrApproveResult,
  MrReplyResult,
  MrResolveResult,
  MrReview,
  ReviewCommentResult,
  ReviewDiscussion,
  ReviewPosition,
} from '@relay/shared';
import { get, post } from './api';
import { mrKeys } from './mrApi';

/**
 * Code Reviewer data. The MR review hangs off the MR detail key (`['mr', repo, iid, 'review']`), so the existing
 * SSE invalidation (`mrs.changed`) refreshes it when someone pushes or comments.
 */
export const reviewKeys = {
  mr: (repo: string, iid: number) => [...mrKeys.detail(repo, iid), 'review'] as const,
  compare: (repo: string, from: string, to: string) =>
    ['review', 'compare', repo, from, to] as const,
  branches: (repo: string, search: string) => ['review', 'branches', repo, search] as const,
};

const enc = encodeURIComponent;

export function useMrReview(repo: string, iid: number) {
  return useQuery({
    queryKey: reviewKeys.mr(repo, iid),
    queryFn: ({ signal }) => get<MrReview>(`/api/review/${enc(repo)}/mr/${iid}`, { signal }),
    enabled: Boolean(repo) && iid > 0,
    staleTime: 30_000,
  });
}

export function useCompareReview(repo: string, from: string, to: string) {
  return useQuery({
    queryKey: reviewKeys.compare(repo, from, to),
    queryFn: ({ signal }) =>
      get<CompareReview>(
        `/api/review/${enc(repo)}/compare?${new URLSearchParams({ from, to }).toString()}`,
        { signal },
      ),
    enabled: Boolean(repo && from && to && from !== to),
    staleTime: 60_000,
  });
}

export function useBranches(repo: string, search: string) {
  return useQuery({
    queryKey: reviewKeys.branches(repo, search),
    queryFn: ({ signal }) =>
      get<BranchList>(
        `/api/repos/${enc(repo)}/branches${search ? `?${new URLSearchParams({ search }).toString()}` : ''}`,
        { signal },
      ),
    enabled: Boolean(repo),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

interface Snapshot {
  previous: MrReview | undefined;
}

const mrPath = (repo: string, iid: number) => `/api/mrs/${enc(repo)}/${iid}`;

function patch(
  d: MrReview | undefined,
  id: string,
  fn: (t: ReviewDiscussion) => ReviewDiscussion,
): MrReview | undefined {
  return d && { ...d, discussions: d.discussions.map((t) => (t.id === id ? fn(t) : t)) };
}

/** The three review writes share one shape: optimistic patch, rollback on error, refetch after. */
function useReviewMutation<V, R>(
  repo: string,
  iid: number,
  send: (v: V) => Promise<R>,
  optimistic: (d: MrReview | undefined, v: V) => MrReview | undefined,
) {
  const qc = useQueryClient();
  const key = reviewKeys.mr(repo, iid);
  return useMutation<R, Error, V, Snapshot>({
    mutationFn: send,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MrReview>(key);
      qc.setQueryData<MrReview | undefined>(key, optimistic(previous, v));
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key, exact: true });
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid), exact: true });
    },
  });
}

const pendingNote = (body: string) => ({
  id: -Date.now(),
  author: null,
  body: body.trim(),
  createdAt: Date.now(),
  unread: false,
});

export function useReviewComment(repo: string, iid: number) {
  return useReviewMutation<
    { position: ReviewPosition; body: string; headSha?: string },
    ReviewCommentResult
  >(
    repo,
    iid,
    (v) => post<ReviewCommentResult>(`${mrPath(repo, iid)}/comment`, v),
    (d, v) =>
      d && {
        ...d,
        discussions: [
          ...d.discussions,
          {
            id: `pending-${Date.now()}`,
            resolvable: true,
            resolved: false,
            notes: [pendingNote(v.body)],
            position: v.position,
          },
        ],
      },
  );
}

export function useReviewReply(repo: string, iid: number) {
  return useReviewMutation<{ discussionId: string; body: string }, MrReplyResult>(
    repo,
    iid,
    (v) => post<MrReplyResult>(`${mrPath(repo, iid)}/reply`, v),
    (d, v) => patch(d, v.discussionId, (t) => ({ ...t, notes: [...t.notes, pendingNote(v.body)] })),
  );
}

export function useReviewResolve(repo: string, iid: number) {
  return useReviewMutation<{ discussionId: string; resolved: boolean }, MrResolveResult>(
    repo,
    iid,
    (v) => post<MrResolveResult>(`${mrPath(repo, iid)}/resolve`, v),
    (d, v) => patch(d, v.discussionId, (t) => ({ ...t, resolved: v.resolved })),
  );
}

/** The approval state GitLab just confirmed, applied to a cached review. Pure. */
export function confirmedApproval(
  d: MrReview | undefined,
  r: MrApproveResult,
): MrReview | undefined {
  if (!d || r.dryRun) return d;
  return {
    ...d,
    approval: {
      ...d.approval,
      mode: r.mode,
      approvedByMe: r.approved,
      canApprove: !r.approved,
      canRevoke: r.approved && r.mode !== 'note_keyword',
      reason: null,
    },
  };
}

/**
 * Approve / revoke mine. NOT optimistic: the button says "Approved" only once GitLab (or dry-run) answered. The
 * answer itself updates the review (the server's MR cache catches up in the background, so an immediate refetch could
 * still show the old state); the MR's own `mrs.changed` event refreshes everything once the cache has it.
 */
export function useReviewApprove(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<MrApproveResult, Error, { approved: boolean }>({
    mutationFn: (v) => post<MrApproveResult>(`${mrPath(repo, iid)}/approve`, v),
    onSuccess: (r) => {
      qc.setQueryData<MrReview | undefined>(reviewKeys.mr(repo, iid), (d) =>
        confirmedApproval(d, r),
      );
    },
    onError: () => {
      // A refusal may mean the cached state was stale: read it again.
      void qc.invalidateQueries({ queryKey: reviewKeys.mr(repo, iid), exact: true });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid), exact: true });
      void qc.invalidateQueries({ queryKey: mrKeys.inboxRoot });
    },
  });
}

/** Where "Back" goes from a review session that was opened from the inbox, an MR drawer or the palette. */
export interface ReviewOrigin {
  from: string;
  label: string;
}

/**
 * A same-app path only: `/x`, never `//host` or `/\host` (both leave the origin in a browser), and no control
 * characters. Anything else is ignored, so a crafted `?back=` cannot send the reviewer off-site.
 */
export function safeBackPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length > 2000) return null;
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  return p;
}

/** The name of the place a path leads back to, for the Back button. */
export function backLabel(path: string): string {
  const p = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (p === '/') return 'Workspace';
  if (/^\/mrs\/[^/]+\/\d+$/.test(p)) return 'MR detail';
  if (p === '/mrs') return 'MR Inbox';
  if (p === '/review') return 'Code Review';
  if (p === '/reviews') return 'Reviews';
  return 'Back';
}

/**
 * Where Back goes. History state first (it carries the label the link chose), then the URL's `?back=` (survives a
 * copied link, a new tab, a refresh in another browser).
 */
export function reviewOrigin(state: unknown, search = ''): ReviewOrigin | null {
  if (typeof state === 'object' && state !== null) {
    const s = state as { reviewFrom?: unknown; reviewFromLabel?: unknown };
    const from = safeBackPath(s.reviewFrom);
    if (from)
      return {
        from,
        label: typeof s.reviewFromLabel === 'string' ? s.reviewFromLabel : backLabel(from),
      };
  }
  const back = safeBackPath(new URLSearchParams(search).get('back'));
  return back ? { from: back, label: backLabel(back) } : null;
}

export const reviewPath = (repo: string, iid: number) => `/review/${enc(repo)}/mr/${iid}`;

/** Route state for a "Review in Code Reviewer" link, so the session can return where it started. */
export const reviewState = (from: string, label: string) => ({
  reviewFrom: from,
  reviewFromLabel: label,
});

/** Adds `?back=` to a review path (MR session or compare), keeping its own query. */
export function withBack(path: string, from: string): string {
  const back = safeBackPath(from);
  if (!back) return path;
  const [base, query = ''] = path.split('?');
  const qs = new URLSearchParams(query);
  qs.set('back', back);
  return `${base}?${qs.toString()}`;
}

/**
 * A link into a review that knows its way back: `to` carries `?back=` (the URL stays the source of truth)
 * and `state` the label. Spread into a `<Link>` or pass to `navigate(to, { state })`.
 */
export function reviewLink(repo: string, iid: number, from: string, label: string) {
  const back = safeBackPath(from);
  return {
    to: withBack(reviewPath(repo, iid), from),
    state: back ? reviewState(back, label) : undefined,
  };
}
