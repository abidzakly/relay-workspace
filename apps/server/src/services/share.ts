import { join } from 'node:path';
import { z } from 'zod';
import {
  apkDownloadPath,
  BuildUploadSchema,
  type BuildArtifact,
  type BuildResult,
  type BuildShareView,
  type BuildUpload,
  type Job,
  type RepoConfig,
  type ShareResult,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import type { BuildQueue, QaChange } from './buildQueue';
import type { DriveService } from './driveService';
import { guardedWrite, type GuardedWriteDeps } from './dryRun';
import type { JobStore } from './jobStore';
import type { Notifier } from './notifier';
import { getCard } from './notionStore';
import { buildPendingReleases } from './releaseCheck';
import { notedCards } from './releasePipeline';
import { assertStagingOnly, isStagingOnly } from './shareRule';

/**
 * Drive upload + Share to QA, for staging builds only (`shareRule.ts`).
 *
 * Nothing is ever sent to WhatsApp: `share` answers with a wa.me link, and a human opens it and presses send.
 * In a dry run, an upload is an audit row and a record with no link. Its message has a placeholder for the link, and the UI
 * shows it without opening it.
 */

const CHANGES_MAX_CARDS = 30;
const NO_DRIVE_LINK = '(dry run: no Drive link)';
const NO_CHANGES = '(no pending cards)';
const UPLOAD_FAILED = 'The upload failed. See the server log.';
const QaChangeSchema = z.object({ title: z.string(), url: z.string().nullable() });

// ───────────────────────────── Message and link ─────────────────────────────

export interface TemplateValues {
  qa: string;
  repo: string;
  version: string;
  drive: string;
  changes: string;
}

/** One pass, so a card title holding `{drive}` stays text. Unknown placeholders are left as written. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template
    .replace(/\r\n?/g, '\n')
    .replace(
      /\{(qa|repo|version|drive|changes)\}/g,
      (_, key) => values[key as keyof TemplateValues],
    );
}

export function formatChanges(changes: readonly QaChange[]): string {
  if (changes.length === 0) return NO_CHANGES;
  const lines = changes
    .slice(0, CHANGES_MAX_CARDS)
    .map(({ title, url }) => (url ? `- ${title}\n  ${url}` : `- ${title}`));
  const more = changes.length - CHANGES_MAX_CARDS;
  if (more > 0) lines.push(`...and ${more} more`);
  return lines.join('\n');
}

/**
 * `encodeURIComponent` gives UTF-8 percent escapes, for newlines (`%0A`) and emoji alike. It throws on half of a surrogate
 * pair, which a clipped title can hold, so those become U+FFFD first.
 */
export function whatsappUrl(number: string, message: string): string {
  if (!/^\d{6,15}$/.test(number)) {
    throw new ActionError(422, 'qa_number_invalid', 'The QA WhatsApp number must be 6-15 digits.');
  }
  const wellFormed = message.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
  return `https://wa.me/${number}?text=${encodeURIComponent(wellFormed)}`;
}

// ───────────────────────────── Service ─────────────────────────────

export interface ShareServiceDeps {
  config: ConfigStore;
  builds: BuildQueue;
  jobs: JobStore;
  drive: DriveService;
  audit: AuditWriter;
  store: AppDb;
  notifier: Pick<Notifier, 'notifyUploaded'>;
  bus: EventBus;
  log: Logger;
  now?: () => number;
}

interface ActiveUpload {
  abort: AbortController;
  sentBytes: number;
  totalBytes: number;
  finished: Promise<unknown>;
}

export class ShareService {
  private readonly uploads = new Map<string, ActiveUpload>();
  private readonly now: () => number;
  private readonly guard: GuardedWriteDeps;

  constructor(private readonly d: ShareServiceDeps) {
    this.now = d.now ?? Date.now;
    this.guard = { dryRun: d.config, audit: d.audit, log: d.log };
  }

  viewOf(job: Job): BuildShareView {
    const result = this.d.builds.result(job.id);
    const active = this.uploads.get(job.id);
    return {
      eligible: job.status === 'succeeded' && result !== null && isStagingOnly(job, result),
      uploading: active ? { sentBytes: active.sentBytes, totalBytes: active.totalBytes } : null,
      upload: this.storedUpload(job),
      uploadError: typeof job.state.uploadError === 'string' ? job.state.uploadError : null,
    };
  }

  /**
   * For a user's click, or the UPLOAD step of a release whose start was that click (`releasePipeline.ts`). A refusal throws
   * here, with nothing recorded. Once started, `finished` settles when the upload is over, and a failure both rejects it and
   * is kept as `state.uploadError`. `simulate` is for a dry-run release, which stays simulated if the setting has gone off.
   */
  beginUpload(
    jobId: string,
    options: { simulate?: boolean } = {},
  ): { finished: Promise<BuildUpload> } {
    const { job, result } = this.shareableBuild(jobId);
    const repo = this.repoOf(job);
    const folderId = repo.drive.folderId;
    if (!folderId) {
      throw new ActionError(
        422,
        'drive_folder_missing',
        `${repo.name} has no Drive folder. Set it under Settings.`,
      );
    }
    if (this.uploads.has(jobId)) {
      throw new ActionError(409, 'upload_in_progress', 'This build is already uploading');
    }
    const stored = this.storedUpload(job);
    if (stored && !stored.dryRun) {
      throw new ActionError(409, 'already_uploaded', 'This build is already on Drive');
    }
    const simulate = options.simulate === true;
    const dryRun = simulate || this.d.config.isDryRun();
    const artifact = this.apkOf(result);
    if (!artifact && !dryRun) {
      throw new ActionError(409, 'no_artifact', 'This build made no APK: it was a dry run.');
    }
    if (!dryRun) this.d.drive.assertKeyUsable();

    const active: ActiveUpload = {
      abort: new AbortController(),
      sentBytes: 0,
      totalBytes: artifact?.sizeBytes ?? 0,
      finished: Promise.resolve(),
    };
    this.uploads.set(jobId, active);
    this.emitJob(jobId);
    const guard: GuardedWriteDeps = simulate
      ? { ...this.guard, dryRun: { isDryRun: () => true } }
      : this.guard;
    const finished = this.runUpload(job, result, artifact, folderId, active, guard).finally(() => {
      this.uploads.delete(jobId);
      this.emitJob(jobId);
    });
    active.finished = finished.catch(() => undefined);
    return { finished };
  }

  /** Settles when an upload in progress is over, however it ended. */
  async whenUploadSettled(jobId: string): Promise<void> {
    await this.uploads.get(jobId)?.finished;
  }

  /** Stops an upload in progress. It is then recorded as failed, and can be retried. */
  cancelUpload(jobId: string): void {
    this.uploads.get(jobId)?.abort.abort();
  }

  /** The wa.me link for a build already on Drive. The link's owner still has to press send. */
  async share(
    jobId: string,
    options: { includeLocalLink: boolean; localOrigin: string },
  ): Promise<ShareResult> {
    const { job, result } = this.shareableBuild(jobId);
    const repo = this.repoOf(job);
    const upload = this.storedUpload(job);
    const dryRun = this.d.config.isDryRun();
    if (!upload || (!dryRun && !upload.webViewLink)) {
      throw new ActionError(409, 'not_uploaded', 'Upload this build to Drive first.');
    }
    const number = repo.qa.whatsapp;
    if (!number) {
      throw new ActionError(
        422,
        'qa_not_configured',
        `${repo.name} has no QA WhatsApp number. Set it under Settings.`,
      );
    }

    let message = renderTemplate(repo.qa.template, {
      qa: repo.qa.name ?? 'QA',
      repo: repo.name,
      version: job.version ?? result.version ?? '(no version)',
      drive: upload.webViewLink ?? NO_DRIVE_LINK,
      changes: formatChanges(this.changesFor(job, repo)),
    });
    const artifact = this.apkOf(result);
    if (options.includeLocalLink && artifact) {
      message += `\nLocal: ${options.localOrigin}${apkDownloadPath(job.repoId, artifact.fileName)}`;
    }
    const answer: ShareResult = {
      dryRun,
      message,
      whatsappUrl: whatsappUrl(number, message),
      linkAccess: upload.linkAccess,
    };
    await guardedWrite(this.guard, {
      actor: 'user',
      action: 'qa.share',
      targetType: 'build',
      targetId: jobId,
      // Reached only from the user's click on "Send to QA". The link is built, not sent.
      confirmed: true,
      after: {
        qa: repo.qa.name ?? null,
        version: job.version,
        includeLocalLink: options.includeLocalLink,
      },
      simulated: answer,
      run: () => Promise.resolve(answer),
    });
    // That the link was asked for, which is all anyone here can know: only the human sees whether it was sent.
    if (!dryRun) {
      // On the build too: a build started by hand has no release above it, and the notification center reads this.
      this.d.jobs.mergeState(job.id, { qaLinkOpenedAt: this.now() });
      this.emitJob(job.id);
      if (job.parentJobId) {
        this.d.jobs.mergeState(job.parentJobId, { qaLinkOpenedAt: this.now() });
        this.emitJob(job.parentJobId);
      }
    }
    return answer;
  }

  /** Stops uploads in progress. Their jobs record the failure, so call before the DB closes. */
  async close(): Promise<void> {
    const active = [...this.uploads.values()];
    for (const upload of active) upload.abort.abort();
    await Promise.all(active.map((upload) => upload.finished));
  }

  // ───────────────────────────── Internals ─────────────────────────────

  private async runUpload(
    job: Job,
    result: BuildResult,
    artifact: BuildArtifact | null,
    folderId: string,
    active: ActiveUpload,
    guard: GuardedWriteDeps,
  ): Promise<BuildUpload> {
    const simulated: BuildUpload = {
      dryRun: true,
      fileId: null,
      webViewLink: null,
      fileName: artifact?.fileName ?? '(dry run: nothing built)',
      sizeBytes: artifact?.sizeBytes ?? 0,
      linkAccess: 'simulated',
      at: this.now(),
    };
    try {
      const out = await guardedWrite<BuildUpload>(guard, {
        actor: 'user',
        action: 'drive.upload',
        targetType: 'build',
        targetId: job.id,
        // Reached only from the user's click on "Upload to Drive", or on a release's Start (`releaseJobId` then says which).
        confirmed: true,
        before: {
          fileName: simulated.fileName,
          sizeBytes: simulated.sizeBytes,
          folderId,
          releaseJobId: job.parentJobId,
        },
        after: simulated,
        afterResult: (uploaded) => uploaded,
        simulated,
        run: () => {
          // The dry-run setting was off when this started, and `artifact` was then required. It may have flipped since.
          if (!artifact) throw new ActionError(409, 'no_artifact', 'This build made no APK.');
          return this.d.drive.upload({
            job,
            result,
            artifact: this.checkedArtifact(job, artifact),
            folderId,
            signal: active.abort.signal,
            now: this.now(),
            onProgress: (sentBytes, totalBytes) => {
              active.sentBytes = sentBytes;
              active.totalBytes = totalBytes;
              this.d.bus.emit({ type: 'build.upload', jobId: job.id, sentBytes, totalBytes });
            },
          });
        },
      });
      const upload = out.result ?? simulated;
      this.d.jobs.mergeState(job.id, { upload, uploadError: null });
      if (!out.dryRun) this.afterRealUpload(job);
      return upload;
    } catch (e) {
      const text = e instanceof ActionError ? e.message : UPLOAD_FAILED;
      this.d.log.warn(
        { jobId: job.id, err: (e as Error).name, code: e instanceof ActionError ? e.code : null },
        'upload failed',
      );
      this.d.jobs.mergeState(job.id, { uploadError: text });
      throw e;
    }
  }

  /**
   * Neither step may fail an upload that worked: the notifier and `cleanAfterUpload` do not throw. The clean is not waited
   * for, as it can take minutes and the upload is over. A build queued meanwhile waits for it.
   */
  private afterRealUpload(job: Job): void {
    this.d.notifier.notifyUploaded({
      jobId: job.id,
      repoId: job.repoId,
      repoName: this.d.config.getRepo(job.repoId)?.name ?? job.repoId,
      version: job.version,
    });
    void this.d.builds.cleanAfterUpload(job.repoId, job.parentJobId);
  }

  /** Every entry point starts here, so the hard rule cannot be skipped. */
  private shareableBuild(jobId: string): { job: Job; result: BuildResult } {
    const job = this.d.builds.job(jobId);
    if (!job) throw new ActionError(404, 'job_not_found', 'Unknown build');
    const result = job.status === 'succeeded' ? this.d.builds.result(jobId) : null;
    if (!result) {
      throw new ActionError(409, 'build_not_finished', 'This build has not succeeded');
    }
    assertStagingOnly(job, result);
    return { job, result };
  }

  private repoOf(job: Job): RepoConfig {
    const repo = this.d.config.getRepo(job.repoId);
    if (!repo) throw new ActionError(404, 'repo_not_found', 'Unknown repo');
    return repo;
  }

  private apkOf(result: BuildResult): BuildArtifact | null {
    return result.artifacts.find((artifact) => artifact.kind === 'apk') ?? null;
  }

  /** The stored path must be where the queue keeps this repo's files. */
  private checkedArtifact(job: Job, artifact: BuildArtifact): BuildArtifact {
    if (artifact.path !== join(this.d.builds.apksDir, job.repoId, artifact.fileName)) {
      throw new ActionError(
        409,
        'artifact_changed',
        `${artifact.fileName} is not where builds are kept. Build it again.`,
      );
    }
    return artifact;
  }

  private storedUpload(job: Job): BuildUpload | null {
    const parsed = BuildUploadSchema.safeParse(job.state.upload);
    return parsed.success ? parsed.data : null;
  }

  /**
   * The pending cards' titles and Notion links, as they are now. A version bump empties that list, so a build
   * from a release carries what was noted before the bump, in `state.qaChanges`. A release noted before links were kept
   * has no link there, so those come from its cards.
   */
  private changesFor(job: Job, repo: RepoConfig): QaChange[] {
    const noted = job.state.qaChanges;
    if (Array.isArray(noted)) {
      const links = this.releaseLinks(job);
      return noted.flatMap((entry): QaChange[] => {
        const parsed = QaChangeSchema.safeParse(
          typeof entry === 'string' ? { title: entry, url: null } : entry,
        );
        if (!parsed.success) return [];
        const { title, url } = parsed.data;
        return [{ title, url: url ?? links.get(title) ?? null }];
      });
    }
    const [pending] = buildPendingReleases(
      this.d.store,
      [repo],
      this.d.config.getGlobalStored(),
      this.now(),
    );
    return pending?.pendingCards.map(({ title, url }) => ({ title, url })) ?? [];
  }

  /** Title -> Notion link of the cards noted by this build's release. */
  private releaseLinks(job: Job): Map<string, string> {
    const release = job.parentJobId ? this.d.jobs.get(job.parentJobId) : null;
    const links = new Map<string, string>();
    for (const { cardId, title } of release ? notedCards(release.state) : []) {
      const url = getCard(this.d.store, cardId)?.url;
      if (url) links.set(title, url);
    }
    return links;
  }

  private emitJob(jobId: string): void {
    const job = this.d.jobs.get(jobId);
    if (job) {
      this.d.bus.emit({
        type: 'job.updated',
        jobId,
        status: job.status,
        currentStep: job.currentStep,
      });
    }
  }
}
