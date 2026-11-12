import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BuildResultSchema,
  isSafeBranchName,
  type PreviewMr,
  type BuildArtifact,
  type BuildMode,
  type BuildResult,
  type FlavorDetection,
  type Job,
  type JobMode,
  type Json,
  type RepoConfig,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import type { CloneManager } from './cloneManager';
import {
  artifactFileName,
  assertRequestedFlavor,
  buildCommands,
  BuildError,
  collectArtifact,
  decideFlavor,
  flavorChoiceRequired,
  flutterInvocation,
  listEntrypoints,
  readBuildIdentity,
} from './flutterBuild';
import { GitExecError, type GitExec } from './gitExec';
import { bumpPubspecText, computeVersion, readPubspecVersion } from './versionCalc';
import { BUILD_STEP, LOG_MAX_CHARS, type JobStore } from './jobStore';

/**
 * One build at a time across all repos, first in first out, with a whole-job timeout and a cancel that kills the
 * process group. The queue lives in memory: after a restart, what was queued or running is failed, not restarted.
 *
 * A standalone build syncs the clone to the base branch first. A build with a parent release builds the clone as that
 * release left it, because a sync could move past the commit it just tagged. PTY releases build through `frm` and are
 * never parents here.
 *
 * Signing: `gitExec` hides secret-named variables from every child. The names in `BUILD_PASS_ENV` are added back for
 * build commands only, from this process's environment, and their values are redacted from the output. The list comes
 * from `.env` alone, so nothing reachable through the API can widen it.
 *
 * In a dry run nothing is built: the commands are logged and the result has no artifacts.
 */

const CLEAN_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_WAIT_MS = 10_000;
const PERSIST_MS = 1_000;
const BUFFER_MAX_CHARS = 2 * 1024 * 1024;
const INTERRUPTED_MESSAGE =
  'Interrupted by a server restart. Check that no flutter process is left over, then start the build again.';

export interface BuildQueueDeps {
  config: ConfigStore;
  jobs: JobStore;
  git: GitExec;
  /** The release engine's instance: its per-repo queue keeps clone operations apart. */
  clones: CloneManager;
  log: Logger;
  bus?: EventBus;
  /** `data/apks`. */
  apksDir: string;
  timeoutMs: number;
  /** Variable names from `BUILD_PASS_ENV`. */
  passEnv: readonly string[];
  /** Where the values of `passEnv` come from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface EnqueueBuildInput {
  repoId: string;
  /** Stored on the job and the result, for the share rule. */
  mode: JobMode;
  /** Required for `custom`, which has no commands of its own: pass the release's `state.releaseMode`. */
  buildMode?: BuildMode;
  /** The user's choice after `flavor_choice_required`. */
  flavor?: string | null;
  parentJobId?: string | null;
  /** A release's own flag: its build must not be real when the release is simulated, whatever the setting says now. */
  dryRun?: boolean;
  /** The QA message's `{changes}`, noted before a version bump emptied the pending list. */
  qaChanges?: readonly QaChange[];
  /**
   * QA preview: these open MRs are merged, in this order, into the synced clone, and pubspec gets the next staging version.
   * All local: nothing is committed, pushed or tagged, and the next sync puts the clone back. Staging, standalone only.
   */
  integration?: readonly PreviewMr[];
}

/** One line of the QA message: a card and its Notion link, when it has one. */
export type QaChange = { title: string; url: string | null };

export type BuildLogEvent = { kind: 'line'; seq: number; line: string } | { kind: 'end' };

interface LogLine {
  seq: number;
  line: string;
}

interface Run {
  jobId: string;
  abort: AbortController;
  timedOut: boolean;
  lines: LogLine[];
  lineChars: number;
  seq: number;
  unpersisted: string;
  listeners: Set<(e: BuildLogEvent) => void>;
  finished: Promise<void>;
  markFinished: () => void;
}

function integrationOf(job: Job): PreviewMr[] {
  const raw = job.state.integration;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const o = m as Record<string, Json> | null;
    return o &&
      typeof o.iid === 'number' &&
      typeof o.branch === 'string' &&
      isSafeBranchName(o.branch)
      ? [{ iid: o.iid, branch: o.branch, title: typeof o.title === 'string' ? o.title : '' }]
      : [];
  });
}

function buildModeOf(mode: JobMode, buildMode: BuildMode | undefined): BuildMode {
  if (mode !== 'custom') {
    if (buildMode !== undefined && buildMode !== mode) {
      throw new BuildError('invalid_build_mode', 'The build mode must match', undefined, 422);
    }
    return mode;
  }
  if (!buildMode) {
    throw new BuildError('invalid_build_mode', 'A custom build needs a build mode', undefined, 422);
  }
  return buildMode;
}

/** The same rule as `CloneManager`: an empty directory is not a clone yet. */
const hasNoClone = (path: string) =>
  readdir(path).then(
    (entries) => entries.length === 0,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return true;
      throw e;
    },
  );

export class BuildQueue {
  private readonly runs = new Map<string, Run>();
  private readonly waiting: string[] = [];
  private readonly cleaning = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private current: Run | null = null;
  private closing = false;

  constructor(private readonly d: BuildQueueDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Call at boot, before accepting requests. */
  recoverInterrupted(): number {
    const ids = this.d.jobs.failInterruptedBuilds(INTERRUPTED_MESSAGE);
    for (const id of ids) this.emitJob(id);
    return ids.length;
  }

  /** What a build would use now, from the clone as it is. Null flavor: ask the user. Null result: no clone yet. */
  async detectFlavor(
    repoId: string,
    buildMode: BuildMode,
    requested: string | null = null,
  ): Promise<FlavorDetection | null> {
    const repo = this.repoOf(repoId);
    const clonePath = this.d.git.clonePath(repoId);
    if (await hasNoClone(clonePath)) return null;
    return decideFlavor({
      buildMode,
      requested,
      configured: repo.flutter.stagingFlavor,
      entrypoints: await listEntrypoints(clonePath),
    });
  }

  /**
   * Queues a build. Throws `flavor_choice_required` (details: the detection) when the clone shows the choice is needed.
   * With no clone yet, that can only be found out when the job runs, and then fails the job with the same code.
   */
  async enqueue(input: EnqueueBuildInput): Promise<Job> {
    if (this.closing) throw new BuildError('shutting_down', 'The server is shutting down');
    const buildMode = buildModeOf(input.mode, input.buildMode);
    const requested = input.flavor ?? null;
    assertRequestedFlavor(buildMode, requested);
    const detection = await this.detectFlavor(input.repoId, buildMode, requested);
    if (detection && detection.flavor === null) throw flavorChoiceRequired(detection);

    if (input.integration) {
      if (input.mode !== 'staging' || input.parentJobId) {
        throw new BuildError(
          'invalid_build_mode',
          'A QA preview is a standalone staging build',
          undefined,
          422,
        );
      }
      if (
        input.integration.length === 0 ||
        !input.integration.every((m) => isSafeBranchName(m.branch))
      ) {
        throw new BuildError('invalid_integration', 'The MR list cannot be used', undefined, 422);
      }
    }
    const state: Record<string, Json> = { buildMode };
    if (input.integration) state.integration = input.integration.map((m) => ({ ...m }));
    if (requested !== null) state.requestedFlavor = requested;
    if (input.qaChanges) state.qaChanges = [...input.qaChanges];
    const job = this.d.jobs.createBuild({
      repoId: input.repoId,
      mode: input.mode,
      dryRun: input.dryRun === true || this.d.config.isDryRun(),
      flavor: requested,
      state,
      parentJobId: input.parentJobId ?? null,
    });
    this.runs.set(job.id, this.newRun(job));
    this.waiting.push(job.id);
    this.emitJob(job.id);
    this.pump();
    return job;
  }

  /** A queued job ends here. A running one is killed, and ends when its processes have stopped. */
  cancel(jobId: string): Job {
    const job = this.d.jobs.get(jobId);
    if (job?.kind !== 'build') throw new ActionError(404, 'job_not_found', 'Unknown build');
    const run = this.runs.get(jobId);
    if (!run) throw new BuildError('build_not_active', 'This build is not queued or running');
    const at = this.waiting.indexOf(jobId);
    if (at !== -1) {
      this.waiting.splice(at, 1);
      this.d.jobs.cancel(jobId, 'Cancelled', null);
      this.end(run);
    } else if (!run.abort.signal.aborted) {
      this.note(run, 'Cancel requested');
      run.abort.abort();
    }
    this.emitJob(jobId);
    return this.d.jobs.get(jobId) ?? job;
  }

  cancelling(jobId: string): boolean {
    return this.runs.get(jobId)?.abort.signal.aborted ?? false;
  }

  /** The running job, then the waiting ones in order. */
  status(): { runningJobId: string | null; queuedJobIds: string[] } {
    return { runningJobId: this.current?.jobId ?? null, queuedJobIds: [...this.waiting] };
  }

  /** Settles when the job has ended, for any reason. Never rejects. Read the job or `result` afterwards. */
  whenFinished(jobId: string): Promise<void> {
    return this.runs.get(jobId)?.finished ?? Promise.resolve();
  }

  /** Null until the job has succeeded. */
  result(jobId: string): BuildResult | null {
    const output = this.d.jobs.steps(jobId).find((step) => step.name === BUILD_STEP)?.output;
    const parsed = BuildResultSchema.safeParse(output);
    return parsed.success ? parsed.data : null;
  }

  /** The job, when it is a build. */
  job(jobId: string): Job | null {
    const job = this.d.jobs.get(jobId);
    return job?.kind === 'build' ? job : null;
  }

  /** Newest first. */
  list(limit: number): Job[] {
    return this.d.jobs.listBuilds(limit);
  }

  /** Where artifacts are kept: `<apksDir>/<repo>/<fileName>`. */
  get apksDir(): string {
    return this.d.apksDir;
  }

  /**
   * The log kept in `job_steps`. While `truncated` is false, a line's index + 1 is its sequence number, because every
   * published line is stored with one `\n` and holds none itself. A cut log starts mid-line, so that first piece is dropped.
   * A log of exactly the cap also reads as truncated: only the column's length is known.
   */
  storedLog(jobId: string): { lines: string[]; truncated: boolean } {
    const text = this.d.jobs.steps(jobId).find((step) => step.name === BUILD_STEP)?.log ?? '';
    const truncated = text.length >= LOG_MAX_CHARS;
    const lines = text.split('\n');
    lines.pop();
    if (truncated) lines.shift();
    return { lines, truncated };
  }

  /**
   * For the log stream: the lines after `afterSeq`, then live events. Null when the job is not queued or running:
   * the log in `job_steps` is then all there is. Replay and subscribe happen in one synchronous block.
   */
  attach(
    jobId: string,
    afterSeq: number,
    listener: (e: BuildLogEvent) => void,
  ): { backlog: LogLine[]; dropped: boolean; detach: () => void } | null {
    const run = this.runs.get(jobId);
    if (!run) return null;
    const first = run.lines[0];
    run.listeners.add(listener);
    return {
      backlog: run.lines.filter((l) => l.seq > afterSeq),
      dropped: first !== undefined && first.seq > afterSeq + 1,
      detach: () => run.listeners.delete(listener),
    };
  }

  /**
   * `cleanAfterUpload`: for the upload step to call, once the file is safe, since uploads read the `data/apks`
   * copy. Skipped when the toggle is off, in a dry run, with another build of the repo due (that one reuses `build/`), or
   * while a release other than `ownerReleaseId` is using the clone. Never throws: a failed clean must not fail an upload
   * that worked.
   */
  async cleanAfterUpload(
    repoId: string,
    ownerReleaseId: string | null = null,
  ): Promise<{ cleaned: boolean; reason: string | null }> {
    const repo = this.d.config.getRepo(repoId);
    if (!repo?.flutter.cleanAfterUpload) return { cleaned: false, reason: 'off' };
    if (this.d.config.isDryRun()) return { cleaned: false, reason: 'dry_run' };
    if (this.d.jobs.activeBuild(repoId)) return { cleaned: false, reason: 'build_active' };
    const release = this.d.jobs.activeRelease(repoId);
    if (release && release.id !== ownerReleaseId) {
      return { cleaned: false, reason: 'release_active' };
    }
    if (this.cleaning.has(repoId)) return { cleaned: false, reason: 'already_cleaning' };

    const { command, args } = flutterInvocation(repo.flutter.useFvm, ['clean']);
    const cleaning = this.d.git.run(repoId, command, args, {
      timeoutMs: CLEAN_TIMEOUT_MS,
      secrets: repo.gitlab.token ? [repo.gitlab.token] : [],
    });
    this.cleaning.set(
      repoId,
      cleaning.catch(() => undefined),
    );
    try {
      await cleaning;
      return { cleaned: true, reason: null };
    } catch (e) {
      this.d.log.warn({ repoId, reason: (e as Error).message }, 'flutter clean failed');
      return { cleaned: false, reason: 'failed' };
    } finally {
      this.cleaning.delete(repoId);
    }
  }

  /** Shutdown: waiting jobs and the running one are recorded as interrupted, and the running one is killed. */
  async close(): Promise<void> {
    this.closing = true;
    for (const jobId of this.waiting.splice(0)) {
      const run = this.runs.get(jobId);
      this.d.jobs.failStep(jobId, BUILD_STEP, INTERRUPTED_MESSAGE);
      if (run) this.end(run);
    }
    const current = this.current;
    if (!current) return;
    current.abort.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      current.finished,
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  // ───────────────────────────── The queue ─────────────────────────────

  private pump(): void {
    if (this.current || this.closing) return;
    const jobId = this.waiting.shift();
    if (jobId === undefined) return;
    const run = this.runs.get(jobId);
    if (!run) return this.pump();
    this.current = run;
    void this.execute(run)
      .catch((e: unknown) => {
        // A bookkeeping failure, such as the repo being deleted with its jobs. The next job must still get its turn.
        this.d.log.error({ jobId, reason: (e as Error).message }, 'build stopped abnormally');
      })
      .finally(() => {
        this.end(run);
        this.current = null;
        this.emitJob(jobId);
        this.pump();
      });
  }

  private async execute(run: Run): Promise<void> {
    const { jobId } = run;
    if (!this.d.jobs.startBuild(jobId)) return;
    this.d.jobs.beginStep(jobId, BUILD_STEP);
    this.emitJob(jobId);

    const timer = setTimeout(() => {
      run.timedOut = true;
      run.abort.abort();
    }, this.d.timeoutMs);
    const persister = setInterval(() => this.persist(run), PERSIST_MS);
    try {
      const result = await this.work(run);
      this.throwIfStopped(run);
      this.persist(run);
      this.d.jobs.finishStep(jobId, BUILD_STEP, {
        output: result,
        // dryRun too: switched on while it waited, this job built nothing, and release facts read this column.
        job: { version: result.version, flavor: result.flavor, dryRun: result.dryRun },
      });
      this.d.jobs.succeed(jobId);
    } catch (e) {
      this.persist(run);
      this.settleFailure(run, e);
    } finally {
      clearTimeout(timer);
      clearInterval(persister);
    }
  }

  /** A stop decides over whatever error the kill caused. */
  private settleFailure(run: Run, e: unknown): void {
    const { jobId } = run;
    if (this.closing) {
      this.d.jobs.failStep(jobId, BUILD_STEP, INTERRUPTED_MESSAGE);
    } else if (run.timedOut) {
      const minutes = Math.round(this.d.timeoutMs / 60_000);
      this.d.jobs.failStep(jobId, BUILD_STEP, `timeout: the build passed its ${minutes} min limit`);
    } else if (run.abort.signal.aborted) {
      this.d.jobs.cancel(jobId, 'Cancelled', null);
    } else {
      const text = e instanceof ActionError ? `${e.code}: ${e.message}` : (e as Error).message;
      this.d.log.warn({ jobId, reason: text }, 'build failed');
      this.d.jobs.failStep(jobId, BUILD_STEP, text);
    }
  }

  private throwIfStopped(run: Run): void {
    if (run.abort.signal.aborted) throw new GitExecError('cancelled', 'The build was stopped');
  }

  private async work(run: Run): Promise<BuildResult & Record<string, Json>> {
    const job = this.d.jobs.get(run.jobId);
    if (!job) throw new Error('The build job is gone');
    const repo = this.repoOf(job.repoId);
    const buildMode = job.state.buildMode === 'prod' ? 'prod' : 'staging';
    const requested =
      typeof job.state.requestedFlavor === 'string' ? job.state.requestedFlavor : null;
    // Switched on while waiting, it holds. Switched off, a job asked for as a dry run stays one.
    const dryRun = job.dryRun || this.d.config.isDryRun();
    const clonePath = this.d.git.clonePath(repo.id);
    const { signal } = run.abort;

    await this.cleaning.get(repo.id);
    this.assertCloneIsOurs(job);

    if (dryRun && (await hasNoClone(clonePath))) {
      this.note(run, 'Dry run: this repo has no clone yet, so nothing can be read from it');
      return {
        mode: job.mode,
        buildMode,
        flavor: requested,
        version: null,
        commands: [],
        artifacts: [],
        dryRun,
      };
    }

    if (!dryRun && job.parentJobId === null) {
      this.note(run, `Syncing the bot clone of ${repo.id} to ${repo.baseBranch}`);
      await this.d.clones.ensureClone(repo, { signal });
      await this.d.clones.sync(repo, { signal });
    }
    this.throwIfStopped(run);

    const integration = integrationOf(job);
    if (integration.length > 0) await this.integrate(run, repo.id, clonePath, integration, dryRun);
    this.throwIfStopped(run);

    const detection = decideFlavor({
      buildMode,
      requested,
      configured: repo.flutter.stagingFlavor,
      entrypoints: await listEntrypoints(clonePath),
    });
    if (detection.flavor === null) throw flavorChoiceRequired(detection);
    const { flavor } = detection;
    const { appName, version } = await readBuildIdentity(clonePath, repo.flutter.appName);
    this.note(run, `Flavor ${flavor} (${detection.reason}), version ${version}`);

    const commands = buildCommands(buildMode, flavor);
    const shown: string[] = [];
    const artifacts: BuildArtifact[] = [];
    const deadline = this.now() + this.d.timeoutMs;
    const { env, secrets } = this.signingEnv(repo, run);

    for (const step of commands) {
      const { command, args } = flutterInvocation(repo.flutter.useFvm, step.flutterArgs);
      const display = [command, ...args].join(' ');
      shown.push(display);
      if (dryRun) {
        this.note(run, `Dry run: would run ${display}`);
        continue;
      }
      this.note(run, `Running: ${display}`);
      await this.d.git.stream(repo.id, command, args, {
        timeoutMs: Math.max(1, deadline - this.now()),
        signal,
        secrets,
        env,
        onLine: (line) => this.publish(run, line),
      });
      this.throwIfStopped(run);
      const artifact = await collectArtifact({
        clonePath,
        apksDir: this.d.apksDir,
        repoId: repo.id,
        command: step,
        fileName: artifactFileName(appName, flavor, version, step.kind),
      });
      artifacts.push(artifact);
      this.note(run, `Saved ${artifact.fileName} (${artifact.sizeBytes} bytes)`);
    }

    return {
      mode: job.mode,
      buildMode,
      flavor,
      version,
      commands: shown,
      artifacts,
      dryRun,
    };
  }

  /**
   * QA preview: merge each MR's branch (already fetched by the sync) with `--no-ff`, then bump pubspec's version as a
   * staging release would. On a conflict the merge is aborted and the build fails: a partial preview would mislead QA.
   */
  private async integrate(
    run: Run,
    repoId: string,
    clonePath: string,
    mrs: readonly PreviewMr[],
    dryRun: boolean,
  ): Promise<void> {
    const { signal } = run.abort;
    if (dryRun) {
      for (const m of mrs) this.note(run, `Dry run: would merge !${m.iid} ${m.branch}`);
      this.note(run, 'Dry run: would bump the staging version in pubspec.yaml (local only)');
      return;
    }
    const git = (args: string[], allowFailure = false) =>
      this.d.git.run(repoId, 'git', args, { signal, allowFailure });
    await git(['config', '--local', 'user.name', 'relay']);
    await git(['config', '--local', 'user.email', 'relay@localhost']);
    for (const m of mrs) {
      const ref = `origin/${m.branch}`;
      const exists = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
      if (exists.exitCode !== 0) {
        throw new BuildError(
          'integration_branch_missing',
          `!${m.iid} ${m.branch} is not on origin any more. Refresh the list and pick again.`,
        );
      }
      this.note(run, `Merging !${m.iid} ${m.branch}`);
      const merged = await git(['merge', '--no-ff', '--no-edit', ref], true);
      if (merged.exitCode !== 0) {
        const status = await git(['status', '--porcelain'], true);
        const files = status.stdout
          .split('\n')
          .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
          .map((l) => l.slice(3));
        await git(['merge', '--abort'], true);
        throw new BuildError(
          'integration_conflict',
          `!${m.iid} ${m.branch} conflicts with the base and the MRs before it` +
            (files.length > 0 ? `: ${files.slice(0, 10).join(', ')}` : '') +
            '. Nothing was built.',
        );
      }
    }
    const path = join(clonePath, 'pubspec.yaml');
    const text = await readFile(path, 'utf8').catch(() => {
      throw new BuildError('pubspec_missing', 'Cannot read pubspec.yaml in the clone');
    });
    const current = readPubspecVersion(text);
    if (!current) {
      throw new BuildError('pubspec_version_invalid', 'pubspec.yaml has no usable version');
    }
    const plan = computeVersion({ mode: 'staging', current });
    await writeFile(path, bumpPubspecText(text, current, plan.newVersion));
    this.note(run, `Merged ${mrs.length} MR(s). Local version ${current} -> ${plan.newVersion}`);
  }

  /** Checked again at its turn: creation refused other releases, but the parent may have ended while this waited. */
  private assertCloneIsOurs(job: Job): void {
    const active = this.d.jobs.activeRelease(job.repoId);
    if (job.parentJobId === null ? active !== null : active?.id !== job.parentJobId) {
      throw new BuildError(
        job.parentJobId === null ? 'release_active' : 'parent_not_active',
        job.parentJobId === null
          ? `A release of ${job.repoId} is using its clone`
          : 'The release of this build is no longer active',
      );
    }
  }

  private signingEnv(
    repo: RepoConfig,
    run: Run,
  ): { env: Record<string, string>; secrets: string[] } {
    const source = this.d.env ?? process.env;
    const env: Record<string, string> = {};
    for (const name of this.d.passEnv) {
      const value = source[name];
      if (value === undefined) this.note(run, `BUILD_PASS_ENV names ${name}, which is not set`);
      else env[name] = value;
    }
    const secrets = [...Object.values(env), ...(repo.gitlab.token ? [repo.gitlab.token] : [])];
    return { env, secrets };
  }

  private repoOf(repoId: string): RepoConfig {
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new ActionError(404, 'repo_not_found', 'Unknown repo');
    return repo;
  }

  // ───────────────────────────── Run bookkeeping ─────────────────────────────

  private newRun(job: Job): Run {
    let markFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    return {
      jobId: job.id,
      abort: new AbortController(),
      timedOut: false,
      lines: [],
      lineChars: 0,
      seq: 0,
      unpersisted: '',
      listeners: new Set(),
      finished,
      markFinished,
    };
  }

  /** Lines from the dashboard itself, set apart from what flutter wrote. */
  private note(run: Run, line: string): void {
    this.publish(run, `[dashboard] ${line}`);
  }

  /** `line` is already redacted, or the dashboard's own text. */
  private publish(run: Run, line: string): void {
    run.seq += 1;
    const entry = { seq: run.seq, line };
    run.lines.push(entry);
    run.lineChars += line.length;
    while (run.lineChars > BUFFER_MAX_CHARS && run.lines.length > 1) {
      run.lineChars -= run.lines.shift()?.line.length ?? 0;
    }
    run.unpersisted += `${line}\n`;
    for (const listener of run.listeners) listener({ kind: 'line', ...entry });
  }

  private persist(run: Run): void {
    if (run.unpersisted === '') return;
    const text = run.unpersisted;
    run.unpersisted = '';
    try {
      this.d.jobs.appendRawLog(run.jobId, BUILD_STEP, text);
    } catch (e) {
      this.d.log.warn(
        { jobId: run.jobId, reason: (e as Error).message },
        'could not store build output',
      );
    }
  }

  private end(run: Run): void {
    if (this.runs.get(run.jobId) !== run) return;
    this.persist(run);
    this.runs.delete(run.jobId);
    for (const listener of [...run.listeners]) listener({ kind: 'end' });
    run.listeners.clear();
    run.markFinished();
  }

  private emitJob(jobId: string): void {
    const job = this.d.jobs.get(jobId);
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
