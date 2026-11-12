import { lazy, Suspense } from 'react';
import {
  ArrowRight,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  type LucideIcon,
  Minus,
  Pause,
  Play,
  X,
} from 'lucide-react';
import type { JobStatus, JobStep, JobStepStatus, ReleaseJobView } from '@relay/shared';
import { SigningUpload } from '@/builds/SigningUpload';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, type ButtonProps } from '@/components/ui/button';
import { ApiError, describeError } from '@/lib/api';
import { useJobAction, type JobAction } from '@/lib/releaseApi';
import { safeHref } from '@/lib/utils';
import {
  canCancel,
  canResume,
  expectedTag,
  isPlaceholder,
  nextStep,
  stateText,
  type StrandedMerge,
} from './model';
import { FlavorChoice, NotionOffer, QaShare } from './PipelineActions';
import { PtyNotice } from './PtyNotice';

const PtyTerminal = lazy(() => import('./PtyTerminal'));
const VersionMrPreview = lazy(() => import('./VersionMrPreview'));

type Variant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive';

const JOB_STATUS: Record<JobStatus, { variant: Variant; label: string }> = {
  queued: { variant: 'secondary', label: 'queued' },
  running: { variant: 'default', label: 'running' },
  paused: { variant: 'warning', label: 'waiting for you' },
  succeeded: { variant: 'success', label: 'succeeded' },
  failed: { variant: 'destructive', label: 'failed' },
  cancelled: { variant: 'secondary', label: 'cancelled' },
};

const STEP_STATUS: Record<JobStepStatus, { variant: Variant; mark: LucideIcon }> = {
  pending: { variant: 'outline', mark: Circle },
  running: { variant: 'default', mark: Play },
  paused: { variant: 'warning', mark: Pause },
  succeeded: { variant: 'success', mark: Check },
  failed: { variant: 'destructive', mark: X },
  skipped: { variant: 'secondary', mark: Minus },
};

function ActionButton({
  repo,
  jobId,
  action,
  label,
  disabled,
  ...props
}: {
  repo: string;
  jobId: string;
  action: JobAction;
  label: string;
} & Omit<ButtonProps, 'onClick' | 'children'>) {
  const m = useJobAction(repo, jobId, action);
  return (
    <div className="grid gap-2">
      <Button size="sm" disabled={disabled || m.isPending} onClick={() => m.mutate()} {...props}>
        {m.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
        {label}
      </Button>
      {m.isError && (
        <Alert variant="destructive">
          <AlertTitle>Refused{m.error instanceof ApiError ? ` (${m.error.code})` : ''}</AlertTitle>
          <AlertDescription>{describeError(m.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function StepRow({ step }: { step: JobStep }) {
  const s = STEP_STATUS[step.status];
  const placeholder = isPlaceholder(step);
  const row = (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={s.variant}>
        <s.mark aria-hidden />
        {step.status}
      </Badge>
      <span className="font-mono text-xs">{step.name}</span>
      {placeholder && <span className="text-xs text-muted-foreground">nothing ran yet</span>}
      {step.finishedAt !== null && (
        <TimeAgo at={step.finishedAt} className="text-xs text-muted-foreground" />
      )}
    </span>
  );
  const error =
    step.error !== null ? (
      <p className="mt-1 text-xs break-words text-destructive">{step.error}</p>
    ) : null;
  if (step.log === '') {
    return (
      <li className="py-1">
        {row}
        {error}
      </li>
    );
  }
  return (
    <li className="py-1">
      <details
        open={step.status === 'running' || step.status === 'paused' || step.status === 'failed'}
      >
        <summary className="cursor-pointer list-none">{row}</summary>
        {error}
        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap">
          {step.log}
        </pre>
      </details>
    </li>
  );
}

/** What to do with a merged release that has no tag and that the engine refuses to resume. */
function StrandedAlert({
  kind,
  view,
  tagFormat,
  baseBranch,
  mrHref,
}: {
  kind: Exclude<StrandedMerge, null>;
  view: ReleaseJobView;
  tagFormat: string;
  baseBranch: string;
  mrHref: string | undefined;
}) {
  const { job } = view;
  const tag = expectedTag(view, tagFormat) ?? `<the tag for ${job.version ?? 'this version'}>`;
  const mr = job.mrIid !== null ? `MR !${job.mrIid}` : 'the version MR';
  return (
    <Alert variant={kind === 'merged' ? 'destructive' : 'warning'}>
      <AlertTitle>
        {kind === 'merged'
          ? 'Merged, but this cancelled release was never tagged'
          : 'This release was cancelled while its merge was unconfirmed'}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <p>
          {kind === 'merged' ? (
            <>
              GitLab data shows {mr} on {baseBranch}. The dashboard cannot finish this job: a
              cancelled job only resumes after a merge it saw itself. It also cannot see whether
              someone has tagged by hand since, so ignore this if you already did.
            </>
          ) : (
            <>
              GitLab may have merged {mr}, but nothing has confirmed that.{' '}
              {mrHref ? (
                <a href={mrHref} target="_blank" rel="noreferrer" className="underline">
                  Check the MR
                </a>
              ) : (
                'Check the MR in GitLab'
              )}
              . If it is still open, start the release again: the open MR is picked up. If it is
              merged, recover by hand as below.
            </>
          )}
        </p>
        <p>In your own clone, tag the commit on {baseBranch} that has this version in pubspec:</p>
        <pre className="overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs text-foreground">
          {`git fetch origin\ngit tag ${tag} <merge-commit>\ngit push origin refs/tags/${tag}`}
        </pre>
        <p>
          Do this before starting another release: a new one bumps from the merged version, and that
          version would stay untagged. The steps after the tag did not run for this release either.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** The repo's newest release job: MR link, Merge now, cancel and resume, step list with logs. */
export function JobPanel({
  repo,
  view,
  stranded,
  tagFormat,
  baseBranch,
  dryRunNow,
}: {
  repo: string;
  view: ReleaseJobView;
  stranded: StrandedMerge;
  tagFormat: string;
  baseBranch: string;
  dryRunNow: boolean;
}) {
  const { job, steps, cancelling } = view;
  const status = JOB_STATUS[job.status];
  const mrUrl = stateText(view, 'mrUrl');
  const mrHref = job.mrIid !== null ? safeHref(mrUrl) : undefined;
  const pty = job.engine === 'pty';
  const paused = !pty && job.status === 'paused' && job.currentStep === 'AWAIT_REVIEW';
  const merging = job.status === 'running' && job.currentStep === 'MERGE';
  const next = nextStep(view, cancelling);
  const rehearsed = job.dryRun && job.status === 'succeeded';

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Latest release</span>
        <Badge variant={rehearsed ? 'secondary' : status.variant}>
          {rehearsed ? 'Rehearsal finished' : status.label}
        </Badge>
        {cancelling && (
          <Badge variant="warning">
            <Loader2 className="size-3 motion-safe:animate-spin" />
            cancelling
          </Badge>
        )}
        {job.dryRun && <Badge variant="warning">dry-run</Badge>}
        <Badge variant="outline">{job.mode}</Badge>
        {pty && <Badge variant="outline">PTY</Badge>}
        {job.version && <span className="font-mono text-xs">{job.version}</span>}
        {job.prevVersion && (
          <span className="text-xs text-muted-foreground">from {job.prevVersion}</span>
        )}
        <TimeAgo at={job.updatedAt} className="text-xs text-muted-foreground" />
      </div>

      {next && (
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <ArrowRight aria-hidden className="size-4 shrink-0 text-primary-ink" />
          Next: {next}
        </p>
      )}

      {pty && <PtyNotice />}

      {job.dryRun !== dryRunNow && job.status !== 'succeeded' && job.status !== 'cancelled' && (
        <Alert variant="warning">
          <AlertDescription>
            {job.dryRun
              ? 'Dry-run is off now, but this job started in dry-run and stays simulated.'
              : 'Dry-run is on now, but this job started live. It stops at its next write until dry-run is off.'}
          </AlertDescription>
        </Alert>
      )}

      {cancelling && (
        <Alert variant="warning">
          <AlertTitle>Cancelling</AlertTitle>
          <AlertDescription>
            {pty
              ? 'Stopping vu and everything it started. A merge already sent to GitLab is not taken back.'
              : 'Waiting for the current step to stop. A merge already sent to GitLab is waited for, not taken back.'}
          </AlertDescription>
        </Alert>
      )}

      {job.error && (
        <Alert variant={job.status === 'failed' ? 'destructive' : 'warning'}>
          <AlertTitle>{job.status === 'failed' ? 'Failed' : 'Note'}</AlertTitle>
          <AlertDescription className="break-words">{job.error}</AlertDescription>
        </Alert>
      )}

      {stranded && (
        <StrandedAlert
          kind={stranded}
          view={view}
          tagFormat={tagFormat}
          baseBranch={baseBranch}
          mrHref={mrHref}
        />
      )}

      <div className="text-sm">
        {mrHref ? (
          <a
            href={mrHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary-ink underline"
          >
            Version MR !{job.mrIid} <ExternalLink className="size-3" />
          </a>
        ) : job.mrIid !== null ? (
          <span>Version MR !{job.mrIid}</span>
        ) : job.state.mrSimulated === true ? (
          <span className="text-muted-foreground">
            Dry-run: no MR exists, it was only simulated.
          </span>
        ) : null}
      </div>

      {merging && !cancelling && (
        <p className="text-xs text-muted-foreground">
          A cancel now does not stop a merge already sent. If GitLab does not answer in time, the
          release can end up cancelled with its outcome unknown.
        </p>
      )}

      {view.ptyPrompt?.kind === 'enter' && (
        <p className="text-sm">
          vu is waiting at its review prompt. Review the MR (its link is in the output below).
          Pressing Enter lets vu merge, tag and build.
        </p>
      )}

      {view.ptyPrompt?.kind === 'other' && (
        <Alert variant="warning">
          <AlertTitle>vu may be asking for something</AlertTitle>
          <AlertDescription className="grid gap-1">
            <p className="font-mono text-xs break-words">{view.ptyPrompt.text}</p>
            <p>
              The dashboard does not answer this, and tokens must not go through it. If vu is stuck,
              cancel, fix the cause (usually the repo&apos;s GitLab token, or a missing reauthor
              profile) and start again.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {paused && job.mrIid !== null && (
        <Suspense fallback={<p className="text-xs text-muted-foreground">Loading the MR…</p>}>
          <VersionMrPreview key={`${repo}:${job.mrIid}`} repo={repo} iid={job.mrIid} />
        </Suspense>
      )}

      {paused && (
        <p className="text-xs text-muted-foreground">
          {job.dryRun
            ? 'Merge now simulates the rest: nothing is merged, built, uploaded or written.'
            : job.mode === 'staging'
              ? 'Merge now merges and tags, builds the APK and uploads it to Drive, then moves Complete cards to Ready to Test. Send to QA waits for your own click.'
              : 'Merge now merges and tags, builds, then moves Complete cards to Ready to Test. Nothing is uploaded or shared.'}
        </p>
      )}

      {!pty && <QaShare view={view} dryRunNow={dryRunNow} />}
      {!pty && <NotionOffer view={view} dryRunNow={dryRunNow} />}
      {!pty && !cancelling && <FlavorChoice repo={repo} view={view} />}
      {job.status === 'failed' && !cancelling && (
        <SigningUpload
          repo={repo}
          error={job.error}
          next={pty ? 'Start the release again.' : 'Press Resume.'}
        />
      )}

      <div className="flex flex-wrap items-start gap-2">
        {view.ptyPrompt?.kind === 'enter' && !cancelling && (
          <ActionButton repo={repo} jobId={job.id} action="continue" label="Press Enter" />
        )}
        {paused && (
          <ActionButton
            repo={repo}
            jobId={job.id}
            action="continue"
            label={job.dryRun ? 'Merge now (simulated)' : 'Merge now'}
          />
        )}
        {canResume(view) && !cancelling && (
          <ActionButton
            repo={repo}
            jobId={job.id}
            action="resume"
            label="Resume"
            title="Runs the step that did not finish again"
          />
        )}
        {canCancel(view) && (
          <ActionButton
            repo={repo}
            jobId={job.id}
            action="cancel"
            label={cancelling ? 'Cancelling' : 'Cancel release'}
            variant="outline"
            disabled={cancelling}
            title={
              pty
                ? 'Stops vu. Undoes nothing: after Enter, the merge may already have happened'
                : 'Undoes nothing: an MR and branch stay, and the next start picks them up'
            }
          />
        )}
      </div>

      {pty ? (
        <Suspense fallback={<p className="text-xs text-muted-foreground">Loading the terminal…</p>}>
          <PtyTerminal key={job.id} jobId={job.id} />
        </Suspense>
      ) : (
        <div>
          <p className="text-xs text-muted-foreground">
            Logs refresh when a step changes, so a long step shows its output when it ends.
          </p>
          <ol className="divide-y">
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
