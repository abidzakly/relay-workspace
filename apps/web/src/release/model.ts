import {
  isSafeVersion,
  type JobMode,
  type JobStep,
  type JobStepName,
  type PendingRelease,
  type ReleaseJobView,
  type ReleaseUnknownReason,
} from '@relay/shared';

/** Pure view logic of the Release. */

export type StageState = 'done' | 'active' | 'waiting' | 'failed' | 'skipped' | 'unknown' | 'idle';

export interface Stage {
  label: string;
  state: StageState;
  note: string;
}

export const UNKNOWN_REASON_TEXT: Record<ReleaseUnknownReason, string> = {
  never_checked:
    'No successful check of this repo yet (GitLab not set up, or before the first sync).',
  stale: 'The last successful check is too old to trust.',
  list_incomplete: 'The merged-MR list could not be read far enough back.',
  no_boundary: 'No version MR exists, and the pubspec and tag comparison gives no answer.',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function stepOf(view: ReleaseJobView | null, name: JobStepName): JobStep | undefined {
  return view?.steps.find((s) => s.name === name);
}

/** Placeholder hooks end `succeeded` without doing anything, which must not read as "built". */
export function isPlaceholder(step: JobStep): boolean {
  return step.output?.placeholder === true;
}

/** A PTY job has no such steps. vu's frm build is real but the dashboard does not track it. */
const PTY_STAGE_NOTE: Partial<Record<JobStepName, string>> = {
  BUILD: 'Through frm in vu, not tracked',
  SHARE: 'Not done by the PTY engine',
  NOTION: 'Not done by the PTY engine',
};

function hookStage(
  label: string,
  doneWord: string,
  view: ReleaseJobView | null,
  name: JobStepName,
): Stage {
  if (!view) return { label, state: 'idle', note: 'No release yet' };
  if (view.job.engine === 'pty') return { label, state: 'idle', note: PTY_STAGE_NOTE[name] ?? '' };
  const of = view.job.version ? ` (${view.job.version})` : '';
  const step = stepOf(view, name);
  if (!step) return { label, state: 'idle', note: `Not part of this job${of}` };
  if (isPlaceholder(step)) return { label, state: 'idle', note: 'Not available yet' };
  switch (step.status) {
    case 'succeeded':
      return {
        label,
        state: 'done',
        note: view.job.dryRun ? `Simulated${of}` : `${doneWord}${of}`,
      };
    case 'skipped':
      return { label, state: 'skipped', note: `Staging only${of}` };
    case 'failed':
      return { label, state: 'failed', note: `Failed${of}` };
    case 'running':
    case 'paused':
      return { label, state: 'active', note: `In progress${of}` };
    case 'pending':
      return { label, state: 'idle', note: `Not reached${of}` };
  }
}

/** Uploading is the visible part of sharing. What happens after the link is opened is known only to the person sending. */
function sharedStage(view: ReleaseJobView | null): Stage {
  const label = 'Shared';
  const base = hookStage(label, 'Offered', view, 'SHARE');
  if (!view || view.job.engine === 'pty') return base;
  const upload = stepOf(view, 'UPLOAD');
  if (upload?.status === 'running') return { label, state: 'active', note: 'Uploading to Drive' };
  if (upload?.status === 'failed') return { label, state: 'failed', note: 'Upload failed' };
  if (base.state !== 'done' || view.job.dryRun) return base;
  return typeof view.job.state.qaLinkOpenedAt === 'number'
    ? { label, state: 'done', note: 'WhatsApp opened for QA' }
    : { label, state: 'waiting', note: 'On Drive: press Send to QA' };
}

/** From the cards the release noted, as they are now. Null when the release has not reached its Notion step. */
function offerStage(view: ReleaseJobView | null): Stage | null {
  const offer = view?.notion;
  if (!offer) return null;
  const label = 'Ready to Test';
  const total = offer.cards.length;
  const ready = offer.cards.filter((c) => c.ready).length;
  if (total === 0) {
    return {
      label,
      state: 'idle',
      note: offer.pendingUnknown ? 'Pending cards unknown' : 'No pending cards',
    };
  }
  if (ready === total) return { label, state: 'done', note: plural(total, 'card') };
  if (offer.auto?.dryRun) return { label, state: 'idle', note: 'Simulated' };
  return { label, state: 'waiting', note: `${ready} of ${total}: review below` };
}

/** Complete -> Merged -> Awaiting version bump -> Built -> Shared -> Ready to Test. */
export function pipelineStages(release: PendingRelease, view: ReleaseJobView | null): Stage[] {
  const unknown = release.status === 'unknown';
  const cards = release.pendingCards;
  const complete = cards.filter((c) => c.complete).length;
  const ready = cards.filter((c) => c.ready).length;
  const mrs = release.pendingMrs.length;
  const active = isActive(view);
  const cannotTell = (label: string): Stage => ({ label, state: 'unknown', note: 'Cannot tell' });

  const completeStage: Stage = unknown
    ? cannotTell('Complete')
    : complete > 0
      ? { label: 'Complete', state: 'done', note: plural(complete, 'card') }
      : {
          label: 'Complete',
          state: mrs > 0 ? 'waiting' : 'idle',
          note: mrs > 0 ? 'No linked card is Complete' : 'Nothing pending',
        };

  const mergedStage: Stage = unknown
    ? cannotTell('Merged')
    : mrs > 0
      ? { label: 'Merged', state: 'done', note: `${plural(mrs, 'MR')} since the last release` }
      : { label: 'Merged', state: 'idle', note: 'Nothing pending' };

  const bumpStage: Stage = active
    ? { label: 'Awaiting version bump', state: 'active', note: 'Release in progress' }
    : unknown
      ? cannotTell('Awaiting version bump')
      : release.needsVersionBump
        ? { label: 'Awaiting version bump', state: 'waiting', note: 'Update needed' }
        : {
            label: 'Awaiting version bump',
            state: 'done',
            note: release.boundary ? `Last: ${release.boundary.version}` : 'Nothing to bump',
          };

  const readyBase = hookStage('Ready to Test', 'Updated', view, 'NOTION');
  const readyStage: Stage =
    ready > 0 && readyBase.state === 'idle'
      ? { ...readyBase, note: `${ready} of ${plural(cards.length, 'pending card')}` }
      : readyBase;
  const built = hookStage('Built', 'Built', view, 'BUILD');

  return [
    completeStage,
    mergedStage,
    bumpStage,
    built,
    sharedStage(view),
    offerStage(view) ?? readyStage,
  ];
}

/** The station the train stands at: the furthest one working, else the first that stopped it, else the last one done. */
export function currentStage(stages: readonly Stage[]): number {
  const states = stages.map((s) => s.state);
  const active = states.lastIndexOf('active');
  if (active >= 0) return active;
  const stopped = states.findIndex((s) => s === 'failed' || s === 'waiting' || s === 'unknown');
  if (stopped >= 0) return stopped;
  return Math.max(0, states.lastIndexOf('done'));
}

/** The one thing to do now, in words. Null when nothing is asked of the user. */
export function nextStep(view: ReleaseJobView, cancelling: boolean): string | null {
  const { job } = view;
  if (cancelling) return null;
  if (view.ptyPrompt?.kind === 'enter') return 'Review the MR, then press Enter.';
  if (view.ptyPrompt?.kind === 'other') return 'Check what vu is asking below.';
  if (job.engine !== 'pty' && job.status === 'paused' && job.currentStep === 'AWAIT_REVIEW') {
    return 'Review the version MR, then merge it.';
  }
  if (canResume(view)) return 'Fix the cause below, then resume.';
  if (job.status === 'failed') return 'Fix the cause below, then start the release again.';
  if (job.status === 'queued' || job.status === 'running')
    return 'Nothing yet: the release is running.';
  if (
    job.status === 'succeeded' &&
    job.engine !== 'pty' &&
    stepOf(view, 'SHARE')?.status === 'succeeded'
  ) {
    return 'Send the build to QA when you are ready.';
  }
  return null;
}

export function isActive(view: ReleaseJobView | null): boolean {
  const s = view?.job.status;
  return s === 'queued' || s === 'running' || s === 'paused';
}

/** Mirrors the server's rule: only a failed job, or a cancelled one past its merge. */
export function canResume(view: ReleaseJobView): boolean {
  if (view.job.engine === 'pty') return false;
  if (view.job.status === 'failed') return true;
  return view.job.status === 'cancelled' && stepOf(view, 'MERGE')?.status === 'succeeded';
}

export function canCancel(view: ReleaseJobView): boolean {
  return isActive(view) || view.job.status === 'failed';
}

/** A string from the job's open-ended `state` bag. */
export function stateText(view: ReleaseJobView, key: string): string | null {
  const v = view.job.state[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

const sameVersion = (a: string, b: string) => {
  const core = (v: string) => v.replace(/^v/, '').split('+')[0];
  return core(a) === core(b);
};

/**
 * A cancelled job that the engine cannot finish (`job_not_resumable`) although its MR may be merged, so no tag exists.
 * `merged`  the detector's boundary shows the job's MR or version landed on base.
 * `unknown` a merge was under way when the cancel took effect and nothing has confirmed it either way.
 * The dashboard has no read of the repo's tags per job, so it can never tell that someone already tagged by hand.
 */
export type StrandedMerge = 'merged' | 'unknown' | null;

export function strandedMerge(view: ReleaseJobView, release: PendingRelease): StrandedMerge {
  const { job } = view;
  if (job.status !== 'cancelled') return null;
  const step = stepOf(view, 'MERGE');
  if (step?.status === 'succeeded') return null; // Resume finishes this one.

  const b = release.boundary;
  const landed =
    b !== null &&
    b.source !== 'tag' &&
    ((job.mrIid !== null && b.iid === job.mrIid) ||
      (b.source === 'head_commit' && job.version !== null && sameVersion(b.version, job.version)));
  if (landed) return 'merged';

  if (job.dryRun || job.mrIid === null || step?.status !== 'failed') return null;
  // `job_cancelled` is logged when the cancel arrived before the merge was sent.
  if (step.log.includes('job_cancelled')) return null;
  // Any other stored error is a refusal from before the cancel, and the MR is known to be unmerged.
  const undecided = step.error === 'Cancelled' || step.error?.includes('merge_not_confirmed');
  return undecided ? 'unknown' : null;
}

/** The tag this job would have pushed. Null when the job never got as far as knowing its version. */
export function expectedTag(view: ReleaseJobView, tagFormat: string): string | null {
  const stored = stateText(view, 'tag');
  if (stored) return stored;
  const commitVersion = stateText(view, 'commitVersion');
  return commitVersion ? tagFormat.replaceAll('{commitVersion}', commitVersion) : null;
}

/** Same acceptance as the server's `start`. Returns the error, or null. The server still has the last word. */
export function versionInputError(mode: JobMode, input: string): string | null {
  if (input === '') return mode === 'custom' ? 'Enter the full version to release.' : null;
  if (mode === 'staging' && /^[0-9]+$/.test(input)) return null;
  if (isSafeVersion(input)) return null;
  return mode === 'staging'
    ? 'Use X.Y.Z[-alpha-N][+build], or a bare number for the alpha number.'
    : 'Use X.Y.Z[-prerelease][+build].';
}
