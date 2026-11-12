import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import type { PendingRelease, RepoConfigPublic } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { ColumnEffort, EffortChip } from '@/components/EffortChip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useReleaseJob } from '@/lib/releaseApi';
import { useRepos, useSettings } from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { safeHref } from '@/lib/utils';
import { JobPanel } from '@/release/JobPanel';
import { isActive, pipelineStages, strandedMerge, UNKNOWN_REASON_TEXT } from '@/release/model';
import { PipelineStrip } from '@/release/PipelineStrip';
import { StartForm } from '@/release/StartForm';
import { PageTitle } from '@/components/PageTitle';

function PendingLists({ release }: { release: PendingRelease }) {
  const { pendingMrs, pendingCards } = release;
  const state = useStateSnapshot();
  const pointOf = new Map(
    (state.data?.cards ?? []).map((c) => [c.id.replace(/-/g, '').toLowerCase(), c.point]),
  );
  const pointFor = (id: string) => pointOf.get(id.replace(/-/g, '').toLowerCase()) ?? null;
  if (pendingMrs.length === 0 && pendingCards.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        {pendingMrs.length} merged MR(s) and {pendingCards.length} card(s) pending{' '}
        <ColumnEffort points={pendingCards.map((c) => pointFor(c.cardId))} />
      </summary>
      <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
        <ul className="grid gap-1">
          {pendingMrs.map((m) => {
            const href = safeHref(m.webUrl);
            const text = `!${m.iid} ${m.title}`;
            return (
              <li key={m.iid} className="break-words">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="underline">
                    {text}
                  </a>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
        <ul className="grid gap-1">
          {pendingCards.map((c) => {
            const href = safeHref(c.url);
            return (
              <li key={c.cardId} className="flex flex-wrap items-center gap-2 break-words">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="underline">
                    {c.title}
                  </a>
                ) : (
                  c.title
                )}
                <Badge variant={c.complete ? 'success' : 'secondary'}>
                  {c.status ?? 'no status'}
                </Badge>
                <EffortChip point={pointFor(c.cardId)} />
                {c.conflict && <Badge variant="warning">link conflict</Badge>}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

/** Why the update-version button is or is not there. "Cannot tell" never reads as "nothing pending". */
function DetectionNote({ release }: { release: PendingRelease }) {
  if (release.status === 'unknown') {
    return (
      <Alert variant="warning">
        <AlertTitle>Cannot tell whether a release is pending</AlertTitle>
        <AlertDescription>
          {release.reason ? UNKNOWN_REASON_TEXT[release.reason] : 'The check gave no answer.'}{' '}
          {release.error && `Last error: ${release.error.message}. `}
          The update-version button stays hidden until a check succeeds.
        </AlertDescription>
      </Alert>
    );
  }
  if (release.showUpdateVersion) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {release.needsVersionBump
        ? 'Merged MRs are pending, but none of their cards is Complete yet. The update-version button appears when one is.'
        : 'Nothing is pending since the last release.'}
    </p>
  );
}

function RepoRelease({
  release,
  repo,
  dryRun,
}: {
  release: PendingRelease;
  repo: RepoConfigPublic | undefined;
  dryRun: boolean;
}) {
  const job = useReleaseJob(release.repoId);
  const [formOpen, setFormOpen] = useState(false);
  const view = job.data ?? null;
  const active = isActive(view);
  // A started job (from here or another tab) replaces the form, and must not bring it back when it ends.
  if (active && formOpen) setFormOpen(false);
  const stranded = view ? strandedMerge(view, release) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {repo?.name ?? release.repoId}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {release.baseBranch}
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {release.boundary ? `Last release ${release.boundary.version}. ` : ''}
          Checked <TimeAgo at={release.checkedAt} />
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-x-auto pt-3 pr-2">
          <PipelineStrip stages={pipelineStages(release, view)} repoId={release.repoId} />
        </div>
        <DetectionNote release={release} />
        {release.status === 'ok' && release.error && (
          <p className="text-xs text-warning">
            The last check failed ({release.error.message}), so this is from the last good one.
          </p>
        )}
        {release.warnings.map((w) => (
          <p key={w} className="text-xs text-muted-foreground">
            {w}
          </p>
        ))}
        <PendingLists release={release} />

        {job.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load the latest release job</AlertTitle>
            <AlertDescription>{describeError(job.error)}</AlertDescription>
          </Alert>
        )}

        {release.showUpdateVersion && !active && !job.isPending && !job.isError && !formOpen && (
          <div>
            <Button size="sm" onClick={() => setFormOpen(true)}>
              Update version
            </Button>
          </div>
        )}
        {formOpen && !active && (
          <StartForm
            repo={release.repoId}
            dryRun={dryRun}
            strandedWarning={stranded !== null}
            onClose={() => setFormOpen(false)}
          />
        )}
        {job.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 motion-safe:animate-spin" /> Loading the latest release…
          </p>
        )}
        {view && repo && (
          <JobPanel
            repo={release.repoId}
            view={view}
            stranded={stranded}
            tagFormat={repo.tagFormat}
            baseBranch={release.baseBranch}
            dryRunNow={dryRun}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Release. `?repo=` focuses one repo; the Sync Health "Update version" fix links here. */
export function ReleaseTrain() {
  const [params, setParams] = useSearchParams();
  const state = useStateSnapshot();
  const repos = useRepos();
  const settings = useSettings();
  const focus = params.get('repo') ?? '';
  const items = state.data?.pendingReleases.items ?? [];
  const shown = focus ? items.filter((r) => r.repoId === focus) : items;
  const nameOf = (id: string) => repos.data?.find((r) => r.id === id);
  const dryRun = settings.data?.dryRun === true;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <PageTitle>Release</PageTitle>
        <p className="text-sm text-muted-foreground">
          Per repo: from Complete to Ready to Test. Nothing starts until you press Start.
        </p>
      </div>

      {dryRun && (
        <Alert variant="warning">
          <AlertTitle>Dry-run is ON</AlertTitle>
          <AlertDescription>
            New releases only simulate their writes: nothing reaches GitLab or the remote.
          </AlertDescription>
        </Alert>
      )}

      {items.length > 1 && (
        <div className="max-w-xs">
          <Select
            aria-label="Repo"
            value={focus}
            onChange={(e) => setParams(e.target.value ? { repo: e.target.value } : {})}
          >
            <option value="">All repos</option>
            {items.map((r) => (
              <option key={r.repoId} value={r.repoId}>
                {nameOf(r.repoId)?.name ?? r.repoId}
              </option>
            ))}
          </Select>
        </div>
      )}

      {state.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Loading…
        </p>
      )}
      {state.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the release state</AlertTitle>
          <AlertDescription>{describeError(state.error)}</AlertDescription>
        </Alert>
      )}
      {state.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No repos yet. Add one under Settings.</p>
      )}
      {state.isSuccess && focus !== '' && shown.length === 0 && items.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            There is no repo “{focus}”. Choose one above to see its release.
          </AlertDescription>
        </Alert>
      )}

      {shown.map((r) => (
        <RepoRelease key={r.repoId} release={r} repo={nameOf(r.repoId)} dryRun={dryRun} />
      ))}
    </div>
  );
}
