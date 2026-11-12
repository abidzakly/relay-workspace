import { ancestorsOf, type DeckSource } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import type { Logger } from '../../util/logger';
import { GitlabApiError, GitlabService } from '../gitlabService';
import type { HttpClient } from '../httpClient';
import { filesReason } from '../mrDetail';
import { inboxItem } from '../mrInbox';
import { DeckError, type DeckCommitReader, type DeckDiff, type DeckDiffReader } from './reviewDeck';

/**
 * Where a deck's diff comes from (two sources, one UI).
 *  - `mr` / `compare`: GitLab (the same reads as the Code Reviewer).
 *  - `local`: `git diff` in a workspace on the Mac (through `localDiff`).
 */
export interface DiffSourceDeps {
  config: ConfigStore;
  cache: AppDb;
  http: HttpClient;
  log: Logger;
  /** workspace diffs. */
  localDiff?: (source: Extract<DeckSource, { kind: 'local' }>) => Promise<DeckDiff>;
  /** the workspace that holds a repo (for "send to agent" from an MR deck). */
  workspaceForRepo?: (repoId: string) => string | null;
  /** Pushed branches without MR, so they count as stack parents. */
  branchHeads?: (repoId: string) => readonly { branch: string; sha: string }[];
  now?: () => number;
}

type Compared = Awaited<ReturnType<GitlabService['compare']>>;

/**
 * `base...branch` limited to the branch's own commits: on a stacked branch the diff starts at the nearest open parent's
 * head instead of the base. `parent` = that branch. Falls back to the full compare when no parent is found or any
 * lookup fails.
 */
export async function ownCommitsCompare(
  gitlab: GitlabService,
  base: string,
  branch: string,
  branchHeads?: () =>
    | readonly { branch: string; sha: string }[]
    | Promise<readonly { branch: string; sha: string }[]>,
  full?: Compared,
): Promise<{ compare: Compared; parent: string | null }> {
  try {
    const all = full ?? (await gitlab.compare(base, branch));
    const [open, heads] = await Promise.all([
      gitlab.listOpenMrsInto(base),
      Promise.resolve(branchHeads?.() ?? []),
    ]);
    const candidates = [
      ...open.mrs
        .filter((m) => m.sourceBranch !== branch)
        .map((m) => ({ key: `!${m.iid}`, branch: m.sourceBranch, headSha: m.headSha ?? null })),
      ...heads
        .filter((h) => h.branch !== branch && !open.mrs.some((m) => m.sourceBranch === h.branch))
        .map((h) => ({ key: `branch:${h.branch}`, branch: h.branch, headSha: h.sha })),
    ];
    const commits = all.commits.map((c) => c.id.toLowerCase());
    const anc = ancestorsOf({ key: 'self', headSha: commits[0] ?? null, commits }, candidates);
    // Nearest parent = its head is the newest among the ancestors' heads.
    const idx = (h: string | null) => commits.indexOf((h ?? '').toLowerCase());
    anc.sort((a, b) => idx(a.headSha) - idx(b.headSha));
    const parent = anc[0];
    if (!parent?.headSha) return { compare: all, parent: null };
    return { compare: await gitlab.compare(parent.headSha, branch), parent: parent.branch };
  } catch {
    return { compare: full ?? (await gitlab.compare(base, branch)), parent: null };
  }
}

export function createDiffReader(d: DiffSourceDeps): DeckDiffReader {
  const svc = (repoId: string) => {
    if (!d.config.getRepo(repoId)) throw new DeckError(404, 'repo_not_found', 'Unknown repository');
    try {
      return GitlabService.forRepo(d.config, repoId, { http: d.http, store: d.cache, log: d.log });
    } catch {
      throw new DeckError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
  };
  const upstream = (e: unknown): never => {
    if (e instanceof GitlabApiError) throw new DeckError(502, `gitlab_${e.kind}`, filesReason(e));
    throw e;
  };
  const target = (repoId: string) => {
    const ws = d.workspaceForRepo?.(repoId) ?? null;
    return ws ? { workspaceId: ws } : null;
  };

  return async (source) => {
    if (source.kind === 'local') {
      if (!d.localDiff)
        throw new DeckError(409, 'local_unavailable', 'Local workspaces are not set up.');
      return d.localDiff(source);
    }
    const repo = d.config.getRepo(source.repoId);
    if (source.kind === 'mr') {
      const item = inboxItem(
        d.cache,
        d.config.listReposFull(),
        d.config.getGlobal(),
        source.repoId,
        source.iid,
        (d.now ?? Date.now)(),
      );
      if (!item) throw new DeckError(404, 'mr_not_found', 'This MR is not in the local cache.');
      const gitlab = svc(source.repoId);
      const full = await gitlab.compare(item.targetBranch, item.sourceBranch).catch(() => null);
      // Only tells later pushes apart: the deck still works without it.
      const headSha = full?.commits[0]?.id ?? null;
      const own = full
        ? await ownCommitsCompare(
            gitlab,
            item.targetBranch,
            item.sourceBranch,
            d.branchHeads ? () => d.branchHeads!(source.repoId) : undefined,
            full,
          )
        : null;
      const r = own?.parent
        ? { files: own.compare.files, truncated: own.compare.truncated }
        : await gitlab.getMrDiffs(source.iid).catch(upstream);
      return {
        headSha,
        title: item.title,
        subtitle: `${item.repoName} · !${item.iid} · ${item.sourceBranch} → ${own?.parent ?? item.targetBranch}`,
        files: r.files,
        truncated: r.truncated,
        card: item.card
          ? { title: item.card.title, status: item.card.status, url: item.card.url }
          : null,
        agentTarget: target(source.repoId),
      };
    }
    const gitlab = svc(source.repoId);
    const full = await gitlab.compare(source.from, source.to).catch(upstream);
    const own = await ownCommitsCompare(
      gitlab,
      source.from,
      source.to,
      d.branchHeads ? () => d.branchHeads!(source.repoId) : undefined,
      full,
    );
    const r = own.compare;
    return {
      headSha: full.commits[0]?.id ?? null,
      title: source.to,
      subtitle: `${repo?.name ?? source.repoId} · ${own.parent ?? source.from}...${source.to} · ${r.commitCount} commit`,
      files: r.files,
      truncated: r.truncated,
      card: null,
      agentTarget: target(source.repoId),
    };
  };
}

export function createCommitReader(
  d: Pick<DiffSourceDeps, 'config' | 'cache' | 'http' | 'log'>,
): DeckCommitReader {
  return async (repoId, from, to) => {
    const r = await GitlabService.forRepo(d.config, repoId, {
      http: d.http,
      store: d.cache,
      log: d.log,
    }).compare(from, to);
    return {
      commits: r.commits.map((c) => ({ id: c.id, message: c.message ?? c.title })),
      truncated: r.commitCount > r.commits.length,
    };
  };
}
