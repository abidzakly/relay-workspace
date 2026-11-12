import { extProjectId, type RepoConfig } from '@relay/shared';
import type { ConfigStore } from '../config/store';

/**
 * Reviews reach projects that are not configured repos (`~<projectId>`) with the personal reviewer token. The GitLab
 * services take a `RepoConfig`; this builds a minimal one for such a project so the review reads and the MR writes
 * (comment, reply, resolve, approve, upload) run unchanged. It is never stored and never listed: nothing that
 * iterates repos (sync, board, releases, builds) can see it.
 */
export function extRepoConfig(config: ConfigStore, repoId: string): RepoConfig | undefined {
  const projectId = extProjectId(repoId);
  if (projectId === null) return undefined;
  const token = config.getReviewerToken();
  if (!token) return undefined;
  return {
    id: repoId,
    name: projectPathOf(config, projectId) ?? `Project ${projectId}`,
    enabled: false,
    baseBranch: 'main',
    reviewers: [],
    // Reviews always approve through the approvals API: the reviewer's own GitLab approval.
    approvalMode: 'approvals_api',
    productDomains: [],
    requireVersionMrApproval: false,
    versionBranchPrefix: 'update-version/v',
    tagFormat: 'v{commitVersion}',
    cloneUrl: '/dev/null',
    partialClone: true,
    flutter: { useFvm: false, stagingFlavor: 'auto', appName: null, cleanAfterUpload: false },
    drive: {},
    qa: { template: '' },
    gitlab: { projectId, token },
  } as RepoConfig;
}

/** A configured repo, or the external project behind `~<id>` when a reviewer token is saved. */
export function repoOrExt(config: ConfigStore, repoId: string): RepoConfig | undefined {
  return config.getRepo(repoId) ?? extRepoConfig(config, repoId);
}

export const isExtRepo = (repoId: string): boolean => extProjectId(repoId) !== null;

const PATHS_STATE = 'reviews.projectPaths';

/** `group/project` names seen on the desk, so a review header shows a name instead of a number. */
export function projectPathOf(config: ConfigStore, projectId: number): string | undefined {
  return config.getState<Record<string, string>>(PATHS_STATE)?.[String(projectId)];
}

export function rememberProjectPaths(
  config: ConfigStore,
  paths: ReadonlyMap<number, string>,
): void {
  if (paths.size === 0) return;
  const known = config.getState<Record<string, string>>(PATHS_STATE) ?? {};
  let changed = false;
  for (const [id, path] of paths) {
    if (known[String(id)] !== path) {
      known[String(id)] = path;
      changed = true;
    }
  }
  if (changed) config.setState(PATHS_STATE, known);
}

const IDENTITY_STATE = 'reviews.identity';

export interface ReviewerIdentity {
  username: string;
  name: string | null;
  scopes: string[];
  expiresAt: string | null;
}

/** Who the reviewer token belongs to (read from GitLab when the token is saved). */
export function reviewerIdentity(config: ConfigStore): ReviewerIdentity | undefined {
  return config.getState<ReviewerIdentity>(IDENTITY_STATE);
}

export function setReviewerIdentity(config: ConfigStore, id: ReviewerIdentity | undefined): void {
  config.setState(IDENTITY_STATE, id);
}
