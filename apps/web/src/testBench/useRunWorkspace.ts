import { useWorkspaces, useWsStatuses } from '@/lib/cockpitApi';

/**
 * The workspace a branch runs in: of the repo's workspaces (worktrees included), the one that already has the branch
 * (git keeps a branch in one worktree only), else the repo workspace. Shared by the device and the web run strips.
 */
export function useRunWorkspace(repo: string, branch: string) {
  const workspaces = useWorkspaces();
  const candidates = (workspaces.data ?? []).filter((w) => w.repoId === repo);
  const statuses = useWsStatuses(candidates.map((w) => w.id));
  const onBranch = candidates.findIndex((_w, i) => statuses[i]?.data?.branch === branch);
  const wsIndex =
    onBranch >= 0
      ? onBranch
      : Math.max(
          0,
          candidates.findIndex((w) => w.kind === 'repo'),
        );
  const ws = candidates[wsIndex] ?? null;
  const status = statuses[wsIndex] ?? { data: undefined };
  const wrongBranch =
    status.data?.branch && status.data.branch !== branch ? status.data.branch : null;
  return { workspaces, ws, wrongBranch };
}
