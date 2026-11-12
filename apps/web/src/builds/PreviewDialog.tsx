import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { usePreviewCandidates } from '@/lib/buildApi';

/**
 * QA preview: the open MRs, in the order they will be merged. A calm zone: it says plainly what is local and what
 * is not. Drafts start unchecked. Nothing is pushed, tagged or moved in Notion.
 */
export function PreviewDialog({
  repo,
  repoName,
  dryRun,
  onBuild,
  onClose,
}: {
  repo: string;
  repoName: string;
  dryRun: boolean;
  onBuild: (mrIids: number[]) => void;
  onClose: () => void;
}) {
  const candidates = usePreviewCandidates(repo, true);
  // Only the user's changes are kept: an MR not listed here follows its default (drafts off, the rest on).
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const items = candidates.data?.items ?? [];
  const isOn = (iid: number, draft: boolean) => overrides[iid] ?? !draft;
  const chosen = items.filter((m) => isOn(m.iid, m.draft)).map((m) => m.iid);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>QA preview of {repoName}</DialogTitle>
          <DialogDescription>
            Merges the checked MRs into a local copy of{' '}
            {candidates.data?.baseBranch ?? 'the base branch'} in this order, raises the staging
            version locally and builds the APK. Nothing is pushed, tagged or changed in Notion. The
            version is the same one the next real release will get, so do not mix the two up. A
            conflict stops the build.
          </DialogDescription>
        </DialogHeader>
        {candidates.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 motion-safe:animate-spin" /> Loading…
          </p>
        )}
        {candidates.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load the open MRs</AlertTitle>
            <AlertDescription>{describeError(candidates.error)}</AlertDescription>
          </Alert>
        )}
        {candidates.isSuccess && items.length === 0 && (
          <p className="text-sm text-muted-foreground">This repo has no open MRs to merge.</p>
        )}
        {items.length > 0 && (
          <ol className="grid max-h-80 gap-1 overflow-y-auto text-sm">
            {items.map((m) => (
              <li key={m.iid}>
                <label className="flex items-start gap-2 py-1">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={isOn(m.iid, m.draft)}
                    onChange={(e) => setOverrides({ ...overrides, [m.iid]: e.target.checked })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-muted-foreground">
                      {m.order}. !{m.iid}
                    </span>{' '}
                    <span className="[overflow-wrap:anywhere]">{m.title}</span>
                    <span className="block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {m.branch}
                      {m.parentBranch && ` (on top of ${m.parentBranch})`}
                    </span>
                  </span>
                  {m.draft && <Badge variant="secondary">draft</Badge>}
                  {m.hasConflicts && <Badge variant="warning">conflicts</Badge>}
                </label>
              </li>
            ))}
          </ol>
        )}
        {dryRun && (
          <p className="text-sm text-muted-foreground">
            Dry-run is ON: the merges and the build are only logged.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={chosen.length === 0} onClick={() => onBuild(chosen)}>
            Build preview ({chosen.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
