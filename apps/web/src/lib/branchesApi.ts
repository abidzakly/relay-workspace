import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BranchDeleteBody,
  BranchDeleteResult,
  BranchFetchResult,
  BranchListResult,
  CardLinkBody,
  StateCard,
} from '@relay/shared';
import { api, get, post, put } from './api';
import { readyKeys } from './mrCreateApi';
import { testBenchKeys } from './testBenchApi';

/** Branches page: every branch of a repo (local + remote) with its MR and card. */

export const branchKeys = {
  root: ['branches'] as const,
  list: (repo: string) => ['branches', repo] as const,
};

export const branchesPath = (repo?: string | null) =>
  repo ? `/branches/${encodeURIComponent(repo)}` : '/branches';

export function useBranches(repo: string | null) {
  return useQuery({
    queryKey: branchKeys.list(repo ?? ''),
    queryFn: () => get<BranchListResult>(`/api/branches?repo=${encodeURIComponent(repo!)}`),
    enabled: !!repo,
    staleTime: 20_000,
  });
}

/** `git fetch origin` in the repo workspace, then the list again. */
export function useFetchBranches() {
  const qc = useQueryClient();
  return useMutation<BranchFetchResult, Error, { repo: string }>({
    mutationFn: (b) => post('/api/branches/fetch', b),
    onSettled: (_r, _e, v) => void qc.invalidateQueries({ queryKey: branchKeys.list(v.repo) }),
  });
}

function useAfterLink() {
  const qc = useQueryClient();
  return (repo: string, branch: string) => {
    void qc.invalidateQueries({ queryKey: branchKeys.list(repo) });
    void qc.invalidateQueries({ queryKey: readyKeys.preview(repo, branch) });
    void qc.invalidateQueries({ queryKey: testBenchKeys.branch(repo, branch) });
  };
}

export function useLinkCard() {
  const after = useAfterLink();
  return useMutation<{ ok: true }, Error, CardLinkBody>({
    mutationFn: (b) => put('/api/branches/card-link', b),
    onSuccess: (_r, v) => after(v.repo, v.branch),
  });
}

export function useUnlinkCard() {
  const after = useAfterLink();
  return useMutation<{ ok: true; removed: boolean }, Error, { repo: string; branch: string }>({
    mutationFn: (b) => api('DELETE', '/api/branches/card-link', b),
    onSuccess: (_r, v) => after(v.repo, v.branch),
  });
}

/** Deletes a branch on the Mac and/or origin. Refusals come back as errors; partial results as `failed` parts. */
export function useDeleteBranch() {
  const after = useAfterLink();
  return useMutation<BranchDeleteResult, Error, BranchDeleteBody>({
    mutationFn: (b) => post('/api/branches/delete', b),
    onSettled: (_r, _e, v) => after(v.repo, v.branch),
  });
}

const DONE = /done|complete|closed|cancel|archiv|released/i;

/**
 * Cards worth offering for a branch, best first: in this repo's Product Domain, mine, without a branch of their own,
 * not finished, recently edited. A word of the branch name in the title counts too.
 */
export function rankCardsForBranch(
  cards: readonly StateCard[],
  repo: string,
  branch: string,
): StateCard[] {
  const words = branch
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) => w.length >= 3 && !['feat', 'fix', 'chore', 'docs', 'hotfix', 'release'].includes(w),
    );
  const score = (c: StateCard) => {
    let s = 0;
    if (c.domainRepoIds.includes(repo) || c.domainRepoId === repo) s += 40;
    if (c.mine) s += 30;
    if (!c.branchName?.trim()) s += 15;
    if (c.status && DONE.test(c.status)) s -= 50;
    const t = c.title.toLowerCase();
    s += words.filter((w) => t.includes(w)).length * 12;
    return s;
  };
  return [...cards].sort((a, b) => score(b) - score(a) || b.lastEditedAt - a.lastEditedAt);
}
