import {
  isSafeBranchName,
  type Job,
  type PtyPrompt,
  type ReleaseEngines,
  type RepoConfig,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import type { CloneManager } from './cloneManager';
import { gitAuthEnv, redactSecrets, type GitExec } from './gitExec';
import { PTY_STEP, type JobStore } from './jobStore';
import type { PtyBackend, PtyProcess } from './ptyBackend';
import type { ScriptConfigService } from './scriptConfig';
import { ReleaseError } from './releaseSteps';

/**
 * Option B: the real `vu` in a pseudo-terminal, in the repo's bot clone. The only command this file runs is
 * `~/bin/vu`, with the arguments from `vuArgs`, and the only input it ever sends is one carriage return at `vu`'s review
 * prompt. Any other prompt is shown and left unanswered, so nothing a user types can reach the process.
 *
 * Auth: `childEnv` strips secrets, so the repo's GitLab token is added back as `GITLAB_TOKEN` for this one process. glab
 * documents that variable as winning over stored credentials, `mrc` and `vu` run glab, and neither needs `--token` then.
 * It never goes on a command line, and every output chunk is redacted. A repo with no token falls back to the user's own
 * `glab auth login`.
 *
 * `vu` writes for real, so this engine refuses dry-run. It also cannot enforce the version MR gate, so it refuses a repo
 * that requires one.
 */

export const PTY_INTERRUPTED_MESSAGE =
  'Interrupted by a server restart, and vu died with it. There is no step-level resume: check the MR, then start a new release. An open version MR is picked up by vu. If it was already merged, the tag may be missing.';

const ENTER_PROMPT = 'Press Enter to continue: ';
const REVIEW_BANNER = 'Waiting for your review';
/** Looks like a question: a parenthesised or bracketed choice, or a trailing `:` or `?`. Only a hint for the UI. */
const OTHER_PROMPT_RE = /(?:\([^)]*\)|\[[^\]]*\]|\?|:)\s*$/;
const OTHER_PROMPT_IDLE_MS = 4_000;
const OTHER_PROMPT_MAX_CHARS = 200;
const IDLE_CHECK_MS = 2_000;
/** A partial line waits this long, so a secret split between two reads is still redacted as one. */
const PARTIAL_FLUSH_MS = 100;
const PARTIAL_MAX_CHARS = 4096;
const PERSIST_MS = 1_000;
const BUFFER_MAX_CHARS = 2 * 1024 * 1024;
const RECENT_MAX_CHARS = 4096;
const KILL_GRACE_MS = 5_000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\^_])/g;

/** `vu staging|prod -b <base> -y --no-notion-scan [--version <v>]`. The caller has validated base and version. */
export function vuArgs(input: {
  mode: 'staging' | 'prod';
  base: string;
  version: string | null;
}): string[] {
  return [
    input.mode,
    '-b',
    input.base,
    '-y',
    '--no-notion-scan',
    ...(input.version ? ['--version', input.version] : []),
  ];
}

export type PtyStreamEvent = { kind: 'output'; seq: number; data: string } | { kind: 'end' };

interface Chunk {
  seq: number;
  data: string;
}

interface Run {
  jobId: string;
  secrets: string[];
  abort: AbortController;
  closing: boolean;
  proc: PtyProcess | null;
  chunks: Chunk[];
  chunkChars: number;
  seq: number;
  listeners: Set<(e: PtyStreamEvent) => void>;
  /** Not yet redacted: the line in progress. */
  pending: string;
  unpersisted: string;
  /** ANSI-free tail of the output, for prompt detection. */
  recent: string;
  lastDataAt: number;
  prompt: PtyPrompt | null;
  enterSent: boolean;
  timers: NodeJS.Timeout[];
  partialTimer: NodeJS.Timeout | null;
  done: Promise<void>;
}

export interface PtyEngineDeps {
  config: ConfigStore;
  jobs: JobStore;
  git: GitExec;
  clones: CloneManager;
  audit: AuditWriter;
  log: Logger;
  bus?: EventBus;
  now: () => number;
  /** Where vu runs: node-pty on this machine, or the host agent when the dashboard is in Docker. */
  backend: PtyBackend;
  /** The release scripts' settings: checked before a run, passed as env during it. */
  scripts?: Pick<ScriptConfigService, 'envFor' | 'missing'>;
}

export class PtyEngine {
  private readonly runs = new Map<string, Run>();
  private closing = false;

  constructor(private readonly d: PtyEngineDeps) {}

  availability(): ReleaseEngines['pty'] {
    return this.d.backend.availability();
  }

  assertStartable(repo: RepoConfig): void {
    const { available, reason } = this.availability();
    if (!available) {
      throw new ReleaseError('engine_unavailable', `The PTY engine is unavailable: ${reason}`);
    }
    if (this.d.config.isDryRun()) {
      throw new ReleaseError(
        'pty_no_dry_run',
        'The PTY engine runs the real vu and cannot simulate. Turn dry-run off, or use the node engine.',
      );
    }
    if (repo.requireVersionMrApproval) {
      throw this.gateError();
    }
    if (!isSafeBranchName(repo.baseBranch)) {
      throw new ReleaseError('unsafe_base_branch', 'Unsafe base branch');
    }
    // vu would stop and ask in the terminal, where nobody can answer: ask in the dashboard first.
    const missing = this.d.scripts?.missing(repo);
    if (missing && missing.required.length > 0) {
      throw new ActionError(
        409,
        'script_config_missing',
        'The release scripts need a few values before they can run on their own.',
        missing,
      );
    }
  }

  private gateError(): ReleaseError {
    return new ReleaseError(
      'pty_gate_unsupported',
      'This repo requires reviewer approval on version MRs, which the PTY engine cannot check. Use the node engine.',
    );
  }

  /** The job already exists and is `running`. Never rejects. */
  start(job: Job, repo: RepoConfig, version: string | null): Promise<void> {
    const run: Run = {
      jobId: job.id,
      secrets: [
        ...(repo.gitlab.token ? [repo.gitlab.token] : []),
        ...gitAuthEnv(repo.cloneUrl, repo.gitlab.token).secrets,
      ],
      abort: new AbortController(),
      closing: false,
      proc: null,
      chunks: [],
      chunkChars: 0,
      seq: 0,
      listeners: new Set(),
      pending: '',
      unpersisted: '',
      recent: '',
      lastDataAt: this.d.now(),
      prompt: null,
      enterSent: false,
      timers: [],
      partialTimer: null,
      done: Promise.resolve(),
    };
    this.runs.set(job.id, run);
    run.done = this.execute(run, job, repo, version).catch((e: unknown) => {
      this.d.log.error(
        { jobId: job.id, reason: (e as Error).message },
        'pty run stopped abnormally',
      );
      this.finish(run, this.redact(run, (e as Error).message));
    });
    return run.done;
  }

  private async execute(
    run: Run,
    job: Job,
    repo: RepoConfig,
    version: string | null,
  ): Promise<void> {
    this.d.jobs.beginStep(job.id, PTY_STEP);
    this.emitJob(job.id);

    const { signal } = run.abort;
    try {
      this.note(run, `Preparing the bot clone of ${repo.id}`);
      await this.d.clones.ensureClone(repo, { signal });
      // vu refuses a dirty tree, and a killed run leaves one. This also puts the clone on a known base.
      await this.d.clones.sync(repo, { signal });
    } catch (e) {
      const text = e instanceof ActionError ? `${e.code}: ${e.message}` : (e as Error).message;
      return this.finish(run, this.redact(run, text));
    }
    if (signal.aborted) return this.finish(run, 'Stopped before vu started');

    const mode = job.state.releaseMode === 'prod' ? 'prod' : 'staging';
    const args = vuArgs({ mode, base: repo.baseBranch, version });
    this.d.audit.write({
      actor: 'user',
      action: 'release.pty.start',
      targetType: 'release',
      targetId: job.id,
      before: null,
      after: { repoId: repo.id, command: ['vu', ...args].join(' ') },
    });
    this.note(run, `Running: vu ${args.join(' ')}`);

    const cwd = this.d.git.clonePath(repo.id);
    let proc: PtyProcess;
    try {
      proc = await this.d.backend.spawnVu({
        repoId: repo.id,
        cwd,
        args,
        env: this.envFor(repo, job),
        secrets: run.secrets,
      });
    } catch (e) {
      return this.finish(run, this.redact(run, `vu could not start: ${(e as Error).message}`));
    }
    run.proc = proc;

    await new Promise<void>((resolve) => {
      proc.onData((data) => this.onData(run, data));
      proc.onExit(({ exitCode, signal: killedBy }) => {
        this.flushPending(run);
        this.finish(run, this.exitError(run, exitCode, killedBy));
        resolve();
      });
      run.timers.push(
        setInterval(() => this.checkIdle(run), IDLE_CHECK_MS),
        setInterval(() => this.persist(run), PERSIST_MS),
      );
      // A cancel may have landed during the spawn.
      if (signal.aborted) this.kill(run);
    });
  }

  /** Added to the backend's base environment (PATH and TERM are the backend's). */
  private envFor(repo: RepoConfig, job: Job): Record<string, string> {
    // Release script settings first; the repo token and the job's assignee below win over them.
    const env: Record<string, string> = { ...(this.d.scripts?.envFor(repo) ?? {}) };
    if (repo.gitlab.token) env.GITLAB_TOKEN = repo.gitlab.token;
    if (typeof job.state.assignee === 'string') env.VU_ASSIGNEE = job.state.assignee;
    // vu's own git fetch/push over an https clone URL, the same way the node engine authenticates.
    return { ...env, ...gitAuthEnv(repo.cloneUrl, repo.gitlab.token).env };
  }

  /** Null means success. */
  private exitError(run: Run, exitCode: number, killedBy: number | undefined): string | null {
    if (exitCode === 0 && !killedBy && run.enterSent) return null;
    if (exitCode === 0 && !killedBy) {
      return 'vu ended without reaching the review prompt, so nothing was merged. See the output.';
    }
    const how = killedBy ? `was killed by signal ${killedBy}` : `exited with status ${exitCode}`;
    return run.enterSent
      ? `vu ${how} after Enter was sent. The merge may have happened: check the MR and the tag.`
      : `vu ${how} before the merge. See the output.`;
  }

  /** The one input ever sent. */
  pressEnter(job: Job): void {
    const run = this.runs.get(job.id);
    if (!run?.proc || run.prompt?.kind !== 'enter' || run.abort.signal.aborted) {
      throw new ReleaseError('job_not_paused', 'vu is not waiting at its review prompt');
    }
    if (this.d.config.isDryRun()) {
      throw new ReleaseError(
        'dry_run_switched_on',
        'Dry-run was switched on during this live release. vu cannot simulate: switch it off to continue, or cancel.',
      );
    }
    if (this.d.config.getRepo(job.repoId)?.requireVersionMrApproval) throw this.gateError();
    if (!this.d.jobs.backToRunning(job.id, PTY_STEP)) {
      throw new ReleaseError('job_not_paused', 'vu is not waiting at its review prompt');
    }
    run.prompt = null;
    run.enterSent = true;
    this.d.audit.write({
      actor: 'user',
      action: 'release.pty.enter',
      targetType: 'release',
      targetId: job.id,
      before: null,
      after: { prompt: ENTER_PROMPT.trim() },
    });
    run.proc.write('\r');
    this.emitJob(job.id);
  }

  /** True when this job has a live run, which the kill now ends. The job's state changes when the run has stopped. */
  cancel(jobId: string): boolean {
    const run = this.runs.get(jobId);
    if (!run) return false;
    if (!run.abort.signal.aborted) {
      this.note(run, 'Cancel requested');
      run.abort.abort();
      this.kill(run);
      this.emitJob(jobId);
    }
    return true;
  }

  cancelling(jobId: string): boolean {
    return this.runs.get(jobId)?.abort.signal.aborted ?? false;
  }

  promptOf(jobId: string): PtyPrompt | null {
    return this.runs.get(jobId)?.prompt ?? null;
  }

  isLive(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  /**
   * The output after `afterSeq`, then live events. Null when the run is over: the transcript in `job_steps` is all there
   * is. Replay and subscribe happen in one synchronous block, so nothing falls between them.
   */
  attach(
    jobId: string,
    afterSeq: number,
    listener: (e: PtyStreamEvent) => void,
  ): { backlog: Chunk[]; dropped: boolean; detach: () => void } | null {
    const run = this.runs.get(jobId);
    if (!run) return null;
    const backlog = run.chunks.filter((c) => c.seq > afterSeq);
    const first = run.chunks[0];
    const dropped = first !== undefined && first.seq > afterSeq + 1;
    run.listeners.add(listener);
    return { backlog, dropped, detach: () => run.listeners.delete(listener) };
  }

  /** Shutdown: every live vu is stopped, and its job recorded as interrupted. */
  close(): Promise<unknown> {
    this.closing = true;
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.closing = true;
      run.abort.abort();
      this.kill(run);
    }
    return Promise.allSettled(runs.map((r) => r.done));
  }

  /**
   * `vu` and its children (frm, flutter, gradle) share the process group of the pty's session leader, so the group is
   * signalled, not only `vu`. A merge already sent to GitLab cannot be taken back.
   */
  private kill(run: Run): void {
    const send = (sig: NodeJS.Signals) => run.proc?.killGroup(sig);
    send('SIGTERM');
    const timer = setTimeout(() => {
      if (this.runs.get(run.jobId) === run) send('SIGKILL');
    }, KILL_GRACE_MS);
    timer.unref();
    run.timers.push(timer);
  }

  /** Ends the job once nothing is running. `error` null is a success. A cancel or a shutdown decides over the exit code. */
  private finish(run: Run, error: string | null): void {
    if (this.runs.get(run.jobId) !== run) return;
    for (const t of run.timers) clearTimeout(t);
    if (run.partialTimer) clearTimeout(run.partialTimer);
    this.flushPending(run);
    this.persist(run);
    const { jobId } = run;
    run.prompt = null;

    if (run.closing || this.closing) {
      this.d.jobs.failStep(jobId, PTY_STEP, PTY_INTERRUPTED_MESSAGE);
    } else if (run.abort.signal.aborted) {
      this.d.jobs.cancel(
        jobId,
        'Cancelled',
        run.enterSent
          ? 'Cancelled after Enter was sent: vu may have merged without tagging. Check the MR and the tag. PTY has no resume for this.'
          : null,
      );
    } else if (error === null) {
      this.d.jobs.finishStep(jobId, PTY_STEP, {});
      this.d.jobs.succeed(jobId);
    } else {
      this.d.log.warn({ jobId, reason: error }, 'pty release failed');
      this.d.jobs.failStep(jobId, PTY_STEP, error);
    }

    this.runs.delete(jobId);
    for (const listener of [...run.listeners]) listener({ kind: 'end' });
    run.listeners.clear();
    this.emitJob(jobId);
  }

  // ───────────────────────────── Output ─────────────────────────────

  private onData(run: Run, data: string): void {
    run.lastDataAt = this.d.now();
    run.pending += data;
    const cut = Math.max(run.pending.lastIndexOf('\n'), run.pending.lastIndexOf('\r'));
    if (cut !== -1) {
      this.publish(run, run.pending.slice(0, cut + 1));
      run.pending = run.pending.slice(cut + 1);
    }
    if (run.pending.length > PARTIAL_MAX_CHARS) return this.flushPending(run);
    if (run.pending !== '' && !run.partialTimer) {
      run.partialTimer = setTimeout(() => this.flushPending(run), PARTIAL_FLUSH_MS);
    }
  }

  private flushPending(run: Run): void {
    if (run.partialTimer) clearTimeout(run.partialTimer);
    run.partialTimer = null;
    if (run.pending === '') return;
    const text = run.pending;
    run.pending = '';
    this.publish(run, text);
  }

  /** A line from the dashboard itself, set apart from what `vu` wrote. */
  private note(run: Run, line: string): void {
    this.publish(run, `\u001b[2m[dashboard] ${line}\u001b[0m\r\n`);
  }

  private publish(run: Run, raw: string): void {
    const data = this.redact(run, raw);
    run.seq += 1;
    const chunk = { seq: run.seq, data };
    run.chunks.push(chunk);
    run.chunkChars += data.length;
    while (run.chunkChars > BUFFER_MAX_CHARS && run.chunks.length > 1) {
      run.chunkChars -= run.chunks.shift()?.data.length ?? 0;
    }
    run.unpersisted += data;
    for (const listener of run.listeners) listener({ kind: 'output', ...chunk });
    run.recent = (run.recent + data.replace(ANSI_RE, '')).slice(-RECENT_MAX_CHARS);
    this.checkPrompt(run);
  }

  private redact(run: Run, text: string): string {
    return redactSecrets(text, run.secrets);
  }

  private persist(run: Run): void {
    if (run.unpersisted === '') return;
    const text = run.unpersisted;
    run.unpersisted = '';
    try {
      this.d.jobs.appendRawLog(run.jobId, PTY_STEP, text);
    } catch (e) {
      this.d.log.warn(
        { jobId: run.jobId, reason: (e as Error).message },
        'could not store pty output',
      );
    }
  }

  // ───────────────────────────── Prompts ─────────────────────────────

  private lastLine(run: Run): string {
    return run.recent.slice(
      Math.max(run.recent.lastIndexOf('\n'), run.recent.lastIndexOf('\r')) + 1,
    );
  }

  /** The review prompt only counts as the exact last line after its banner, so MR text or a build log cannot fake it. */
  private checkPrompt(run: Run): void {
    const line = this.lastLine(run);
    const atReview = !run.enterSent && line === ENTER_PROMPT && run.recent.includes(REVIEW_BANNER);
    if (atReview && run.prompt?.kind !== 'enter') {
      run.prompt = { kind: 'enter', text: ENTER_PROMPT.trim() };
      this.d.jobs.pauseAt(run.jobId, PTY_STEP);
      this.emitJob(run.jobId);
    } else if (!atReview && run.prompt?.kind === 'enter') {
      run.prompt = null;
      this.d.jobs.backToRunning(run.jobId, PTY_STEP);
      this.emitJob(run.jobId);
    } else if (run.prompt?.kind === 'other' && line !== run.prompt.text) {
      run.prompt = null;
      this.emitJob(run.jobId);
    }
  }

  /** Output that stopped mid-line, in the form of a question. The job stays `running`: only a cancel can end this. */
  private checkIdle(run: Run): void {
    if (run.prompt || this.d.now() - run.lastDataAt < OTHER_PROMPT_IDLE_MS) return;
    const line = this.lastLine(run);
    if (line.length > OTHER_PROMPT_MAX_CHARS || !OTHER_PROMPT_RE.test(line)) return;
    run.prompt = { kind: 'other', text: line };
    this.emitJob(run.jobId);
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
