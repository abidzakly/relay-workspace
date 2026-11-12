import { useState } from 'react';
import {
  BULK_READY_MAX_CARDS,
  FlavorDetectionSchema,
  type ReleaseJobView,
  type ReleaseNotionAuto,
} from '@relay/shared';
import { FlavorDialog } from '@/builds/FlavorDialog';
import { ShareControls } from '@/builds/ShareControls';
import { BulkReadyDialog } from '@/components/BulkReadyDialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { useBuilds } from '@/lib/buildApi';
import { useResumeWithFlavor } from '@/lib/releaseApi';
import { stateText, stepOf } from './model';

/** A release that simulated its build has nothing to offer once dry-run is off, and the reverse. */
const sameMode = (view: ReleaseJobView, dryRunNow: boolean) => view.job.dryRun === dryRunNow;

/** Send to QA, once the release's APK is on Drive. The same control as on Builds: it opens WhatsApp, and sends nothing. */
export function QaShare({ view, dryRunNow }: { view: ReleaseJobView; dryRunNow: boolean }) {
  const builds = useBuilds();
  if (stepOf(view, 'SHARE')?.status !== 'succeeded' || !sameMode(view, dryRunNow)) return null;
  const buildJobId = stateText(view, 'buildJobId');
  const build = builds.data?.items.find((item) => item.job.id === buildJobId);
  if (!build?.share.eligible) return null;
  return (
    <div className="grid gap-1.5 rounded-md border p-3">
      <h3 className="text-sm font-medium">Send to QA</h3>
      <ShareControls view={build} dryRun={dryRunNow} />
    </div>
  );
}

/** What the NOTION step did by itself. */
function AutoSummary({ auto, readyStatus }: { auto: ReleaseNotionAuto; readyStatus: string }) {
  if (auto.updated === 0 && !auto.error && auto.failed.length === 0) return null;
  const count = `${auto.updated} card${auto.updated === 1 ? '' : 's'}`;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {auto.updated > 0 && (
        <p>
          {auto.dryRun
            ? `Dry-run: ${count} would move to ${readyStatus}. Nothing was written.`
            : `${count} moved to ${readyStatus}. Undo is under Audit.`}
        </p>
      )}
      {auto.error && <p className="text-destructive">No card was changed: {auto.error}</p>}
      {auto.failed.map((f) => (
        <p key={f.title} className="break-words text-destructive">
          {f.title}: {f.message}
        </p>
      ))}
    </div>
  );
}

/**
 * The NOTION step's outcome. Cards it did not move, as they are not Complete or the write failed, go through the same
 * dialog and confirmation as the Board. They stay here after the job has ended, holding nothing up.
 */
export function NotionOffer({ view, dryRunNow }: { view: ReleaseJobView; dryRunNow: boolean }) {
  const [open, setOpen] = useState<string[] | null>(null);
  const offer = view.notion;
  if (!offer) return null;
  if (offer.cards.length === 0) {
    return offer.pendingUnknown ? (
      <p className="text-xs text-muted-foreground">
        The pending cards could not be told when this release started, so none is changed. Use Bulk
        Ready to Test on the Board if some belong to it.
      </p>
    ) : null;
  }
  const { auto } = offer;
  const summary = auto && <AutoSummary auto={auto} readyStatus={offer.readyStatus} />;
  const waiting = offer.cards.filter((c) => !c.ready);
  // A simulated release wrote nothing, so its cards are not waiting for anyone.
  if (waiting.length === 0 || (view.job.dryRun && auto?.dryRun)) return summary;
  if (!sameMode(view, dryRunNow)) {
    return (
      <>
        {summary}
        <p className="text-xs text-muted-foreground">
          {view.job.dryRun
            ? `This release was simulated, so its ${offer.readyStatus} change is not offered now dry-run is off.`
            : `Turn dry-run off to change these cards to ${offer.readyStatus}.`}
        </p>
      </>
    );
  }
  const batch = waiting.slice(0, BULK_READY_MAX_CARDS).map((c) => c.cardId);
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <h3 className="text-sm font-medium">
        {waiting.length} card{waiting.length === 1 ? '' : 's'} not yet {offer.readyStatus}
      </h3>
      {summary}
      <ul className="grid gap-1 text-sm">
        {waiting.map((c) => (
          <li key={c.cardId} className="flex flex-wrap justify-between gap-x-2 break-words">
            <span className="min-w-0">{c.title}</span>
            <span className="text-xs text-muted-foreground">{c.status ?? 'no status'}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {auto
          ? 'These were left alone: they are not Complete, or the change failed.'
          : 'Nothing has changed in Notion.'}{' '}
        Review reads each card live, and only what you confirm is written.
        {waiting.length > BULK_READY_MAX_CARDS &&
          ` One batch holds ${BULK_READY_MAX_CARDS} cards: review again for the rest.`}
      </p>
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(batch)}>
          Review for {offer.readyStatus}
        </Button>
      </div>
      <BulkReadyDialog cardIds={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** BUILD stopped because the clone leaves the flavor open. The answer goes with the resume. Never guessed. */
export function FlavorChoice({ repo, view }: { repo: string; view: ReleaseJobView }) {
  const [open, setOpen] = useState(false);
  const resume = useResumeWithFlavor(repo, view.job.id);
  const detection = FlavorDetectionSchema.safeParse(view.job.state.flavorChoice);
  if (view.job.status !== 'failed' || !detection.success) return null;
  return (
    <div className="grid gap-2">
      <div>
        <Button
          size="sm"
          disabled={resume.isPending}
          onClick={() => {
            resume.reset();
            setOpen(true);
          }}
        >
          Choose a flavor and resume
        </Button>
      </div>
      {resume.isError && (
        <Alert variant="destructive">
          <AlertTitle>Refused</AlertTitle>
          <AlertDescription>{describeError(resume.error)}</AlertDescription>
        </Alert>
      )}
      {open && (
        <FlavorDialog
          repoName={repo}
          detection={detection.data}
          onClose={() => setOpen(false)}
          onChoose={(flavor) => {
            setOpen(false);
            resume.mutate(flavor);
          }}
        />
      )}
    </div>
  );
}
