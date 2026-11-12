import { and, eq, inArray } from 'drizzle-orm';
import {
  ancestorsOf,
  buildStackForest,
  stacksOf,
  type MergeGateInput,
  type MrStack,
  type MrStackRef,
  type StackInputNode,
} from '@relay/shared';
import type { AppDb } from '../db';
import { mrCommits, mrs } from '../db/schema';
import type { MrFields } from './gitlabMr';
import { GitlabApiError } from './gitlabService';

/**
 * Stacked MRs. Two halves:
 *  - LIVE (`readLiveStack`): what the merge gate decides on. Every read failure, truncated list or missing SHA
 *    FAILS CLOSED (`status: 'error'`). Nothing cached is trusted here.
 *  - CACHE (`loadStackRefs`): the cosmetic layout of the lists (parent at the bottom, `#n` badges).
 */

/** The GET-only slice of `GitlabService` the live check needs. */
export interface StackReader {
  getMrCommitShas(iid: number): Promise<{ shas: string[]; truncated: boolean }>;
  listOpenMrsInto(targetBranch: string): Promise<{ mrs: MrFields[]; complete: boolean }>;
}

/** Pushed branches without an MR (`branch_pushes`); their heads count as ancestors too. */
export type BranchHeadsReader = () => Promise<readonly { branch: string; sha: string }[]>;

const safeMsg = (e: unknown): string =>
  e instanceof GitlabApiError ? e.message : 'unexpected error';

export async function readLiveStack(
  reader: StackReader,
  mr: { iid: number; sourceBranch: string; targetBranch: string; headSha?: string | null },
  opts: { branchHeads?: BranchHeadsReader; store?: AppDb; repoId?: string; now?: number } = {},
): Promise<MergeGateInput['stack']> {
  const fail = (message: string): MergeGateInput['stack'] => ({
    status: 'error',
    openParents: [],
    commitCount: null,
    message,
  });
  let commits: { shas: string[]; truncated: boolean };
  let open: { mrs: MrFields[]; complete: boolean };
  try {
    [commits, open] = await Promise.all([
      reader.getMrCommitShas(mr.iid),
      reader.listOpenMrsInto(mr.targetBranch),
    ]);
  } catch (e) {
    return fail(safeMsg(e));
  }
  if (commits.truncated) return fail('the MR has too many commits to verify');
  if (!open.complete) return fail('the open MR list could not be read completely');

  const others = open.mrs.filter((m) => m.iid !== mr.iid);
  if (others.some((m) => !m.headSha)) return fail('an open MR has no head SHA in GitLab’s answer');

  const candidates: { key: string; iid: number | null; branch: string; headSha: string | null }[] =
    others.map((m) => ({
      key: `!${m.iid}`,
      iid: m.iid,
      branch: m.sourceBranch,
      headSha: m.headSha ?? null,
    }));
  if (opts.branchHeads) {
    let heads: readonly { branch: string; sha: string }[];
    try {
      heads = await opts.branchHeads();
    } catch (e) {
      return fail(safeMsg(e));
    }
    const withMr = new Set([mr.sourceBranch, ...others.map((m) => m.sourceBranch)]);
    for (const h of heads) {
      if (withMr.has(h.branch)) continue;
      candidates.push({ key: `branch:${h.branch}`, iid: null, branch: h.branch, headSha: h.sha });
    }
  }

  const headSha = mr.headSha ?? commits.shas[0] ?? null;
  const parents = ancestorsOf({ key: `!${mr.iid}`, headSha, commits: commits.shas }, candidates);

  if (opts.store && opts.repoId && headSha) {
    try {
      saveMrCommits(opts.store, opts.repoId, mr.iid, headSha, commits.shas, opts.now ?? Date.now());
    } catch {
      /* the cache is cosmetic */
    }
  }

  return {
    status: 'ok',
    openParents: parents.map((p) => ({ iid: p.iid, branch: p.branch })),
    commitCount: commits.shas.length,
  };
}

export function saveMrCommits(
  store: AppDb,
  repoId: string,
  iid: number,
  headSha: string,
  shas: readonly string[],
  now: number,
): void {
  store.db
    .insert(mrCommits)
    .values({ repoId, iid, headSha, shas: [...shas], fetchedAt: now })
    .onConflictDoUpdate({
      target: [mrCommits.repoId, mrCommits.iid],
      set: { headSha, shas: [...shas], fetchedAt: now },
    })
    .run();
}

/**
 * Keeps `mr_commits` current for one open MR (called from the MR sync). Re-reads only when the head moved.
 * Never throws: a failure leaves the old row (the list layout is cosmetic; the gate reads live).
 */
export async function refreshMrCommits(
  reader: Pick<StackReader, 'getMrCommitShas'>,
  store: AppDb,
  repoId: string,
  f: Pick<MrFields, 'iid' | 'state' | 'headSha'>,
  now: number,
): Promise<void> {
  if (f.state !== 'opened' || !f.headSha) return;
  try {
    const row = store.db
      .select({ headSha: mrCommits.headSha })
      .from(mrCommits)
      .where(and(eq(mrCommits.repoId, repoId), eq(mrCommits.iid, f.iid)))
      .get();
    if (row && row.headSha.toLowerCase() === f.headSha.toLowerCase()) return;
    const { shas, truncated } = await reader.getMrCommitShas(f.iid);
    if (truncated) return;
    saveMrCommits(store, repoId, f.iid, f.headSha, shas, now);
  } catch {
    /* cosmetic cache */
  }
}

export interface StackLayout {
  refs: Map<string, MrStackRef>;
  stacks: MrStack[];
}

/**
 * Stack layout of the CACHED open MRs (+ optional pushed branches without MR). Key of `refs` is
 * `<repoId>!<iid>`. MRs whose commits are not cached yet are laid out alone with `commitCount: null`.
 */
export function loadStackRefs(
  store: AppDb,
  extraBranches: readonly {
    repoId: string;
    branch: string;
    sha: string;
    commits: string[] | null;
  }[] = [],
): StackLayout {
  const open = store.db
    .select({
      repoId: mrs.repoId,
      iid: mrs.iid,
      sourceBranch: mrs.sourceBranch,
      targetBranch: mrs.targetBranch,
    })
    .from(mrs)
    .where(inArray(mrs.state, ['opened', 'locked']))
    .all();
  const commits = new Map(
    store.db
      .select()
      .from(mrCommits)
      .all()
      .map((r) => [`${r.repoId}!${r.iid}`, r] as const),
  );
  const byRepo = new Map<string, StackInputNode[]>();
  const push = (repoId: string, n: StackInputNode) => {
    const list = byRepo.get(repoId);
    if (list) list.push(n);
    else byRepo.set(repoId, [n]);
  };
  for (const m of open) {
    const c = commits.get(`${m.repoId}!${m.iid}`);
    push(m.repoId, {
      key: `!${m.iid}`,
      iid: m.iid,
      branch: m.sourceBranch,
      headSha: c?.headSha ?? null,
      commits: c?.shas ?? null,
    });
  }
  for (const b of extraBranches) {
    const taken = (byRepo.get(b.repoId) ?? []).some((n) => n.branch === b.branch);
    if (taken) continue;
    push(b.repoId, {
      key: `branch:${b.branch}`,
      iid: null,
      branch: b.branch,
      headSha: b.sha,
      commits: b.commits,
    });
  }

  const refs = new Map<string, MrStackRef>();
  const stacks: MrStack[] = [];
  for (const [repoId, nodes] of byRepo) {
    const placements = buildStackForest(nodes);
    const byKey = new Map(nodes.map((n) => [n.key, n] as const));
    const size = new Map<string, number>();
    for (const p of placements) size.set(p.rootKey, (size.get(p.rootKey) ?? 0) + 1);
    for (const p of placements) {
      const self = byKey.get(p.key)!;
      const parent = p.parentKey ? byKey.get(p.parentKey) : undefined;
      refs.set(self.iid !== null ? `${repoId}!${self.iid}` : `${repoId}:${self.branch}`, {
        groupId: `${repoId}:${p.rootKey}`,
        position: p.position,
        size: size.get(p.rootKey) ?? 1,
        parentIid: parent?.iid ?? null,
        parentBranch: parent?.branch ?? null,
        parentHasMr: parent ? parent.iid !== null : true,
        blocked: !!parent || self.commits === null,
        commitCount: self.commits ? self.commits.length : null,
      });
    }
    stacks.push(...stacksOf(repoId, nodes, placements));
  }
  return { refs, stacks };
}
