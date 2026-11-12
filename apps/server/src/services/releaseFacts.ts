import type { ReleaseFact } from '@relay/shared';
import { releaseOfMr, type ReleaseState } from './releaseDetector';
import { isVersionMr } from './versionMr';

/**
 * Release facts for merged MRs. PURE. `bumped` and `version` come from the pending-release
 * detector, so a fact and the repo's `pendingMrs` can never disagree.
 *
 * Honesty rules (no "can't tell" is ever reported as a definite answer):
 *  - the merged-MR list was not read recently and completely, and no newer version MR is known → `bumped: null`
 *  - merged MR without `mergedAt`                      → `bumped: null`
 *  - the dashboard never ran a (non-dry-run) build job for the repo, or the release's version is not known → `built: null`
 */

export interface ReleaseMr {
  repoId: string;
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  mergedAt: number | null;
}

export interface ReleaseRepo {
  id: string;
  baseBranch: string;
  versionBranchPrefix: string;
}

export interface BuildJobRow {
  repoId: string;
  kind: string;
  status: string;
  version: string | null;
  dryRun: boolean;
}

const stripV = (v: string) => v.trim().replace(/^v/i, '');

export function deriveReleaseFacts(
  mrs: readonly ReleaseMr[],
  repos: readonly ReleaseRepo[],
  jobs: readonly BuildJobRow[],
  states: ReadonlyMap<string, ReleaseState>,
): Map<string, ReleaseFact> {
  const out = new Map<string, ReleaseFact>();
  const repoBy = new Map(repos.map((r) => [r.id, r] as const));

  // Real build runs only: a dry-run never built anything.
  const builds = jobs.filter((j) => j.kind === 'build' && !j.dryRun);
  const anyBuild = new Set(builds.map((j) => j.repoId));
  const builtVersions = new Set(
    builds
      .filter((j) => j.status === 'succeeded' && j.version)
      .map((j) => `${j.repoId}\u0000${stripV(j.version!)}`),
  );

  for (const m of mrs) {
    const repo = repoBy.get(m.repoId);
    if (!repo || m.state !== 'merged' || isVersionMr(m, repo.versionBranchPrefix)) continue;
    const onBase = m.targetBranch === repo.baseBranch;
    const fact: ReleaseFact = {
      repoId: m.repoId,
      iid: m.iid,
      onBase,
      bumped: null,
      version: null,
      built: null,
    };
    out.set(`${m.repoId}#${m.iid}`, fact);
    const state = states.get(m.repoId);
    if (!onBase || m.mergedAt === null || !state) continue;

    const release = releaseOfMr(state, m.mergedAt);
    fact.bumped = release.bumped;
    fact.version = release.version;
    if (release.version !== null && anyBuild.has(m.repoId)) {
      fact.built = builtVersions.has(`${m.repoId}\u0000${stripV(release.version)}`);
    }
  }
  return out;
}
