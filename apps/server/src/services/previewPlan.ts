import { and, eq, inArray } from 'drizzle-orm';
import {
  buildStackForest,
  isSafeBranchName,
  type PreviewCandidate,
  type PreviewCandidates,
  type PreviewMr,
  type StackInputNode,
  type StackPlacement,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { mrCommits, mrs } from '../db/schema';
import { ActionError } from './actionError';

/**
 * QA preview (merge order). The open MRs of a repo, each stack parent before its child, otherwise by MR number.
 * Read from the local cache, like the list layout: the merge itself is local and checked by git.
 */

export interface PreviewMrRow {
  iid: number;
  title: string;
  branch: string;
  draft: boolean;
  hasConflicts: boolean;
  webUrl: string | null;
  headSha: string | null;
  commits: readonly string[] | null;
}

/** Pure. A child that is placed under a parent comes after it, whatever the numbers say. */
export function orderForMerge(
  rows: readonly PreviewMrRow[],
): (PreviewMrRow & { parentBranch: string | null })[] {
  const nodes: StackInputNode[] = rows.map((r) => ({
    key: `!${r.iid}`,
    iid: r.iid,
    branch: r.branch,
    headSha: r.headSha,
    commits: r.commits,
  }));
  const placements = new Map<string, StackPlacement>(
    buildStackForest(nodes).map((p) => [p.key, p] as const),
  );
  const byKey = new Map<string, PreviewMrRow>(rows.map((r) => [`!${r.iid}`, r] as const));
  const rootIid = (key: string) => byKey.get(placements.get(key)?.rootKey ?? key)?.iid ?? 0;
  return [...rows]
    .sort((a, b) => {
      const pa = placements.get(`!${a.iid}`);
      const pb = placements.get(`!${b.iid}`);
      return (
        rootIid(`!${a.iid}`) - rootIid(`!${b.iid}`) ||
        (pa?.position ?? 1) - (pb?.position ?? 1) ||
        a.iid - b.iid
      );
    })
    .map((r) => {
      const parentKey = placements.get(`!${r.iid}`)?.parentKey ?? null;
      return { ...r, parentBranch: parentKey ? (byKey.get(parentKey)?.branch ?? null) : null };
    });
}

function openRows(store: AppDb, repoId: string, baseBranch: string): PreviewMrRow[] {
  const rows = store.db
    .select()
    .from(mrs)
    .where(
      and(
        eq(mrs.repoId, repoId),
        eq(mrs.targetBranch, baseBranch),
        inArray(mrs.state, ['opened', 'locked']),
      ),
    )
    .all();
  const commits = new Map(
    store.db
      .select()
      .from(mrCommits)
      .where(eq(mrCommits.repoId, repoId))
      .all()
      .map((c) => [c.iid, c] as const),
  );
  return rows.map((m) => ({
    iid: m.iid,
    title: m.title,
    branch: m.sourceBranch,
    draft: m.draft,
    hasConflicts: m.hasConflicts,
    webUrl: m.webUrl,
    headSha: commits.get(m.iid)?.headSha ?? null,
    commits: commits.get(m.iid)?.shas ?? null,
  }));
}

function baseOf(config: Pick<ConfigStore, 'getRepo'>, repoId: string): string {
  const repo = config.getRepo(repoId);
  if (!repo) throw new ActionError(404, 'repo_not_found', 'Unknown repo');
  return repo.baseBranch;
}

export function listPreviewCandidates(
  store: AppDb,
  config: Pick<ConfigStore, 'getRepo'>,
  repoId: string,
): PreviewCandidates {
  const baseBranch = baseOf(config, repoId);
  const items: PreviewCandidate[] = orderForMerge(openRows(store, repoId, baseBranch)).map(
    (r, i) => ({
      iid: r.iid,
      title: r.title,
      branch: r.branch,
      draft: r.draft,
      hasConflicts: r.hasConflicts,
      order: i + 1,
      parentBranch: r.parentBranch,
      webUrl: r.webUrl,
    }),
  );
  return { baseBranch, items };
}

/** The chosen MRs, in merge order. Every one must still be open on the base branch. */
export function resolvePreviewMrs(
  store: AppDb,
  config: Pick<ConfigStore, 'getRepo'>,
  repoId: string,
  iids: readonly number[],
): PreviewMr[] {
  const baseBranch = baseOf(config, repoId);
  const chosen = new Set(iids);
  const rows = orderForMerge(openRows(store, repoId, baseBranch));
  const missing = [...chosen].filter((iid) => !rows.some((r) => r.iid === iid));
  if (missing.length > 0) {
    throw new ActionError(
      409,
      'mr_not_open',
      `Not open on ${baseBranch}: ${missing.map((i) => `!${i}`).join(', ')}. Refresh the list.`,
    );
  }
  const picked = rows.filter((r) => chosen.has(r.iid));
  const unsafe = picked.find((r) => !isSafeBranchName(r.branch));
  if (unsafe) {
    throw new ActionError(
      422,
      'unsafe_branch',
      `!${unsafe.iid} has a branch name that cannot be used`,
    );
  }
  return picked.map(({ iid, branch, title }) => ({ iid, branch, title }));
}
