import { GitPullRequestCreate, Inbox, Link2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { CardLinkDialog } from '@/components/cardLink/CardLinkDialog';
import { Button } from '@/components/ui/button';
import { useBranches } from '@/lib/branchesApi';
import { mrCreatePath } from '@/lib/mrCreateApi';
import './branches.css';

/**
 * Test Bench without a card: the app runs as is (device, mirror, logs). Linking a card brings back its AC checks;
 * Create MR stays one tap away for a branch without one.
 */
export function QuickRunBanner({ repo, branch }: { repo: string; branch: string }) {
  const [linking, setLinking] = useState(false);
  const row = useBranches(repo).data?.rows.find((r) => r.name === branch) ?? null;
  return (
    <div className="qr-banner" role="note">
      <Zap aria-hidden className="size-4 shrink-0 text-emphasis" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Quick run.</span>{' '}
        <span className="text-muted-foreground">
          No card for this branch, so there are no AC to check. Link a card to test it against its
          acceptance criteria.
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
          <Link2 className="size-4" /> Link card
        </Button>
        {row?.mr ? (
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/mrs/${encodeURIComponent(repo)}/${row.mr.iid}`}>
              <Inbox className="size-4" /> !{row.mr.iid}
            </Link>
          </Button>
        ) : (
          !row?.isBase && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={mrCreatePath(repo, branch)}>
                <GitPullRequestCreate className="size-4" /> Create MR
              </Link>
            </Button>
          )
        )}
      </div>
      {linking && <CardLinkDialog repo={repo} branch={branch} onClose={() => setLinking(false)} />}
    </div>
  );
}
