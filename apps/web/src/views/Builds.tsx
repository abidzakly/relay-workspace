import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import {
  FlavorDetectionSchema,
  type BuildMode,
  type BuildView,
  type FlavorDetection,
} from '@relay/shared';
import { BuildRow } from '@/builds/BuildRow';
import { FlavorDialog } from '@/builds/FlavorDialog';
import { PreviewDialog } from '@/builds/PreviewDialog';
import { LogViewer } from '@/builds/LogViewer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ApiError, describeError } from '@/lib/api';
import { useBuilds, useCancelBuild, useStartBuild, useStartPreviewBuild } from '@/lib/buildApi';
import { useReleaseJob } from '@/lib/releaseApi';
import { useRepos, useSettings } from '@/lib/settingsApi';
import { canResume } from '@/release/model';
import { PageTitle } from '@/components/PageTitle';
import { CrystalTrigger } from '@/components/glass/CrystalTrigger';
import { useVisual } from '@/lib/visuals';

interface BuildTarget {
  repo: string;
  mode: BuildMode;
  /** Set for a QA preview: the MRs to merge, in order. */
  mrIids?: number[];
}

const isActive = (view: BuildView) => view.job.status === 'queued' || view.job.status === 'running';
const FLAVOR_FAILURE = 'flavor_choice_required:';

const jobIdOf = (details: unknown): string | null => {
  if (typeof details !== 'object' || details === null || !('jobId' in details)) return null;
  return typeof details.jobId === 'string' ? details.jobId : null;
};

/** Why the server refused to queue a build, in plain words and with the way out. */
function Refusal({
  error,
  repo,
  onShowLog,
}: {
  error: unknown;
  repo: string;
  onShowLog: (jobId: string) => void;
}) {
  const code = error instanceof ApiError ? error.code : null;
  const details = error instanceof ApiError ? error.details : undefined;
  const otherBuild = code === 'build_already_active' ? jobIdOf(details) : null;
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {code === 'release_active' ? 'Build refused: a release is active' : 'Build refused'}
      </AlertTitle>
      <AlertDescription>
        <p>{describeError(error)}</p>
        {code === 'release_active' && (
          <p>
            A build cannot share the bot clone with a release, even a paused one. Build when the
            release has ended, or{' '}
            <Link className="underline" to={`/release?repo=${encodeURIComponent(repo)}`}>
              open it in Release
            </Link>
            .
          </p>
        )}
        {otherBuild && (
          <button type="button" className="underline" onClick={() => onShowLog(otherBuild)}>
            Show that build&apos;s log
          </button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A standalone build leaves a stopped release unfinished: its upload, Notion proposal and DONE only follow a resume. */
function StoppedReleaseHint({ repo }: { repo: string }) {
  const { data: view } = useReleaseJob(repo);
  if (!view || !canResume(view)) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>A release of this repo has stopped</AlertTitle>
      <AlertDescription>
        Resuming it builds the tagged commit and carries on from there.{' '}
        <Link className="underline" to={`/release?repo=${encodeURIComponent(repo)}`}>
          Open it in Release
        </Link>{' '}
        rather than starting a separate build.
      </AlertDescription>
    </Alert>
  );
}

/** Builds: start, queue, live log, history and local downloads. */
export function Builds() {
  const builds = useBuilds();
  const repos = useRepos();
  const settings = useSettings();
  const start = useStartBuild();
  const startPreview = useStartPreviewBuild();
  const [previewing, setPreviewing] = useState(false);
  const cancel = useCancelBuild();
  const showVisual = useVisual('builds');

  // The Sync Health "Open Builds" fix names the repo. It only chooses it: nothing starts.
  const [params] = useSearchParams();
  const focus = params.get('repo');
  const [repo, setRepo] = useState(focus ?? '');
  const [mode, setMode] = useState<BuildMode>('staging');
  const [picked, setPicked] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ error: unknown; repo: string } | null>(null);
  const [choice, setChoice] = useState<(BuildTarget & { detection: FlavorDetection }) | null>(null);

  const repoList = repos.data ?? [];
  const chosenRepo = repo || repoList[0]?.id || '';
  const nameOf = (id: string) => repoList.find((r) => r.id === id)?.name ?? id;
  const items = builds.data?.items ?? [];
  const queue = items.filter(isActive);
  const history = items.filter((view) => !isActive(view));
  // Follow the running build until the user picks a log. Kept once it ends, so the log does not vanish while being read.
  const runningJobId = builds.data?.runningJobId ?? null;
  if (picked === null && runningJobId !== null) setPicked(runningJobId);
  const shownLog = picked ?? runningJobId;

  const startBuild = (target: BuildTarget, flavor: string | null = null) => {
    setRefused(null);
    const { mrIids, ...plain } = target;
    const handlers = {
      onSuccess: (view: BuildView) => setPicked(view.job.id),
      onError: (error: unknown) => {
        const detection =
          error instanceof ApiError && error.code === 'flavor_choice_required'
            ? FlavorDetectionSchema.safeParse(error.details)
            : null;
        if (detection?.success) setChoice({ ...target, detection: detection.data });
        else setRefused({ error, repo: target.repo });
      },
    };
    if (mrIids) startPreview.mutate({ repo: target.repo, mrIids, flavor }, handlers);
    else start.mutate({ ...plain, flavor }, handlers);
  };

  const row = (view: BuildView) => {
    const { job } = view;
    const retryable =
      job.status === 'failed' &&
      job.parentJobId === null &&
      job.error?.startsWith(FLAVOR_FAILURE) === true;
    const { mode: jobMode } = job;
    return (
      <BuildRow
        key={job.id}
        view={view}
        repoName={nameOf(job.repoId)}
        selected={shownLog === job.id}
        cancelPending={cancel.isPending && cancel.variables === job.id}
        dryRun={settings.data?.dryRun === true}
        onShowLog={() => setPicked(job.id)}
        onCancel={() => cancel.mutate(job.id)}
        onRetryFlavor={
          retryable && jobMode !== 'custom'
            ? () => startBuild({ repo: job.repoId, mode: jobMode })
            : null
        }
        newestOfRepo={items.find((item) => item.job.repoId === job.repoId)?.job.id === job.id}
      />
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <PageTitle>Builds</PageTitle>
        <p className="text-sm text-muted-foreground">
          One build at a time, across all repos, in the order they were added.
        </p>
      </div>

      {settings.data?.dryRun === true && (
        <Alert variant="warning">
          <AlertTitle>Dry-run is ON</AlertTitle>
          <AlertDescription>
            New builds only log their commands, and uploads are simulated. Nothing is built or sent.
          </AlertDescription>
        </Alert>
      )}

      {focus && <StoppedReleaseHint repo={focus} />}

      <Card>
        <CardHeader>
          <CardTitle>New build</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {repos.isSuccess && repoList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos yet. Add one under Settings.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-64">
                <Select
                  aria-label="Repo"
                  value={chosenRepo}
                  onChange={(e) => setRepo(e.target.value)}
                >
                  {repoList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-full sm:w-64">
                <Select
                  aria-label="Mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value === 'prod' ? 'prod' : 'staging')}
                >
                  <option value="staging">Staging (APK)</option>
                  <option value="prod">Prod (APK + AAB)</option>
                </Select>
              </div>
              <Button
                disabled={chosenRepo === '' || start.isPending}
                onClick={() => startBuild({ repo: chosenRepo, mode })}
              >
                {start.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
                Build
              </Button>
              <Button
                variant="outline"
                disabled={chosenRepo === '' || startPreview.isPending}
                onClick={() => setPreviewing(true)}
              >
                {startPreview.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
                QA preview…
              </Button>
            </div>
          )}
          {showVisual && repoList.length > 0 && (
            // Hold to grow a crystal: it calls the same startBuild as the Build button, so nothing is skipped.
            <CrystalTrigger
              ready={chosenRepo !== ''}
              busy={start.isPending}
              failed={start.isError}
              labels={mode === 'prod' ? ['APK', 'AAB'] : ['APK']}
              action={`${settings.data?.dryRun === true ? 'simulate' : 'start'} a ${mode} build`}
              lockedHint="Pick a repo first"
              onFire={() => startBuild({ repo: chosenRepo, mode })}
            />
          )}
          {refused && <Refusal error={refused.error} repo={refused.repo} onShowLog={setPicked} />}
          {cancel.isError && (
            <Alert variant="destructive">
              <AlertTitle>Could not cancel</AlertTitle>
              <AlertDescription>{describeError(cancel.error)}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {builds.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Loading…
        </p>
      )}
      {builds.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the builds</AlertTitle>
          <AlertDescription>{describeError(builds.error)}</AlertDescription>
        </Alert>
      )}

      {builds.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle>Queue</CardTitle>
          </CardHeader>
          <CardContent>
            {queue.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is queued or running.</p>
            ) : (
              <ul>{queue.map(row)}</ul>
            )}
          </CardContent>
        </Card>
      )}

      {shownLog && (
        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <LogViewer key={shownLog} jobId={shownLog} />
          </CardContent>
        </Card>
      )}

      {builds.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No finished builds yet.</p>
            ) : (
              <ul>{history.map(row)}</ul>
            )}
          </CardContent>
        </Card>
      )}

      {previewing && (
        <PreviewDialog
          repo={chosenRepo}
          repoName={nameOf(chosenRepo)}
          dryRun={settings.data?.dryRun === true}
          onClose={() => setPreviewing(false)}
          onBuild={(mrIids) => {
            setPreviewing(false);
            startBuild({ repo: chosenRepo, mode: 'staging', mrIids });
          }}
        />
      )}

      {choice && (
        <FlavorDialog
          repoName={nameOf(choice.repo)}
          detection={choice.detection}
          onClose={() => setChoice(null)}
          onChoose={(flavor) => {
            setChoice(null);
            startBuild({ repo: choice.repo, mode: choice.mode }, flavor);
          }}
        />
      )}
    </div>
  );
}
