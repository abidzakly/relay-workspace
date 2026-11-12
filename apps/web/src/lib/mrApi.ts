import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MergeBlockedDetailsSchema,
  type InboxStateFilter,
  type MergeGate,
  type MrDetail,
  type MrDraftEvent,
  type MrDraftResult,
  type MrInbox,
  type MrMergeResult,
  type MrStateChangeResult,
  type MrStateEvent,
  type MrNoteResult,
  type MrReplyResult,
  type MrResolveResult,
  type MrUploadResult,
  type UndoResult,
} from '@relay/shared';
import { ApiError, get, post } from './api';
import { useFallbackPollMs } from './sseState';

/** Route state on an MR deep link: the drawer opens its merge dialog, if the gate allows. Merging still needs Confirm. */
export const MR_OPEN_MERGE_STATE = { openMerge: true } as const;

export function wantsMergeDialog(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'openMerge' in state;
}

export interface InboxFilters {
  repo: string;
  state: InboxStateFilter;
  reviewer: string;
}

export const mrKeys = {
  /** Prefix of every inbox query / every detail query (SSE invalidation, `lib/sse.ts`). */
  inboxRoot: ['mrs'] as const,
  detailRoot: ['mr'] as const,
  inbox: (f: InboxFilters) => ['mrs', f.repo, f.state, f.reviewer] as const,
  detail: (repo: string, iid: number) => ['mr', repo, iid] as const,
};

/** Read-only, from the server's local cache. Push-driven (SSE); polls only while the stream is down. */
export function useMrInbox(f: InboxFilters) {
  const pollMs = useFallbackPollMs();
  const qs = new URLSearchParams({ state: f.state });
  if (f.repo) qs.set('repo', f.repo);
  if (f.reviewer) qs.set('reviewer', f.reviewer);
  return useQuery({
    queryKey: mrKeys.inbox(f),
    queryFn: ({ signal }) => get<MrInbox>(`/api/mrs?${qs.toString()}`, { signal }),
    refetchInterval: pollMs,
  });
}

const readMrDetail = (repo: string, iid: number, signal?: AbortSignal) =>
  get<MrDetail>(`/api/mrs/${encodeURIComponent(repo)}/${iid}`, signal ? { signal } : {});

/** Cache + a GET-only live read of GitLab on the server (can take a few seconds), so no background polling. */
export function useMrDetail(repo: string, iid: number) {
  return useQuery({
    queryKey: mrKeys.detail(repo, iid),
    queryFn: ({ signal }) => readMrDetail(repo, iid, signal),
    enabled: iid > 0,
    staleTime: 15_000,
  });
}

const mrPath = (repo: string, iid: number) => `/api/mrs/${encodeURIComponent(repo)}/${iid}`;

/** Optimistic edits are applied to the cached detail and rolled back from this snapshot on error. */
interface Snapshot {
  previous: MrDetail | undefined;
}

function patchThreads(
  d: MrDetail | undefined,
  discussionId: string,
  fn: (t: MrDetail['discussions']['threads'][number]) => MrDetail['discussions']['threads'][number],
): MrDetail | undefined {
  if (!d) return d;
  return {
    ...d,
    discussions: {
      ...d.discussions,
      threads: d.discussions.threads.map((t) => (t.id === discussionId ? fn(t) : t)),
    },
  };
}

/**
 * Reply to a thread. Optimistic: the note appears at once; on error the cached detail is restored from
 * the snapshot. Always refetched afterwards (live GitLab is the truth; in dry-run that drops the
 * simulated note again, which is the honest outcome). Not undoable.
 */
export function useReply(repo: string, iid: number) {
  const qc = useQueryClient();
  const key = mrKeys.detail(repo, iid);
  return useMutation<MrReplyResult, Error, { discussionId: string; body: string }, Snapshot>({
    mutationFn: (v) => post<MrReplyResult>(`${mrPath(repo, iid)}/reply`, v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MrDetail>(key);
      qc.setQueryData<MrDetail | undefined>(
        key,
        patchThreads(previous, v.discussionId, (t) => ({
          ...t,
          notes: [
            ...t.notes,
            {
              id: -Date.now(),
              author: null,
              body: v.body.trim(),
              createdAt: Date.now(),
              unread: false,
            },
          ],
        })),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Resolve / unresolve with optimistic toggle + rollback. Undoable while the audit row has a token. */
export function useResolve(repo: string, iid: number) {
  const qc = useQueryClient();
  const key = mrKeys.detail(repo, iid);
  return useMutation<MrResolveResult, Error, { discussionId: string; resolved: boolean }, Snapshot>(
    {
      mutationFn: (v) => post<MrResolveResult>(`${mrPath(repo, iid)}/resolve`, v),
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: key });
        const previous = qc.getQueryData<MrDetail>(key);
        qc.setQueryData<MrDetail | undefined>(
          key,
          patchThreads(previous, v.discussionId, (t) => ({ ...t, resolved: v.resolved })),
        );
        return { previous };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      },
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: key });
      },
    },
  );
}

/**
 * A new top-level comment. Optimistic like `useReply`: a pending thread appears at the end at once and is replaced
 * by the refetch (dropped again in dry-run, the honest outcome). Not undoable.
 */
export function useNote(repo: string, iid: number) {
  const qc = useQueryClient();
  const key = mrKeys.detail(repo, iid);
  return useMutation<MrNoteResult, Error, { body: string }, Snapshot>({
    mutationFn: (v) => post<MrNoteResult>(`${mrPath(repo, iid)}/note`, v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MrDetail>(key);
      if (previous) {
        const now = Date.now();
        qc.setQueryData<MrDetail>(key, {
          ...previous,
          discussions: {
            ...previous.discussions,
            threads: [
              ...previous.discussions.threads,
              {
                id: `pending-${now}`,
                resolvable: false,
                resolved: false,
                individual: true,
                notes: [
                  { id: -now, author: null, body: v.body.trim(), createdAt: now, unread: false },
                ],
              },
            ],
          },
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** An image for a comment, read as base64 here (the API takes JSON only). Returns GitLab's markdown for it. */
export function useUpload(repo: string, iid: number) {
  return useMutation<MrUploadResult, Error, { filename: string; type: string; file: Blob }>({
    mutationFn: async ({ filename, type, file }) => {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
        r.onerror = () => reject(new Error('Could not read the image'));
        r.readAsDataURL(file);
      });
      return post<MrUploadResult>(`${mrPath(repo, iid)}/upload`, { filename, type, data });
    },
  });
}

/** `POST /api/audit/:id/undo` (the Audit view will reuse it); refetches the MR it touched. */
export function useUndo(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<UndoResult, Error, number>({
    mutationFn: (auditId) => post<UndoResult>(`/api/audit/${auditId}/undo`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid) });
    },
  });
}

/**
 * `POST /api/mrs/:repo/:iid/merge`. NOT optimistic: the server re-checks the gate live and may refuse, so
 * nothing changes on screen until it answers. The detail and the inbox are refetched either way (a refusal
 * means this page was out of date).
 */
export function useMerge(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<MrMergeResult, Error, void>({
    mutationFn: () => post<MrMergeResult>(`${mrPath(repo, iid)}/merge`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid) });
      void qc.invalidateQueries({ queryKey: mrKeys.inboxRoot });
    },
  });
}

/** True only when a fresh server read says every one of these MRs is merged. A failed read counts as not known. */
export function useAllMerged() {
  const qc = useQueryClient();
  return async (repo: string, iids: readonly number[]): Promise<boolean> => {
    try {
      const details = await Promise.all(
        iids.map((iid) =>
          qc.fetchQuery({
            queryKey: mrKeys.detail(repo, iid),
            queryFn: ({ signal }) => readMrDetail(repo, iid, signal),
            staleTime: 0,
          }),
        ),
      );
      return details.every((d) => d.approvals.gate.state === 'merged');
    } catch {
      return false;
    }
  };
}

/** Close / reopen. Not optimistic: the server re-reads the state live and may refuse. */
export function useMrStateChange(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<MrStateChangeResult, Error, MrStateEvent>({
    mutationFn: (event) => post<MrStateChangeResult>(`${mrPath(repo, iid)}/${event}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid) });
      void qc.invalidateQueries({ queryKey: mrKeys.inboxRoot });
    },
  });
}

/** Set draft / mark ready: toggles the MR's draft flag in GitLab. */
export function useMrDraft(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<MrDraftResult, Error, MrDraftEvent>({
    mutationFn: (event) => post<MrDraftResult>(`${mrPath(repo, iid)}/${event}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid) });
      void qc.invalidateQueries({ queryKey: mrKeys.inboxRoot });
    },
  });
}

/** "Turn off squash": turns the MR's own squash flag off in GitLab. */
export function useDisableSquash(repo: string, iid: number) {
  const qc = useQueryClient();
  return useMutation<{ dryRun: boolean; auditId: number }, Error, void>({
    mutationFn: () => post(`${mrPath(repo, iid)}/squash-off`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mrKeys.detail(repo, iid) });
    },
  });
}

/** The live gate the server refused with (409 `merge_blocked`), or null for any other error. */
export function refusedGate(e: unknown): MergeGate | null {
  if (!(e instanceof ApiError) || e.code !== 'merge_blocked') return null;
  const p = MergeBlockedDetailsSchema.safeParse(e.details);
  return p.success ? p.data.gate : null;
}
