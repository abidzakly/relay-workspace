import type {
  Engine,
  Job,
  JobMode,
  JobStepName,
  Json,
  ReleaseJobView,
  RepoConfig,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { CloneManager } from './cloneManager';
import { guardedWrite } from './dryRun';
import { GitExec, redactSecrets, type GitExecOptions } from './gitExec';
import { GitlabMergeApi, readLiveMergeGate } from './gitlabMerge';
import type { MrFields } from './gitlabMr';
import { GitlabReleaseApi } from './gitlabRelease';
import { GitlabApiError, GitlabService } from './gitlabService';
import type { HttpClient } from './httpClient';
import { JobStore } from './jobStore';
import { mapGitlabError, mrTargetId } from './mrActions';
import { upsertMrSummaries } from './mrStore';
import { LocalPtyBackend, type PtyBackend } from './ptyBackend';
import type { ScriptConfigService } from './scriptConfig';
import { PTY_INTERRUPTED_MESSAGE, PtyEngine } from './ptyEngine';
import { notePending, notionOffer } from './releasePipeline';
import {
  assertVersionMrGate,
  assigneeOf,
  hookHandlers,
  RELEASE_STEPS,
  ReleaseError,
  requireCommitIdentity,
  type ReleaseHooks,
  type ReleaseWrite,
  type StepContext,
  type StepHandler,
} from './releaseSteps';
import {
  isValidVersionOverride,
  previewVersion,
  type ReleaseMode,
  type VersionPreview,
} from './versionCalc';

/**
 * The step runner of the release state machine. Steps run one at a time in `job_steps` order; each one's
 * result is committed before the next starts. A step without a handler (AWAIT_REVIEW) ends the run with the job `paused`
 * at it, until `continueRelease`.
 *
 * `start`, `continueRelease` and `resume` may only be called for a user's click: they reach `confirmed: true` writes.
 * Nothing here resumes by itself, not even after a restart.
 *
 * A cancel of a running job has two phases: the job stays `running`, and so keeps holding the repo's clone, until the
 * step in progress has really stopped. Its git command is killed; a merge already sent to GitLab is waited for.
 */

const INTERRUPTED_MESSAGE = 'Interrupted by a server restart. Resume to continue from this step.';
const CANCELLED_MESSAGE = 'Cancelled';
const CLOSE_WAIT_MS = 10_000;

export interface ReleaseEngineDeps {
  config: ConfigStore;
  store: AppDb;
  audit: AuditWriter;
  http: HttpClient;
  log: Logger;
  bus?: EventBus;
  git?: GitExec;
  clones?: CloneManager;
  /** Where the PTY engine runs vu. Default: node-pty on this machine. */
  ptyBackend?: PtyBackend;
  /** Release script settings (Settings > Repos > Release scripts). */
  scripts?: ScriptConfigService;
  now?: () => number;
  /** BUILD .. DONE. Default: placeholders that only log. `index.ts` plugs the real ones in with `useHooks`. */
  hooks?: ReleaseHooks;
}

export interface StartReleaseInput {
  mode: JobMode;
  /** The user's edit of the preview. Staging also takes a bare number (the alpha number); custom requires a version. */
  version?: string | null;
  /** Default: the engine set in Settings. */
  engine?: Engine | undefined;
}

export interface RunHandle {
  job: Job;
  /** Settles when this run stops, for any reason. Never rejects. */
  done: Promise<void>;
}

/** `custom` has no bump of its own: `vu`'s `-alpha` rule decides, the same one that later reads it back from the branch. */
function releaseModeOf(mode: JobMode, version: string | null | undefined): ReleaseMode {
  if (mode !== 'custom') return mode;
  if (!version || !isValidVersionOverride(version)) {
    throw new ActionError(422, 'invalid_version_override', 'A custom release needs a full version');
  }
  return version.includes('-alpha') ? 'staging' : 'prod';
}

interface ActiveRun {
  abort: AbortController;
  done: Promise<void>;
}

export class ReleaseEngine {
  readonly jobs: JobStore;
  readonly pty: PtyEngine;
  private readonly git: GitExec;
  private readonly clones: CloneManager;
  private readonly now: () => number;
  private readonly runs = new Map<string, ActiveRun>();
  private steps: Partial<Record<JobStepName, StepHandler>>;
  private closing = false;

  constructor(private readonly d: ReleaseEngineDeps) {
    this.now = d.now ?? Date.now;
    this.jobs = new JobStore(d.store, this.now);
    this.git = d.git ?? new GitExec({ log: d.log });
    this.clones = d.clones ?? new CloneManager(this.git);
    this.steps = { ...RELEASE_STEPS, ...hookHandlers(d.hooks) };
    this.pty = new PtyEngine({
      config: d.config,
      jobs: this.jobs,
      git: this.git,
      clones: this.clones,
      audit: d.audit,
      log: d.log,
      ...(d.bus ? { bus: d.bus } : {}),
      now: this.now,
      backend: d.ptyBackend ?? new LocalPtyBackend({ log: d.log }),
      ...(d.scripts ? { scripts: d.scripts } : {}),
    });
  }

  /** The build queue and share service need this engine's job store, so their hooks can only arrive after construction. */
  useHooks(hooks: ReleaseHooks): void {
    this.steps = { ...RELEASE_STEPS, ...hookHandlers(hooks) };
  }

  currentEngine(): Engine {
    return this.d.config.getGlobal().engine;
  }

  /** Call at boot, before accepting requests. */
  recoverInterrupted(): number {
    const ids = this.jobs.failInterrupted(INTERRUPTED_MESSAGE, PTY_INTERRUPTED_MESSAGE);
    for (const id of ids) this.emitJob(id);
    return ids.length;
  }

  /** What COMPUTE_VERSION would produce now, from the base branch on GitLab. A read: the clone is not touched. */
  async preview(repoId: string, input: StartReleaseInput): Promise<VersionPreview> {
    const repo = this.repoOf(repoId);
    // The form starts nothing without a preview, so this stops the release before it leaves a failed job.
    if ((input.engine ?? this.d.config.getGlobal().engine) !== 'pty') requireCommitIdentity(repo);
    const mode = releaseModeOf(input.mode, input.version);
    if (!this.d.config.getGlobal().gitlab.host) {
      throw new ReleaseError('gitlab_not_configured', 'GitLab host is not set');
    }
    let pubspecText: string;
    try {
      pubspecText = await this.gitlab(repoId).readRawFile('pubspec.yaml', repo.baseBranch);
    } catch (e) {
      if (e instanceof GitlabApiError && e.kind === 'not_found') {
        throw new ReleaseError('pubspec_missing', `Cannot find pubspec.yaml on ${repo.baseBranch}`);
      }
      return mapGitlabError(e);
    }
    return previewVersion({
      mode,
      pubspecText,
      versionBranchPrefix: repo.versionBranchPrefix,
      tagFormat: repo.tagFormat,
      override: input.version ?? null,
      now: new Date(this.now()),
    });
  }

  start(repoId: string, input: StartReleaseInput): RunHandle {
    const repo = this.repoOf(repoId);
    const engine = input.engine ?? this.d.config.getGlobal().engine;
    if (engine === 'pty') this.pty.assertStartable(repo);
    else requireCommitIdentity(repo);
    if (
      input.version &&
      !isValidVersionOverride(input.version) &&
      !(input.mode === 'staging' && /^[0-9]+$/.test(input.version))
    ) {
      throw new ActionError(
        422,
        'invalid_version_override',
        `Invalid version: ${input.version.slice(0, 100)}`,
      );
    }
    const global = this.d.config.getGlobal().gitlab;
    if (!global.host) throw new ReleaseError('gitlab_not_configured', 'GitLab host is not set');
    const assignee = assigneeOf(repo, global.myUsername);
    if (!assignee) {
      throw new ReleaseError(
        'assignee_missing',
        'Set the repo assignee or your GitLab username first',
      );
    }
    const state: Record<string, Json> = {
      releaseMode: releaseModeOf(input.mode, input.version),
      assignee,
      // A resumed step must not act on a base or prefix edited in Settings since the start.
      baseBranch: repo.baseBranch,
      versionBranchPrefix: repo.versionBranchPrefix,
    };
    if (input.version) state.override = input.version;
    if (engine !== 'pty') {
      Object.assign(state, this.notedPending(repo, state));
      // This click, with the form saying so, is the confirmation of the staging upload.
      if (input.mode === 'staging') state.uploadConfirmedAt = this.now();
    }
    const job = this.jobs.createRelease({
      repoId,
      mode: input.mode,
      dryRun: this.d.config.isDryRun(),
      state,
      engine,
    });
    this.emitJob(job.id);
    if (engine === 'pty') {
      return { job, done: this.pty.start(job, repo, input.version ?? null) };
    }
    return { job, done: this.launch(job.id) };
  }

  /** "Merge now": replaces `vu`'s press-Enter. A refused gate leaves the job paused. */
  async continueRelease(jobId: string): Promise<RunHandle> {
    const job = this.mustJob(jobId);
    if (job.engine === 'pty') {
      this.pty.pressEnter(job);
      return { job: this.mustJob(jobId), done: Promise.resolve() };
    }
    const notPaused = () =>
      new ReleaseError('job_not_paused', 'This release is not waiting for your review');
    if (job.status !== 'paused' || job.currentStep !== 'AWAIT_REVIEW') throw notPaused();
    const repo = this.repoOf(job.repoId);
    if (repo.requireVersionMrApproval && job.mrIid !== null) {
      const { gate } = await readLiveMergeGate(
        this.gitlab(job.repoId),
        repo,
        job.mrIid,
        this.now,
      ).catch(mapGitlabError);
      assertVersionMrGate(gate);
    }
    // Atomic: during the reads above a second click or a cancel may have got here first.
    if (!this.jobs.continueFromPause(jobId, 'AWAIT_REVIEW')) throw notPaused();
    this.jobs.mergeState(jobId, this.notedPending(repo, job.state));
    this.emitJob(jobId);
    return { job: this.mustJob(jobId), done: this.launch(jobId) };
  }

  /** Continues a failed or interrupted job at the step that did not finish. `vu`'s re-run after a failed merge lands here. */
  resume(jobId: string, input: { flavor?: string | undefined } = {}): RunHandle {
    const job = this.mustJob(jobId);
    if (job.engine === 'pty') {
      throw new ReleaseError(
        'job_not_resumable',
        'The PTY engine has no step-level resume. Start a new release: vu picks up an open version MR by itself.',
      );
    }
    if (this.jobs.latestRelease(job.repoId)?.id !== jobId) {
      throw new ReleaseError('job_superseded', 'A newer release of this repo was started');
    }
    // Before the merge a new start picks the open MR up. After it nothing would finish the tag, so resume must.
    if (job.status === 'cancelled' && !this.merged(jobId)) {
      throw new ReleaseError(
        'job_not_resumable',
        'This release was cancelled before its merge. Start a new one: it picks up any open MR.',
      );
    }
    const repo = this.repoOf(job.repoId);
    // Its steps reset and switch branches in the clone a build may be using.
    this.jobs.assertNoActiveBuild(job.repoId);
    if (this.runs.has(jobId) || !this.jobs.reopen(jobId)) {
      throw new ReleaseError('job_not_resumable', 'Only a failed job can be resumed');
    }
    const patch: Record<string, Json> = {};
    if (input.flavor) Object.assign(patch, { buildFlavor: input.flavor, flavorChoice: null });
    // A job started before the pipeline was wired never said it would upload. This click does, and the step's error said so.
    if (job.mode === 'staging' && typeof job.state.uploadConfirmedAt !== 'number') {
      patch.uploadConfirmedAt = this.now();
    }
    // Before the merge, more MRs may have joined this release. After it the list is empty, and what was noted stands.
    if (!this.merged(jobId)) Object.assign(patch, this.notedPending(repo, job.state));
    this.jobs.mergeState(jobId, patch);
    this.emitJob(jobId);
    return { job: this.mustJob(jobId), done: this.launch(jobId) };
  }

  /**
   * Allowed at every step, and on a failed job. Nothing is undone, as in `vu` after a failed merge: an MR and branch stay
   * and the next start resumes them. See the class comment for a job that is running.
   */
  cancel(jobId: string): ReleaseJobView {
    const job = this.mustJob(jobId);
    // With no live process (it ended, or the server restarted) a PTY job is only a row, handled below.
    if (this.pty.cancel(jobId)) return this.view(jobId);
    const run = this.runs.get(jobId);
    if (run && job.status === 'running') {
      if (!run.abort.signal.aborted) {
        this.logLine(jobId, job.currentStep ?? 'PREFLIGHT', 'Cancel requested');
        run.abort.abort();
      }
      return this.view(jobId);
    }
    if (!this.finishCancelled(jobId)) {
      throw new ReleaseError('job_not_cancellable', `This release has already ${job.status}`);
    }
    return this.view(jobId);
  }

  view(jobId: string): ReleaseJobView {
    const job = this.mustJob(jobId);
    return {
      job,
      steps: this.jobs.steps(jobId),
      notion: notionOffer(this.d.store, this.d.config.getGlobalStored(), job),
      cancelling:
        (this.runs.get(jobId)?.abort.signal.aborted ?? false) || this.pty.cancelling(jobId),
      ptyPrompt: this.pty.promptOf(jobId),
    };
  }

  /** The pending cards as the cache has them now, added to those noted earlier. See `notePending`. */
  private notedPending(repo: RepoConfig, state: Record<string, Json>): Record<string, Json> {
    return notePending(this.d.store, repo, this.d.config.getGlobalStored(), state, this.now());
  }

  private mustJob(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new ActionError(404, 'job_not_found', 'Unknown job');
    return job;
  }

  private merged(jobId: string): boolean {
    return this.jobs.steps(jobId).some((s) => s.name === 'MERGE' && s.status === 'succeeded');
  }

  private finishCancelled(jobId: string): boolean {
    const steps = this.jobs.steps(jobId);
    const tagged = steps.some((s) => s.name === 'TAG' && s.status === 'succeeded');
    const note =
      this.merged(jobId) && !tagged
        ? 'Cancelled after the merge: the release is merged but not tagged. Resume to finish it.'
        : null;
    const ended = this.jobs.cancel(jobId, CANCELLED_MESSAGE, note);
    if (ended) this.emitJob(jobId);
    return ended;
  }

  /**
   * Shutdown: no new step starts. A step still running after the wait is cut off with the process, and its job is
   * picked up by `recoverInterrupted` at the next boot.
   */
  async close(): Promise<void> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...[...this.runs.values()].map((r) => r.done), this.pty.close()]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private launch(jobId: string): Promise<void> {
    const run: ActiveRun = { abort: new AbortController(), done: Promise.resolve() };
    run.done = this.runLoop(jobId, run.abort.signal)
      .catch((e: unknown) => {
        this.d.log.error({ jobId, reason: (e as Error).message }, 'release run stopped abnormally');
      })
      .finally(() => {
        if (this.runs.get(jobId) === run) this.runs.delete(jobId);
      });
    this.runs.set(jobId, run);
    return run.done;
  }

  private async runLoop(jobId: string, signal: AbortSignal): Promise<void> {
    while (!this.closing) {
      // Read each time: a deleted repo takes effect between steps.
      const job = this.jobs.get(jobId);
      if (job?.status !== 'running') return;
      const step = this.jobs.nextStep(jobId);
      if (!step) {
        this.jobs.succeed(jobId);
        this.emitJob(jobId);
        return;
      }
      if (signal.aborted) {
        this.finishCancelled(jobId);
        return;
      }
      const handler = this.steps[step.name];
      if (!handler) {
        this.logLine(jobId, step.name, this.pauseMessage(job));
        this.jobs.pauseAt(jobId, step.name);
        this.emitJob(jobId);
        return;
      }

      this.jobs.beginStep(jobId, step.name);
      this.emitJob(jobId);
      try {
        const result = await handler(this.contextOf(job, step.name, signal));
        this.jobs.finishStep(jobId, step.name, result);
      } catch (e) {
        const message = this.errorText(job.repoId, e);
        this.d.log.warn({ jobId, step: step.name, reason: message }, 'release step failed');
        this.logLine(jobId, step.name, `${signal.aborted ? 'STOPPED' : 'FAILED'}: ${message}`);
        if (signal.aborted) {
          this.finishCancelled(jobId);
          return;
        }
        this.jobs.failStep(jobId, step.name, message);
        this.emitJob(jobId);
        return;
      }
      this.emitJob(jobId);
    }
  }

  private pauseMessage(job: Job): string {
    const url = job.state.mrUrl;
    const where = typeof url === 'string' && url !== '' ? `: ${url}` : ' (simulated, no MR exists)';
    return `Waiting for your review${where}. "Merge now" continues.`;
  }

  private contextOf(job: Job, step: JobStepName, signal: AbortSignal): StepContext {
    const repo = this.repoOf(job.repoId);
    if (
      repo.baseBranch !== job.state.baseBranch ||
      repo.versionBranchPrefix !== job.state.versionBranchPrefix
    ) {
      throw new ReleaseError(
        'repo_config_changed',
        'The base branch or version prefix changed in Settings during this release',
      );
    }
    const host = this.d.config.getGlobal().gitlab.host;
    if (!host) throw new ReleaseError('gitlab_not_configured', 'GitLab host is not set');
    const secrets = [repo.gitlab.token];
    return {
      job,
      repo,
      dryRun: job.dryRun,
      gitlab: this.gitlab(repo.id),
      api: new GitlabReleaseApi(host, repo.gitlab.token, repo.gitlab.projectId, this.d.http),
      mergeApi: new GitlabMergeApi(host, repo.gitlab.token, repo.gitlab.projectId, this.d.http),
      clones: this.clones,
      clonePath: this.git.clonePath(repo.id),
      now: this.now,
      signal,
      log: (line: string) => this.logLine(job.id, step, redactSecrets(line, secrets)),
      git: (args: readonly string[], opts: GitExecOptions = {}) =>
        this.git.run(repo.id, 'git', args, { ...opts, secrets, signal }),
      write: <T>(op: ReleaseWrite<T>) => this.guarded(job, op),
      mrChanged: (mr: MrFields) => this.mrChanged(repo.id, mr),
    };
  }

  /**
   * The job's own flag decides, not the live toggle: a job must not be half real. Dry-run switched on during a live job
   * stops it at the next write (resume works once it is off again); switched off during a dry job, it stays simulated.
   */
  private async guarded<T>(job: Job, op: ReleaseWrite<T>): Promise<T | undefined> {
    if (!job.dryRun && this.d.config.isDryRun()) {
      throw new ReleaseError(
        'dry_run_switched_on',
        'Dry-run was switched on during this live release. Switch it off to resume, or start again.',
      );
    }
    const out = await guardedWrite<T>(
      {
        dryRun: { isDryRun: () => job.dryRun },
        audit: this.d.audit,
        log: this.d.log,
      },
      {
        actor: 'user',
        action: op.action,
        targetType: op.targetType,
        targetId: op.targetId,
        // Reached only from `start` / `continueRelease` / `resume`, which only a user's click calls.
        confirmed: true,
        before: op.before,
        after: op.after,
        ...(op.afterResult ? { afterResult: op.afterResult } : {}),
        run: op.run,
      },
    );
    return out.result;
  }

  /** The cache and the bus are extras here: the GitLab state is already settled, and the next sync would catch up anyway. */
  private mrChanged(repoId: string, mr: MrFields): void {
    try {
      upsertMrSummaries(this.d.store, repoId, [mr], this.now());
      this.d.bus?.emit({ type: 'mrs.changed', repoId, iids: [mr.iid] });
    } catch (e) {
      this.d.log.warn(
        { target: mrTargetId(repoId, mr.iid), reason: (e as Error).message },
        'could not refresh the merged MR in the cache',
      );
    }
  }

  private repoOf(repoId: string): RepoConfig {
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new ActionError(404, 'repo_not_found', 'Unknown repository');
    return repo;
  }

  private gitlab(repoId: string): GitlabService {
    return GitlabService.forRepo(this.d.config, repoId, {
      http: this.d.http,
      store: this.d.store,
      log: this.d.log,
      now: this.now,
    });
  }

  private errorText(repoId: string, e: unknown): string {
    const token = this.d.config.getRepo(repoId)?.gitlab.token;
    const text = e instanceof ActionError ? `${e.code}: ${e.message}` : (e as Error).message;
    return redactSecrets(text, token ? [token] : []);
  }

  private logLine(jobId: string, step: JobStepName, line: string): void {
    this.jobs.appendLog(jobId, step, line);
    this.d.bus?.emit({ type: 'job.log', jobId, step, line, at: this.now() });
  }

  private emitJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.d.bus?.emit({
        type: 'job.updated',
        jobId,
        status: job.status,
        currentStep: job.currentStep,
      });
    }
  }
}
