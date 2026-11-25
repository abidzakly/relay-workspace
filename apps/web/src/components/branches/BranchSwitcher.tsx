import { GitBranch } from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatAgo } from '@relay/shared';
import { Dropdown } from '@/components/Dropdown';
import { describeError } from '@/lib/api';
import { useBranches } from '@/lib/branchesApi';
import { testBenchPath } from '@/lib/runBranchApi';

/**
 * Test Bench header: switch to another branch of the repo (local or remote) without going back. Picking one checks
 * it out on the Mac, through the same flow and alert dialog as "Run this branch".
 */
export function BranchSwitcher({ repo, branch }: { repo: string; branch: string }) {
  const navigate = useNavigate();
  const q = useBranches(repo);
  const now = Date.now();
  const rows = q.data?.rows ?? [];
  const options = rows.map((r) => ({
    value: r.name,
    label: r.name,
    hint: [
      r.mr ? `!${r.mr.iid}` : null,
      r.current ? 'checked out' : null,
      r.local && !r.remote ? 'local only' : !r.local && r.remote ? 'origin only' : null,
      r.committedAt ? formatAgo(now - r.committedAt) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  if (!options.some((o) => o.value === branch))
    options.unshift({ value: branch, label: branch, hint: '' });
  return (
    <div className="w-full sm:w-72">
      <Dropdown
        options={options}
        value={branch}
        onChange={(v) => {
          if (v !== branch) void navigate(testBenchPath(repo, v, { run: true }), { replace: true });
        }}
        icon={GitBranch}
        width="full"
        size="sm"
        align="right"
        searchable
        placeholder="Switch branch"
        footer={
          q.error
            ? describeError(q.error)
            : q.isPending
              ? 'Listing branches…'
              : q.data && !q.data.sources.remote.ok
                ? q.data.sources.remote.message
                : undefined
        }
      />
    </div>
  );
}
