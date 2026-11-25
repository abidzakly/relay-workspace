import { Play, Smartphone } from 'lucide-react';
import { Link } from 'react-router';
import { useWorkspaces } from '@/lib/cockpitApi';
import { canRunRepo, testBenchPath } from '@/lib/runBranchApi';
import { cn } from '@/lib/utils';

const HEADER =
  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-3 text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.97]';

/**
 * "Run this branch": opens the Test Bench on `branch`, which checks it out on the Mac (fetching it when it is not local)
 * so the app can run on a test device. Hidden for external review projects; disabled without a local workspace.
 */
export function RunBranchButton({
  repo,
  branch,
  variant = 'header',
}: {
  repo: string;
  branch: string;
  /** `header`: labelled button for page headers. `icon`: the review toolbar's square icon button. */
  variant?: 'header' | 'icon';
}) {
  const workspaces = useWorkspaces();
  if (!canRunRepo(repo) || !branch) return null;
  const has = (workspaces.data ?? []).some((w) => w.repoId === repo);
  const ready = workspaces.isPending || has;
  const title = ready
    ? `Run the app from ${branch} on a test device`
    : 'No local workspace holds this repo — add one under Settings → Workspaces';
  const icon = (
    <span className="relative inline-flex" aria-hidden>
      <Smartphone className="size-4" />
      <Play className="absolute -right-1 -bottom-0.5 size-2.5 fill-current" />
    </span>
  );
  if (!ready) {
    return (
      <Link
        to="/settings#workspaces"
        title={title}
        aria-label={title}
        className={cn(variant === 'icon' ? 'rv-icon-btn' : HEADER, 'opacity-60')}
      >
        {icon}
        {variant === 'header' && <span className="hidden sm:inline">Run this branch</span>}
      </Link>
    );
  }
  return (
    <Link
      to={testBenchPath(repo, branch, { run: true })}
      title={title}
      aria-label={variant === 'icon' ? title : undefined}
      className={variant === 'icon' ? 'rv-icon-btn' : HEADER}
    >
      {icon}
      {variant === 'header' && <span className="hidden sm:inline">Run this branch</span>}
    </Link>
  );
}
