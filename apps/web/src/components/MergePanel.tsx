import { CircleCheck, GitMerge, Loader2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { MergeGate, MrDetail, MrMergeResult } from '@relay/shared';
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
import { Badge } from '@/components/Badge';
import { ApiError, describeError } from '@/lib/api';
import {
  refusedGate,
  useAllMerged,
  useDisableSquash,
  useMerge,
  wantsMergeDialog,
} from '@/lib/mrApi';
import { stackMembersOf } from '@/lib/mrStackProgress';
import { emit } from '@/lib/reward/engine';
import { useSettings } from '@/lib/settingsApi';

/** GitLab merge statuses that mean "GitLab itself is fine with merging" (anything else is shown as a hint). */
const GITLAB_OK_STATUSES = new Set(['mergeable', 'can_be_merged']);

function Reasons({ gate }: { gate: MergeGate }) {
  return (
    <ul className="grid min-w-0 list-disc gap-1 pl-4 text-sm [overflow-wrap:anywhere]">
      {gate.reasons.map((r) => (
        <li key={r.code}>
          {r.message}{' '}
          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
            ({r.code})
          </span>
        </li>
      ))}
    </ul>
  );
}

function ResultLine({ r }: { r: MrMergeResult }) {
  if (r.dryRun) {
    return (
      <Alert variant="warning">
        <AlertTitle>Dry-run: merge simulated</AlertTitle>
        <AlertDescription>
          The live gate passed; nothing was sent to GitLab. Audit entry #{r.auditId}.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <AlertTitle className="flex items-center gap-1.5">
        {r.merged && <CircleCheck aria-hidden className="size-4" />}
        {r.merged ? 'Merged' : 'Merge accepted by GitLab'}
      </AlertTitle>
      <AlertDescription>
        {r.merged
          ? r.mergeCommitSha
            ? `Merge commit ${r.mergeCommitSha.slice(0, 8)}.`
            : 'GitLab reports the MR as merged.'
          : `GitLab answered with state "${r.state ?? 'unknown'}"; it may still be finishing. The page refreshes when it is done.`}{' '}
        Audit entry #{r.auditId} (a merge cannot be undone from here).
      </AlertDescription>
    </Alert>
  );
}

function ErrorLine({ error, pageSaidYes }: { error: unknown; pageSaidYes: boolean }) {
  const live = refusedGate(error);
  if (live) {
    return (
      <Alert variant="destructive">
        <AlertTitle>
          {pageSaidYes
            ? 'Not merged: this page was out of date, GitLab now says no'
            : 'Not merged: the live check refused'}
        </AlertTitle>
        <AlertDescription>
          <Reasons gate={live} />
          <p className="mt-1 text-xs">Nothing was sent to GitLab. The page has been refreshed.</p>
        </AlertDescription>
      </Alert>
    );
  }
  const code = error instanceof ApiError ? error.code : null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Not merged{code ? ` (${code})` : ''}</AlertTitle>
      <AlertDescription>{describeError(error)}</AlertDescription>
    </Alert>
  );
}

/** "Turn off squash": only for an MR-level flag. A project forcing squash must be changed in GitLab settings. */
function SquashOff({
  repo,
  iid,
  projectForces,
}: {
  repo: string;
  iid: number;
  projectForces: boolean;
}) {
  const m = useDisableSquash(repo, iid);
  if (projectForces) {
    return (
      <p className="text-xs text-muted-foreground">
        The project's squash option is “always”: change it in GitLab → Settings → Merge requests →
        Squash commits when merging, then reload.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={m.isPending} onClick={() => m.mutate()}>
        {m.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
        Turn off squash
      </Button>
      {m.isSuccess && (
        <span className="text-xs text-muted-foreground">
          {m.data.dryRun ? 'Dry-run: simulated.' : 'Squash turned off.'} Audit #{m.data.auditId}
        </span>
      )}
      {m.isError && <span className="text-xs text-destructive">{describeError(m.error)}</span>}
    </div>
  );
}

/**
 * The rewards of a merge pressed here, only once the server confirms it (design system: Truth rules). "Accepted"
 * earns nothing until a refetch shows the MR merged. A stack's event needs a fresh read of every remembered member.
 */
function useMergeReward(d: MrDetail, result: MrMergeResult | undefined) {
  const { repoId, iid, targetBranch } = d.mr;
  const merged = result?.merged === true || d.approvals.gate.state === 'merged';
  const rewarded = useRef(false);
  const allMerged = useAllMerged();
  useEffect(() => {
    if (!result || result.dryRun || !merged || rewarded.current) return;
    rewarded.current = true;
    emit({
      level: 'burst',
      key: `merge:${repoId}:${iid}`,
      persist: true,
      title: 'Merged',
      detail: `!${iid} into ${targetBranch}`,
    });
    const members = stackMembersOf(repoId, iid);
    if (!members || members.length < 2) return;
    void allMerged(repoId, members).then((all) => {
      if (!all) return;
      emit({
        level: 'event',
        key: `stack:${repoId}:${members.join(',')}`,
        persist: true,
        title: 'Stack fully merged',
        detail: `${members.length} MRs, parent first`,
      });
    });
  }, [result, merged, repoId, iid, targetBranch, allMerged]);
}

/**
 * Merge button. The enabled/disabled state comes from `d.approvals.gate`, the
 * shared rule evaluated over the drawer's data. It is COSMETIC: the click goes to the server, which
 * re-fetches the MR + approvals live and decides (409 `merge_blocked` with its own reasons otherwise).
 * Hidden for merged / closed MRs; disabled with the reasons for everything else that fails the rule.
 */
export function MergePanel({ d }: { d: MrDetail }) {
  const { mr } = d;
  const gate = d.approvals.gate;
  const merge = useMerge(mr.repoId, mr.iid);
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  // What the page showed when the user clicked (the gate object is replaced by the refetch afterwards).
  const [clickedAllowed, setClickedAllowed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useMergeReward(d, merge.data);

  // The palette's "Merge…": opens this dialog once, and only if the gate allows. Otherwise the reasons below show.
  useEffect(() => {
    if (!wantsMergeDialog(location.state)) return;
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    if (gate.allowed) setOpen(true);
  }, [location.state]);

  if (gate.state === 'merged' || gate.state === 'closed') {
    // A just-finished merge keeps its result visible after the refetch flips the state.
    return merge.isSuccess ? <ResultLine r={merge.data} /> : null;
  }

  const dryRun = settings.data?.dryRun === true;
  const pending = merge.isPending;
  const disabled = !gate.allowed || pending;
  const why = gate.allowed ? undefined : gate.reasons.map((r) => r.message).join(' ');
  const gitlabHint =
    gate.allowed && gate.gitlabMergeStatus && !GITLAB_OK_STATUSES.has(gate.gitlabMergeStatus)
      ? gate.gitlabMergeStatus
      : null;

  const confirm = () => {
    setClickedAllowed(gate.allowed);
    merge.mutate(undefined, { onSettled: () => setOpen(false) });
  };

  return (
    <section
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t pt-4"
      aria-label="Merge"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
          {/* span keeps the tooltip working on a disabled button */}
          <span title={why}>
            <Button
              disabled={disabled}
              onClick={() => {
                merge.reset();
                setOpen(true);
              }}
            >
              {pending ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <GitMerge className="size-4" />
              )}
              {pending ? 'Merging…' : 'Merge'}
            </Button>
          </span>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Merge !{mr.iid} into {mr.targetBranch}?
              </DialogTitle>
              <DialogDescription>
                {mr.title}
                <br />
                <span className="font-mono text-xs">
                  {mr.sourceBranch} → {mr.targetBranch}
                </span>
              </DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1 text-sm">
              <li>
                Approved by:{' '}
                {gate.approvingReviewers.length > 0
                  ? gate.approvingReviewers.map((r) => `@${r}`).join(', ')
                  : '—'}{' '}
                <span className="text-muted-foreground">({gate.approvalMode})</span>
              </li>
              <li>
                Squash: <strong>off</strong> · source branch: <strong>deleted</strong> (always sent
                explicitly; project defaults are not used).
              </li>
              {gate.commitCount !== null && (
                <li>
                  {gate.commitCount} commit{gate.commitCount === 1 ? '' : 's'} into{' '}
                  {mr.targetBranch}.
                </li>
              )}
              <li className="text-muted-foreground">
                The server re-checks GitLab live before merging and refuses if anything changed. The
                merge is written to the audit log and cannot be undone here.
              </li>
            </ul>
            {dryRun && (
              <Alert variant="warning">
                <AlertTitle>Dry-run is ON</AlertTitle>
                <AlertDescription>
                  The gate is checked live, but nothing will be merged.
                </AlertDescription>
              </Alert>
            )}
            {gitlabHint && (
              <p className="text-xs text-muted-foreground">
                GitLab currently reports “{gitlabHint}”: GitLab may still refuse by its own rules.
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button onClick={confirm} disabled={pending}>
                {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
                {pending ? 'Checking GitLab and merging…' : dryRun ? 'Simulate merge' : 'Merge'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {gate.allowed ? (
          <Badge variant="success">gate met</Badge>
        ) : (
          <Badge variant="secondary">gate not met</Badge>
        )}
        {gate.source === 'cache' && (
          <span className="text-xs text-muted-foreground">
            based on cached data; the server checks GitLab live on click
          </span>
        )}
      </div>
      {!gate.allowed && <Reasons gate={gate} />}
      {gate.warnings.length > 0 && (
        <ul className="grid gap-1 text-sm text-warning">
          {gate.warnings.map((w) => (
            <li key={w}>
              <TriangleAlert aria-hidden className="mr-1 inline size-3.5" />
              {w}
            </li>
          ))}
        </ul>
      )}
      {gate.reasons.some((r) => r.code === 'squash_enabled') && (
        <SquashOff
          repo={mr.repoId}
          iid={mr.iid}
          projectForces={gate.reasons.some(
            (r) => r.code === 'squash_enabled' && r.message.includes('project'),
          )}
        />
      )}
      {gitlabHint && (
        <p className="text-xs text-muted-foreground">
          GitLab reports “{gitlabHint}”: the dashboard gate is met, but GitLab may still refuse.
        </p>
      )}
      {merge.isSuccess && <ResultLine r={merge.data} />}
      {merge.isError && <ErrorLine error={merge.error} pageSaidYes={clickedAllowed} />}
    </section>
  );
}
