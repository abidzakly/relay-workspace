import { useState } from 'react';
import { Ban, Check, Undo2 } from 'lucide-react';
import type { ReviewApproval } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { useReviewApprove } from '@/lib/reviewApi';
import { cn } from '@/lib/utils';

const HOW: Record<ReviewApproval['mode'], string> = {
  approvals_api: 'GitLab records your approval on the MR.',
  award_emoji: 'Your approval is a thumbs-up on the MR, the way this repo counts approvals.',
  note_keyword:
    'Your approval is an “Approved” comment on the MR. It cannot be taken back from here.',
};

/**
 * The review decision (Code Reviewer header). Offered only when the server says it is allowed (`approval`), with the
 * server's reason when it is not; always confirmed in a dialog, and "Approved" shows only after the server answered.
 * GitLab's REST API has no "request changes", so that decision stays a comment (a reported gap, not a fake button).
 */
export function ApproveControl({
  repo,
  iid,
  title,
  approval,
  summary,
}: {
  repo: string;
  iid: number;
  title: string;
  approval: ReviewApproval;
  /** What is being signed off, shown before the decision. */
  summary: { files: number; additions: number; deletions: number; openThreads: number };
}) {
  const [open, setOpen] = useState(false);
  const m = useReviewApprove(repo, iid);
  const revoking = approval.approvedByMe;
  const allowed = revoking ? approval.canRevoke : approval.canApprove;

  if (!allowed) {
    if (approval.approvedByMe)
      return (
        <span
          className="rv-chip inline-flex h-9 items-center gap-1 px-2.5 text-success"
          title="You approved this MR"
        >
          <Check className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">Approved</span>
          <span className="sr-only sm:hidden">You approved this MR</span>
        </span>
      );
    // Say why, instead of a button that silently is not there (permission-aware, not hidden).
    if (!approval.reason) return null;
    return (
      <span
        className="rv-chip inline-flex h-9 max-w-[16rem] items-center gap-1.5 px-2.5 text-muted-foreground"
        title={approval.reason}
      >
        <Ban className="size-3.5 shrink-0" aria-hidden />
        <span className="hidden truncate sm:inline">Can't approve</span>
        <span className="sr-only">Approving is off: {approval.reason}</span>
      </span>
    );
  }

  const send = () =>
    m.mutate(
      { approved: !revoking },
      {
        onSuccess: () => setOpen(false),
      },
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !m.isPending && setOpen(o)}>
      <button
        type="button"
        onClick={() => {
          m.reset();
          setOpen(true);
        }}
        className={cn(
          'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-[background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97]',
          revoking
            ? 'border bg-card text-success hover:bg-accent'
            : 'bg-primary text-primary-foreground shadow-rest hover:bg-primary/90',
        )}
        aria-label={revoking ? 'Approved. Revoke your approval' : 'Approve this MR'}
        title={revoking ? 'You approved this MR. Click to revoke' : 'Approve this MR'}
      >
        <Check className="size-4" aria-hidden />
        <span className="hidden sm:inline">{revoking ? 'Approved' : 'Approve'}</span>
      </button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{revoking ? 'Revoke your approval?' : 'Approve this MR?'}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">!{iid}</span> {title}
          </DialogDescription>
        </DialogHeader>
        {!revoking && (
          <dl className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 p-3 text-center text-xs">
            <div>
              <dt className="text-muted-foreground">Files</dt>
              <dd className="text-base font-semibold tabular-nums">{summary.files}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Lines</dt>
              <dd className="font-mono text-sm font-semibold tabular-nums">
                <span className="text-success">+{summary.additions}</span>{' '}
                <span className="text-destructive">−{summary.deletions}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Open threads</dt>
              <dd
                className={cn(
                  'text-base font-semibold tabular-nums',
                  summary.openThreads > 0 && 'text-warning',
                )}
              >
                {summary.openThreads}
              </dd>
            </div>
          </dl>
        )}
        {!revoking && summary.openThreads > 0 && (
          <p className="text-sm text-warning">
            {summary.openThreads} thread{summary.openThreads === 1 ? ' is' : 's are'} still open.
            Approving does not resolve {summary.openThreads === 1 ? 'it' : 'them'}.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {revoking ? 'Your approval is removed from the MR.' : HOW[approval.mode]} The write is
          audited (Audit tab) and honours dry-run.
        </p>
        {m.error && (
          <p role="alert" className="text-sm text-destructive">
            {describeError(m.error)}
          </p>
        )}
        {m.isSuccess && m.data.dryRun && (
          <p role="status" className="text-sm text-muted-foreground">
            Dry-run: nothing was sent to GitLab.
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={m.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={send}
            disabled={m.isPending}
            variant={revoking ? 'destructive' : 'default'}
          >
            {revoking ? <Undo2 aria-hidden /> : <Check aria-hidden />}
            {m.isPending ? 'Sending…' : revoking ? 'Revoke approval' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
