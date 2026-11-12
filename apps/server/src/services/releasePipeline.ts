import { z } from 'zod';
import {
  BuildModeSchema,
  normalizeName,
  ReleaseNotionAutoSchema,
  type BuildResult,
  type BuildUpload,
  type GlobalConfig,
  type Job,
  type Json,
  type ReleaseNotionAuto,
  type ReleaseNotionOffer,
  type RepoConfig,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { EventBus } from '../sync/eventBus';
import { ActionError } from './actionError';
import type { BuildQueue } from './buildQueue';
import type { CardActions } from './cardActions';
import type { JobStore } from './jobStore';
import { listCards } from './notionStore';
import { buildPendingReleases } from './releaseCheck';
import { ReleaseError, type ReleaseHooks, type StepContext } from './releaseSteps';
import type { ShareService } from './share';

/**
 * BUILD -> UPLOAD -> SHARE -> NOTION -> DONE of a release.
 *
 * Each step looks first at what is already true, so a resume never builds or uploads twice. What a human decides:
 *  - the upload is confirmed by the click on Start (or Resume, for a job older than this wiring), whose form says so
 *  - SHARE only offers the wa.me link: WhatsApp needs a person to press send
 *  - NOTION moves the Complete cards to Ready to Test, which the same click on Start confirms. Any other card stays
 *    open on the job for as long as it is the repo's newest, and its write goes through the bulk endpoints' preview and
 *    single-use token. The job never waits for that and never fails on it: the APK is already made.
 */

const PendingCardsSchema = z.array(
  z.object({
    cardId: z.string().min(1),
    title: z.string(),
    /** Absent from a job noted before links were kept. */
    url: z.string().nullable().default(null),
  }),
);
type NotedCard = z.infer<typeof PendingCardsSchema>[number];

export function notedCards(state: Record<string, Json>): NotedCard[] {
  const parsed = PendingCardsSchema.safeParse(state.pendingCards);
  return parsed.success ? parsed.data : [];
}

/**
 * The bump empties the pending list, so a release notes the cards while they are pending: at the start, and again
 * at "Merge now" because anything merged during the review is part of this release too. Earlier notes are kept, as the
 * list may already be empty if the MR got merged in GitLab meanwhile. A read of the local cache, which a poll may trail.
 */
export function notePending(
  store: AppDb,
  repo: RepoConfig,
  global: { notion: Pick<GlobalConfig['notion'], 'readyStatus' | 'statusGroups'> },
  state: Record<string, Json>,
  now: number,
): Record<string, Json> {
  const [pending] = buildPendingReleases(store, [repo], global, now);
  const cards = new Map(notedCards(state).map((card) => [card.cardId, card] as const));
  for (const { cardId, title, url } of pending?.pendingCards ?? []) {
    cards.set(cardId, { cardId, title, url });
  }
  return {
    pendingCards: [...cards.values()],
    pendingUnknown: pending?.status !== 'ok',
  };
}

/** The NOTION step's outcome with each card's status now. Null until that step has run. */
export function notionOffer(
  store: AppDb,
  global: { notion: Pick<GlobalConfig['notion'], 'readyStatus'> },
  job: Job,
): ReleaseNotionOffer | null {
  const offeredAt = job.state.notionOfferedAt;
  if (typeof offeredAt !== 'number') return null;
  const readyStatus = global.notion.readyStatus;
  const ready = normalizeName(readyStatus);
  const status = new Map(listCards(store).map((card) => [card.id, card.status] as const));
  const auto = ReleaseNotionAutoSchema.safeParse(job.state.notionAuto);
  return {
    offeredAt,
    pendingUnknown: job.state.pendingUnknown === true,
    readyStatus,
    auto: auto.success ? auto.data : null,
    cards: notedCards(job.state).map(({ cardId, title }) => {
      const now = status.get(cardId) ?? null;
      return { cardId, title, status: now, ready: now !== null && normalizeName(now) === ready };
    }),
  };
}

/** Never throws: whatever could not be moved is reported, and stays open to the bulk dialog. */
async function moveCompleteCards(
  d: Pick<ReleaseHooksDeps, 'cards'>,
  ctx: StepContext,
  cards: readonly NotedCard[],
): Promise<ReleaseNotionAuto> {
  const none = { updated: 0, skippedNotComplete: 0, failed: [], dryRun: ctx.dryRun, error: null };
  if (cards.length === 0) return none;
  try {
    const result = await d.cards.autoReady(
      cards.map((card) => card.cardId),
      { releaseJobId: ctx.job.id, simulate: ctx.dryRun },
    );
    const updated = result.items.filter((item) => item.outcome === 'updated').length;
    const skippedNotComplete = result.items.filter(
      (item) => item.outcome === 'skipped_warned',
    ).length;
    const failed = result.items.flatMap((item) =>
      item.failure ? [{ title: item.title, message: item.failure.message }] : [],
    );
    ctx.log(
      `${updated} card(s) ${result.dryRun ? 'would move' : 'moved'} to ${result.after}. ` +
        `${skippedNotComplete} not Complete, ${failed.length} failed.`,
    );
    return { updated, skippedNotComplete, failed, dryRun: result.dryRun, error: null };
  } catch (e) {
    // Only the service's own text goes on, as with an upload's error.
    const error =
      e instanceof ActionError ? e.message : 'The Notion change failed. See the server log.';
    ctx.log(`No card was changed: ${error}`);
    return { ...none, error };
  }
}

export interface ReleaseHooksDeps {
  config: ConfigStore;
  jobs: JobStore;
  builds: BuildQueue;
  share: ShareService;
  cards: Pick<CardActions, 'autoReady'>;
  bus: EventBus;
}

export function createReleaseHooks(d: ReleaseHooksDeps): ReleaseHooks {
  /** The same rule as `ctx.write`: a live job stops when dry-run is switched on, and resumes once it is off. */
  const assertStillLive = (ctx: StepContext) => {
    if (!ctx.dryRun && d.config.isDryRun()) {
      throw new ReleaseError(
        'dry_run_switched_on',
        'Dry-run was switched on during this live release. Switch it off to resume.',
      );
    }
  };

  /** Runs `work` with a cancel of the release passed on through `stop`. */
  const stoppable = async <T>(ctx: StepContext, stop: () => void, work: () => Promise<T>) => {
    if (ctx.signal.aborted) stop();
    ctx.signal.addEventListener('abort', stop, { once: true });
    try {
      return await work();
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
  };

  const isGoodBuild = (ctx: StepContext, result: BuildResult) =>
    result.dryRun === ctx.dryRun && (ctx.dryRun || result.version === ctx.job.version);

  /** A finished build of this release that still fits it. A failed one, or one simulated while the job is live, does not. */
  const finishedBuild = (ctx: StepContext): { job: Job; result: BuildResult } | null => {
    const child = d.jobs.latestChildBuild(ctx.job.id);
    if (child?.status !== 'succeeded') return null;
    const result = d.builds.result(child.id);
    return result && isGoodBuild(ctx, result) ? { job: child, result } : null;
  };

  /**
   * A failed release no longer holds the clone, so a standalone build may have moved it past the tag. Detached, since only
   * this build reads it. The next sync puts it back on the base branch.
   */
  const putCloneAtRelease = async (ctx: StepContext) => {
    const sha = ctx.job.state.releaseHead;
    if (ctx.dryRun || typeof sha !== 'string') return;
    const head = await ctx.git(['rev-parse', '--verify', 'HEAD']);
    if (head.stdout.trim() === sha) return;
    ctx.log(`The clone moved since the tag. Checking out ${sha} to build the release.`);
    await ctx.git(['checkout', '-f', '--detach', sha]);
  };

  const buildNow = async (ctx: StepContext): Promise<{ job: Job; result: BuildResult }> => {
    const { job } = ctx;
    await putCloneAtRelease(ctx);
    const flavor = typeof job.state.buildFlavor === 'string' ? job.state.buildFlavor : null;
    let build: Job;
    try {
      build = await d.builds.enqueue({
        repoId: job.repoId,
        mode: job.mode,
        buildMode: BuildModeSchema.parse(job.state.releaseMode),
        flavor,
        parentJobId: job.id,
        dryRun: ctx.dryRun,
        qaChanges: notedCards(job.state).map(({ title, url }) => ({ title, url })),
      });
    } catch (e) {
      if (e instanceof ActionError && e.code === 'flavor_choice_required') {
        // For the Release Train's dialog: Resume takes the answer.
        d.jobs.mergeState(job.id, { flavorChoice: e.details as Json });
      }
      throw e;
    }
    ctx.log(`Build ${build.id} queued. Its live log is under Builds.`);
    await stoppable(
      ctx,
      () => {
        try {
          d.builds.cancel(build.id);
        } catch {
          ctx.log('The build had already ended when the cancel arrived');
        }
      },
      () => d.builds.whenFinished(build.id),
    );
    const ended = d.jobs.get(build.id);
    const result = ended?.status === 'succeeded' ? d.builds.result(build.id) : null;
    if (!ended || !result) {
      if (ended?.status === 'cancelled') {
        throw new ReleaseError('build_cancelled', 'The build was cancelled. Resume builds again.');
      }
      throw new ReleaseError('build_failed', ended?.error ?? 'The build failed. See its log.');
    }
    if (result.dryRun !== ctx.dryRun) {
      throw new ReleaseError(
        'dry_run_switched_on',
        'Dry-run was switched on while this build waited, so nothing was built. Switch it off and resume.',
      );
    }
    if (!isGoodBuild(ctx, result)) {
      throw new ReleaseError(
        'build_version_mismatch',
        `The build made ${result.version ?? '(no version)'}, this release is ${job.version ?? '(no version)'}.`,
      );
    }
    return { job: ended, result };
  };

  const buildOf = (ctx: StepContext): Job => {
    const id = ctx.job.state.buildJobId;
    const build = typeof id === 'string' ? d.builds.job(id) : null;
    if (!build) throw new ReleaseError('job_state_invalid', 'This release has no build');
    return build;
  };

  /** An upload already made, by an earlier run or by the button on Builds, counts. */
  const uploadOnce = async (ctx: StepContext, buildId: string): Promise<BuildUpload> => {
    await d.share.whenUploadSettled(buildId);
    const build = d.builds.job(buildId);
    if (!build) throw new ReleaseError('job_state_invalid', 'This release has no build');
    const stored = d.share.viewOf(build).upload;
    if (stored?.dryRun === ctx.dryRun) {
      ctx.log(`Already uploaded: ${stored.fileName}`);
      return stored;
    }
    const { finished } = d.share.beginUpload(buildId, { simulate: ctx.dryRun });
    try {
      return await stoppable(
        ctx,
        () => d.share.cancelUpload(buildId),
        () => finished,
      );
    } catch (e) {
      if (e instanceof ActionError) throw e;
      // A raw client error can hold request headers, so only the service's own text goes on.
      const after = d.builds.job(buildId);
      const text = after ? d.share.viewOf(after).uploadError : null;
      throw new ReleaseError('upload_failed', text ?? 'The upload failed. See the server log.');
    }
  };

  return {
    BUILD: async (ctx) => {
      assertStillLive(ctx);
      const adopted = finishedBuild(ctx);
      if (adopted) ctx.log(`Build ${adopted.job.id} already finished. Not building again.`);
      const { job: build, result } = adopted ?? (await buildNow(ctx));
      for (const artifact of result.artifacts) ctx.log(`Built ${artifact.fileName}`);
      if (result.dryRun) ctx.log('dry-run: nothing was built');
      return {
        output: {
          buildJobId: build.id,
          flavor: result.flavor,
          version: result.version,
          dryRun: result.dryRun,
          artifacts: result.artifacts.map(({ kind, fileName, sizeBytes }) => ({
            kind,
            fileName,
            sizeBytes,
          })),
        },
        state: { buildJobId: build.id },
      };
    },

    UPLOAD: async (ctx) => {
      assertStillLive(ctx);
      if (typeof ctx.job.state.uploadConfirmedAt !== 'number') {
        throw new ReleaseError(
          'upload_not_confirmed',
          'This release started before uploads were part of it. Resume to upload its APK to Drive, or cancel and use Builds.',
        );
      }
      const build = buildOf(ctx);
      const upload = await uploadOnce(ctx, build.id);
      ctx.log(
        upload.dryRun ? 'dry-run: nothing was sent to Drive' : `On Drive: ${upload.fileName}`,
      );
      return {
        output: {
          buildJobId: build.id,
          fileName: upload.fileName,
          webViewLink: upload.webViewLink,
          linkAccess: upload.linkAccess,
          dryRun: upload.dryRun,
        },
      };
    },

    // The push went out with the upload. Nothing is sent from here, and the job does not wait for the click.
    SHARE: (ctx) => {
      const build = buildOf(ctx);
      if (!ctx.repo.qa.whatsapp) {
        ctx.log('This repo has no QA WhatsApp number. Set it under Settings to use Send to QA.');
      }
      ctx.log(
        'Send to QA is ready. Nothing goes out until you open it and press send in WhatsApp.',
      );
      return Promise.resolve({ output: { buildJobId: build.id, sent: false } });
    },

    // Reached only after UPLOAD (staging) or BUILD (prod, custom) succeeded. See the file comment for why it cannot fail.
    NOTION: async (ctx) => {
      const cards = notedCards(ctx.job.state);
      if (ctx.job.state.pendingUnknown === true && cards.length === 0) {
        ctx.log('The pending list could not be told at the start, so no card is changed.');
      }
      const auto = await moveCompleteCards(d, ctx, cards);
      return {
        output: {
          proposed: cards.length,
          written: auto.dryRun ? 0 : auto.updated,
          simulated: auto.dryRun ? auto.updated : 0,
          skippedNotComplete: auto.skippedNotComplete,
          failed: auto.failed.length,
        },
        state: { notionOfferedAt: ctx.now(), notionAuto: auto },
      };
    },

    DONE: (ctx) => {
      const { job } = ctx;
      d.bus.emit({
        type: 'release.done',
        jobId: job.id,
        repoId: job.repoId,
        mode: job.mode,
        version: job.version,
        dryRun: job.dryRun,
        at: ctx.now(),
      });
      ctx.log(`Release ${job.version ?? '(no version)'} finished`);
      return Promise.resolve({ output: { version: job.version } });
    },
  };
}
