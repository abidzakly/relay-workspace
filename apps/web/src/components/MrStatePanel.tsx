import { CircleCheck, CircleSlash, FilePen, GitPullRequest, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { MrDetail, MrDraftEvent, MrStateChangeResult } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useMrDraft, useMrStateChange } from '@/lib/mrApi';
import { useSettings } from '@/lib/settingsApi';

function ResultLine({ r }: { r: MrStateChangeResult }) {
  const verb = r.event === 'close' ? 'close' : 'reopen';
  if (r.dryRun) {
    return (
      <Alert variant="warning">
        <AlertTitle>Dry-run: {verb} simulated</AlertTitle>
        <AlertDescription>Nothing was sent to GitLab. Audit entry #{r.auditId}.</AlertDescription>
      </Alert>
    );
  }
  if (!r.applied) {
    return (
      <Alert variant="warning">
        <AlertTitle>GitLab did not {verb} this MR</AlertTitle>
        <AlertDescription>
          GitLab accepted the request, but the MR kept its state.
          {r.event === 'reopen' &&
            ' Its source branch may be gone, or another open MR may use it.'}{' '}
          Audit entry #{r.auditId}.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <AlertTitle>{r.event === 'close' ? 'MR closed' : 'MR reopened'}</AlertTitle>
      <AlertDescription>Audit entry #{r.auditId}.</AlertDescription>
    </Alert>
  );
}

/** "Set as draft" / "Mark as ready" for an open MR. Toggles GitLab's `Draft:` title prefix; the server re-reads first. */
function DraftControl({ d, dryRun }: { d: MrDetail; dryRun: boolean }) {
  const { mr } = d;
  const change = useMrDraft(mr.repoId, mr.iid);
  const [open, setOpen] = useState(false);
  const event: MrDraftEvent = mr.draft ? 'ready' : 'draft';
  const label = event === 'draft' ? 'Set as draft' : 'Mark as ready for review';
  const Icon = event === 'draft' ? FilePen : CircleCheck;
  const pending = change.isPending;
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            change.reset();
            setOpen(true);
          }}
        >
          {pending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Icon className="size-4" />
          )}
          {label}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {label}: !{mr.iid}?
            </DialogTitle>
            <DialogDescription>{mr.title}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {event === 'draft'
              ? 'The MR gets the "Draft:" title prefix. A draft cannot be merged until it is marked ready.'
              : 'The "Draft:" prefix is removed from the title, so the MR can be reviewed and merged.'}{' '}
            This is written to the audit log.
          </p>
          {dryRun && (
            <Alert variant="warning">
              <AlertTitle>Dry-run is ON</AlertTitle>
              <AlertDescription>The state is read live, but nothing will change.</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={pending}
              onClick={() => change.mutate(event, { onSettled: () => setOpen(false) })}
            >
              {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {dryRun ? 'Simulate' : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {change.isSuccess && (
        <Alert
          className="basis-full"
          variant={change.data.dryRun || !change.data.applied ? 'warning' : 'success'}
        >
          <AlertTitle>
            {change.data.dryRun
              ? 'Dry-run: nothing was sent to GitLab'
              : change.data.applied
                ? change.data.event === 'draft'
                  ? 'MR set as draft'
                  : 'MR marked ready'
                : 'GitLab did not change the draft state'}
          </AlertTitle>
          <AlertDescription>Audit entry #{change.data.auditId}.</AlertDescription>
        </Alert>
      )}
      {change.isError && (
        <Alert className="basis-full" variant="destructive">
          <AlertTitle>Could not change the draft state</AlertTitle>
          <AlertDescription>{describeError(change.error)}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/**
 * Close / Reopen, like GitLab's own buttons. Open MRs can be closed and closed MRs reopened; a merged MR has neither.
 * Which button shows is cosmetic: the server re-reads the state at click time.
 */
export function MrStatePanel({ d }: { d: MrDetail }) {
  const { mr } = d;
  const state = d.approvals.gate.state;
  const change = useMrStateChange(mr.repoId, mr.iid);
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const event = state === 'opened' ? 'close' : state === 'closed' ? 'reopen' : null;
  const pending = change.isPending;
  const dryRun = settings.data?.dryRun === true;
  const result = change.isSuccess ? <ResultLine r={change.data} /> : null;
  if (!event) return result;

  const Icon = event === 'close' ? CircleSlash : GitPullRequest;
  const label = event === 'close' ? 'Close MR' : 'Reopen MR';
  return (
    <section
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t pt-4"
      aria-label={label}
    >
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              change.reset();
              setOpen(true);
            }}
          >
            {pending ? (
              <Loader2 className="size-4 motion-safe:animate-spin" />
            ) : (
              <Icon className="size-4" />
            )}
            {label}
          </Button>
          {state === 'opened' && <DraftControl d={d} dryRun={dryRun} />}
        </div>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {event === 'close' ? 'Close' : 'Reopen'} !{mr.iid}?
            </DialogTitle>
            <DialogDescription>
              {mr.title}
              <br />
              <span className="font-mono text-xs">
                {mr.sourceBranch} → {mr.targetBranch}
              </span>
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {event === 'close'
              ? 'The MR closes without merging. Its source branch and commits stay, and you can reopen it later.'
              : 'The MR opens again. GitLab refuses if its source branch is gone or another open MR uses it.'}{' '}
            This is written to the audit log.
          </p>
          {dryRun && (
            <Alert variant="warning">
              <AlertTitle>Dry-run is ON</AlertTitle>
              <AlertDescription>The state is read live, but nothing will change.</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={event === 'close' ? 'destructive' : 'default'}
              disabled={pending}
              onClick={() => change.mutate(event, { onSettled: () => setOpen(false) })}
            >
              {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {dryRun ? `Simulate ${event}` : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {result}
      {change.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not {event} this MR</AlertTitle>
          <AlertDescription>{describeError(change.error)}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
