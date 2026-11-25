import { isSafeBranchName } from '@relay/shared';
import { CockpitHostError } from './host';
import { refuseCheckedOutElsewhere } from './workflowOps';
import { git } from './workspaceFs';

/**
 * Deletes a local branch in a workspace on the Mac (Branches page). Never the checked-out branch, never one another
 * worktree holds. `git branch -d` keeps commits no other branch has; `force` (`-D`) drops them, after the user saw
 * how many.
 */
export async function wsDeleteBranch(
  cwd: string,
  branch: string,
  force: boolean,
): Promise<{ sha: string }> {
  if (!isSafeBranchName(branch))
    throw new CockpitHostError('validation', 'invalid branch name', 422);
  const sha = (
    await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowExit: [1] })
  ).trim();
  if (!sha) throw new CockpitHostError('not_local', `${branch} is not a local branch.`, 404);
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (current === branch) {
    throw new CockpitHostError(
      'branch_checked_out_here',
      `${branch} is checked out in this workspace: switch to another branch first.`,
      409,
    );
  }
  await refuseCheckedOutElsewhere(cwd, branch);
  if (!force) {
    // Commits only this branch has (not on any other local or remote branch): what `-d` protects.
    const only = (
      await git(cwd, [
        'rev-list',
        '--count',
        sha,
        '--not',
        // With --branches the pattern is the short name (no refs/heads/): every other local branch, all remotes.
        `--exclude=${branch}`,
        '--branches',
        '--remotes',
      ])
    ).trim();
    const n = Number(only) || 0;
    if (n > 0) {
      throw new CockpitHostError(
        'branch_unmerged',
        `${branch} has ${n} commit${n > 1 ? 's' : ''} no other branch has: deleting it loses ${n > 1 ? 'them' : 'it'}.`,
        409,
        { unique: n, sha },
      );
    }
  }
  // `-D` here: uniqueness was checked above (or force was asked), and `-d` would also demand the upstream be merged.
  await git(cwd, ['branch', '-D', branch]);
  return { sha };
}
