import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  JOB_STEP_NAMES,
  type Engine,
  type Job,
  type JobMode,
  type JobStep,
  type JobStepName,
  type Json,
} from '@relay/shared';
import type { AppDb } from '../db';
import { jobs, jobSteps } from '../db/schema';
import { ActionError } from './actionError';

/**
 * `jobs` / `job_steps` persistence. Everything a run needs to continue after a crash is here, and each
 * step's result is committed with its status in one transaction, so a step is either wholly done or runs again.
 */

/** A release job that holds the repo's clone: only one at a time. */
const ACTIVE_STATUSES = ['queued', 'running', 'paused'] as const;
const CANCELLABLE_STATUSES = [...ACTIVE_STATUSES, 'failed'] as const;
export const LOG_MAX_CHARS = 64 * 1024;
/** A PTY job has no steps of its own: `vu` is one opaque run, kept in this single row with its transcript. */
export const PTY_STEP: JobStepName = 'PREFLIGHT';
/** A build job's only step: all its commands log here, and its output is a `BuildResult`. */
export const BUILD_STEP: JobStepName = 'BUILD';

export interface NewReleaseJob {
  repoId: string;
  mode: JobMode;
  dryRun: boolean;
  state: Record<string, Json>;
  /** Default `node`. */
  engine?: Engine;
}

export interface NewBuildJob {
  repoId: string;
  mode: JobMode;
  dryRun: boolean;
  /** Null until detected, when the job runs. */
  flavor: string | null;
  state: Record<string, Json>;
  /** The release this build belongs to. It holds the clone, so it alone may build during that release. */
  parentJobId: string | null;
}

export type JobPatch = Partial<
  Pick<Job, 'version' | 'prevVersion' | 'branch' | 'mrIid' | 'flavor' | 'dryRun'>
>;

export interface StepResult {
  output?: Record<string, Json>;
  /** Merged into `jobs.state`. */
  state?: Record<string, Json>;
  job?: JobPatch;
  /** Steps that no longer apply (an open MR was found, so nothing has to be created). */
  skip?: readonly JobStepName[];
}

const toJob = (r: typeof jobs.$inferSelect) => r as unknown as Job;
const toStep = (r: typeof jobSteps.$inferSelect) => r as unknown as JobStep;

export class JobStore {
  constructor(
    private readonly app: AppDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** The check and the insert share a transaction, so two starts cannot both pass. */
  createRelease(input: NewReleaseJob): Job {
    const id = randomUUID();
    const at = this.now();
    const engine = input.engine ?? 'node';
    const names = engine === 'pty' ? [PTY_STEP] : JOB_STEP_NAMES;
    this.app.sqlite.transaction(() => {
      const active = this.activeRelease(input.repoId);
      if (active) {
        throw new ActionError(
          409,
          'release_already_active',
          `A release of ${input.repoId} is already in progress`,
          { jobId: active.id },
        );
      }
      this.assertNoActiveBuild(input.repoId);
      this.app.db
        .insert(jobs)
        .values({
          id,
          repoId: input.repoId,
          kind: 'release',
          engine,
          mode: input.mode,
          status: 'running',
          dryRun: input.dryRun,
          state: input.state,
          createdAt: at,
          startedAt: at,
          updatedAt: at,
        })
        .run();
      this.app.db
        .insert(jobSteps)
        .values(names.map((name, seq) => ({ jobId: id, seq, name })))
        .run();
    })();
    return this.mustGet(id);
  }

  /**
   * A build uses the same clone as a release, whose steps reset and switch branches. So a build waits for no release: it
   * is refused while another release of the repo is active. Only the parent release may build, once per parent.
   */
  createBuild(input: NewBuildJob): Job {
    const id = randomUUID();
    const at = this.now();
    this.app.sqlite.transaction(() => {
      const active = this.activeRelease(input.repoId);
      if (input.parentJobId !== null && active?.id !== input.parentJobId) {
        throw new ActionError(409, 'parent_not_active', 'The release of this build is not active');
      }
      if (input.parentJobId === null && active) {
        throw new ActionError(
          409,
          'release_active',
          `A release of ${input.repoId} is using its clone`,
          { jobId: active.id },
        );
      }
      const duplicate = this.activeBuild(input.repoId, (build) =>
        input.parentJobId !== null
          ? build.parentJobId === input.parentJobId
          : build.mode === input.mode,
      );
      if (duplicate) {
        throw new ActionError(
          409,
          'build_already_active',
          `This build of ${input.repoId} is already queued or running`,
          { jobId: duplicate.id },
        );
      }
      this.app.db
        .insert(jobs)
        .values({
          id,
          repoId: input.repoId,
          kind: 'build',
          engine: 'node',
          mode: input.mode,
          status: 'queued',
          dryRun: input.dryRun,
          flavor: input.flavor,
          state: input.state,
          parentJobId: input.parentJobId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      this.app.db.insert(jobSteps).values({ jobId: id, seq: 0, name: BUILD_STEP }).run();
    })();
    return this.mustGet(id);
  }

  /** The queue's turn came: queued -> running. False when the job is no longer queued. */
  startBuild(jobId: string): boolean {
    const at = this.now();
    const res = this.app.db
      .update(jobs)
      .set({ status: 'running', startedAt: at, updatedAt: at })
      .where(and(eq(jobs.id, jobId), eq(jobs.kind, 'build'), eq(jobs.status, 'queued')))
      .run();
    return res.changes === 1;
  }

  /** The repo's oldest queued or running build that `match` accepts. */
  activeBuild(repoId: string, match: (build: Job) => boolean = () => true): Job | null {
    const rows = this.app.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.repoId, repoId),
          eq(jobs.kind, 'build'),
          inArray(jobs.status, ['queued', 'running']),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .all();
    return rows.map(toJob).find(match) ?? null;
  }

  /** The newest build a release spawned, whatever its status. A re-run of BUILD looks here first. */
  latestChildBuild(parentJobId: string): Job | null {
    const row = this.app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'build'), eq(jobs.parentJobId, parentJobId)))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .get();
    return row ? toJob(row) : null;
  }

  assertNoActiveBuild(repoId: string): void {
    const build = this.activeBuild(repoId);
    if (build) {
      throw new ActionError(
        409,
        'build_active',
        `A build of ${repoId} is queued or running in its clone. Wait for it, or cancel it.`,
        { jobId: build.id },
      );
    }
  }

  /** Newest first. the history. */
  listBuilds(limit: number): Job[] {
    return this.app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, 'build'))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(limit)
      .all()
      .map(toJob);
  }

  /** After a restart no build is running, and the queue is gone. They do not restart by themselves. Returns their ids. */
  failInterruptedBuilds(message: string): string[] {
    const at = this.now();
    return this.app.sqlite.transaction(() => {
      const rows = this.app.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.kind, 'build'), inArray(jobs.status, ['queued', 'running'])))
        .all();
      for (const { id } of rows) {
        this.app.db
          .update(jobSteps)
          .set({ status: 'failed', finishedAt: at, error: message })
          .where(eq(jobSteps.jobId, id))
          .run();
        this.app.db
          .update(jobs)
          .set({ status: 'failed', error: message, finishedAt: at, updatedAt: at })
          .where(eq(jobs.id, id))
          .run();
      }
      return rows.map((r) => r.id);
    })();
  }

  get(id: string): Job | null {
    const row = this.app.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  private mustGet(id: string): Job {
    const job = this.get(id);
    if (!job) throw new ActionError(404, 'job_not_found', 'Unknown job');
    return job;
  }

  steps(jobId: string): JobStep[] {
    return this.app.db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, jobId))
      .orderBy(asc(jobSteps.seq))
      .all()
      .map(toStep);
  }

  /** The step to run next: the first one neither done nor skipped. A failed step runs again. */
  nextStep(jobId: string): JobStep | null {
    return (
      this.steps(jobId).find((s) => s.status !== 'succeeded' && s.status !== 'skipped') ?? null
    );
  }

  activeRelease(repoId: string): Job | null {
    const row = this.app.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.repoId, repoId),
          eq(jobs.kind, 'release'),
          inArray(jobs.status, [...ACTIVE_STATUSES]),
        ),
      )
      .get();
    return row ? toJob(row) : null;
  }

  latestRelease(repoId: string): Job | null {
    const row = this.app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, repoId), eq(jobs.kind, 'release')))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .get();
    return row ? toJob(row) : null;
  }

  beginStep(jobId: string, name: JobStepName): void {
    const at = this.now();
    this.app.sqlite.transaction(() => {
      this.app.db
        .update(jobSteps)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${jobSteps.startedAt}, ${at})`,
          finishedAt: null,
          error: null,
        })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
      this.app.db
        .update(jobs)
        .set({ currentStep: name, updatedAt: at })
        .where(eq(jobs.id, jobId))
        .run();
    })();
  }

  /** Kept as written so far even when the step dies. Only the newest output is kept once the cap is reached. */
  appendLog(jobId: string, name: JobStepName, line: string): void {
    this.app.db
      .update(jobSteps)
      .set({ log: sql`substr(${jobSteps.log} || ${`${line}\n`}, ${-LOG_MAX_CHARS})` })
      .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
      .run();
  }

  /** Terminal output, kept byte for byte: no newline is added. The cap is the same as `appendLog`. */
  appendRawLog(jobId: string, name: JobStepName, text: string): void {
    this.app.db
      .update(jobSteps)
      .set({ log: sql`substr(${jobSteps.log} || ${text}, ${-LOG_MAX_CHARS})` })
      .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
      .run();
  }

  finishStep(jobId: string, name: JobStepName, result: StepResult): void {
    const at = this.now();
    this.app.sqlite.transaction(() => {
      const job = this.mustGet(jobId);
      this.app.db
        .update(jobSteps)
        .set({ status: 'succeeded', finishedAt: at, output: result.output ?? null, error: null })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
      if (result.skip && result.skip.length > 0) {
        this.app.db
          .update(jobSteps)
          .set({ status: 'skipped', finishedAt: at })
          .where(and(eq(jobSteps.jobId, jobId), inArray(jobSteps.name, [...result.skip])))
          .run();
      }
      this.app.db
        .update(jobs)
        .set({ ...result.job, state: { ...job.state, ...result.state }, updatedAt: at })
        .where(eq(jobs.id, jobId))
        .run();
    })();
  }

  failStep(jobId: string, name: JobStepName, error: string): void {
    const at = this.now();
    this.app.sqlite.transaction(() => {
      this.app.db
        .update(jobSteps)
        .set({ status: 'failed', finishedAt: at, error })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
      this.app.db
        .update(jobs)
        .set({ status: 'failed', currentStep: name, error, finishedAt: at, updatedAt: at })
        .where(eq(jobs.id, jobId))
        .run();
    })();
  }

  /** The job waits at this step. A paused job survives a restart as it is. */
  pauseAt(jobId: string, name: JobStepName): void {
    const at = this.now();
    this.app.sqlite.transaction(() => {
      const res = this.app.db
        .update(jobs)
        .set({ status: 'paused', currentStep: name, updatedAt: at })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
        .run();
      if (res.changes !== 1) return;
      this.app.db
        .update(jobSteps)
        .set({ status: 'paused', startedAt: at })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
    })();
  }

  /** Paused at `name` -> running, with that step done. False when it is no longer paused there: only one click wins. */
  continueFromPause(jobId: string, name: JobStepName): boolean {
    const at = this.now();
    return this.app.sqlite.transaction(() => {
      const res = this.app.db
        .update(jobs)
        .set({ status: 'running', updatedAt: at })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'paused'), eq(jobs.currentStep, name)))
        .run();
      if (res.changes !== 1) return false;
      this.app.db
        .update(jobSteps)
        .set({ status: 'succeeded', finishedAt: at, error: null })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
      return true;
    })();
  }

  /** Paused at `name` -> running, with that step still in progress (a PTY run). False when no longer paused there. */
  backToRunning(jobId: string, name: JobStepName): boolean {
    const at = this.now();
    return this.app.sqlite.transaction(() => {
      const res = this.app.db
        .update(jobs)
        .set({ status: 'running', updatedAt: at })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'paused'), eq(jobs.currentStep, name)))
        .run();
      if (res.changes !== 1) return false;
      this.app.db
        .update(jobSteps)
        .set({ status: 'running' })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.name, name)))
        .run();
      return true;
    })();
  }

  /** Merged into `jobs.state`. Works on an ended job: a build's upload comes after the build. */
  mergeState(jobId: string, patch: Record<string, Json>): void {
    this.app.sqlite.transaction(() => {
      const job = this.get(jobId);
      if (!job) return;
      this.app.db
        .update(jobs)
        .set({ state: { ...job.state, ...patch }, updatedAt: this.now() })
        .where(eq(jobs.id, jobId))
        .run();
    })();
  }

  /** Every step is done or skipped. */
  succeed(jobId: string): void {
    const at = this.now();
    this.app.db
      .update(jobs)
      .set({ status: 'succeeded', error: null, finishedAt: at, updatedAt: at })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
      .run();
  }

  /**
   * Ends the job. A step still marked in progress becomes failed, so a later resume (only allowed once merged) runs it
   * again. Call only when no step is executing. False when the job has already ended.
   */
  cancel(jobId: string, stepError: string, jobError: string | null): boolean {
    const at = this.now();
    return this.app.sqlite.transaction(() => {
      const res = this.app.db
        .update(jobs)
        .set({ status: 'cancelled', error: jobError, finishedAt: at, updatedAt: at })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, [...CANCELLABLE_STATUSES])))
        .run();
      if (res.changes !== 1) return false;
      this.app.db
        .update(jobSteps)
        .set({ status: 'failed', finishedAt: at, error: stepError })
        .where(and(eq(jobSteps.jobId, jobId), inArray(jobSteps.status, ['running', 'paused'])))
        .run();
      return true;
    })();
  }

  /** Failed or cancelled -> running, keeping every finished step. False when the job is in neither state. */
  reopen(jobId: string): boolean {
    const res = this.app.db
      .update(jobs)
      .set({ status: 'running', error: null, finishedAt: null, updatedAt: this.now() })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['failed', 'cancelled'])))
      .run();
    return res.changes === 1;
  }

  /**
   * After a restart nothing is running any more. Interrupted jobs become failed rather than continuing by themselves:
   * resuming can push and open an MR, which needs a click. A paused PTY job goes too: its process died with the server,
   * unlike a paused node job, which is only a row. Returns their ids.
   */
  failInterrupted(message: string, ptyMessage: string): string[] {
    const at = this.now();
    return this.app.sqlite.transaction(() => {
      const rows = this.app.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, 'release'), inArray(jobs.status, ['queued', 'running', 'paused'])))
        .all()
        .filter((row) => row.status !== 'paused' || row.engine === 'pty');
      for (const row of rows) {
        const error = row.engine === 'pty' ? ptyMessage : message;
        this.app.db
          .update(jobSteps)
          .set({ status: 'failed', finishedAt: at, error })
          .where(and(eq(jobSteps.jobId, row.id), inArray(jobSteps.status, ['running', 'paused'])))
          .run();
        this.app.db
          .update(jobs)
          .set({ status: 'failed', error, finishedAt: at, updatedAt: at })
          .where(eq(jobs.id, row.id))
          .run();
      }
      return rows.map((r) => r.id);
    })();
  }
}
