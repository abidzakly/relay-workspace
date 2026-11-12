import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type { Json } from '@relay/shared';
import { ENGINES, JOB_KINDS, JOB_MODES, JOB_STATUSES, JOB_STEP_STATUSES } from '@relay/shared';
import { createdAtCol, inList, updatedAtCol } from './_helpers';
import { repos } from './config';

/**
 * Release & build runs. `state` is the persisted resumable bag.
 * `current_step` / step names are plain text (not CHECKed) so new steps need no migration.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    /** App-generated id (UUID). */
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    engine: text('engine').notNull().default('node'),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('queued'),
    currentStep: text('current_step'),
    version: text('version'),
    prevVersion: text('prev_version'),
    branch: text('branch'),
    mrIid: integer('mr_iid'),
    flavor: text('flavor'),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { mode: 'json' }).$type<Record<string, Json>>().notNull().default({}),
    error: text('error'),
    parentJobId: text('parent_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAtCol(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    check('jobs_kind_chk', inList(t.kind, JOB_KINDS)),
    check('jobs_engine_chk', inList(t.engine, ENGINES)),
    check('jobs_mode_chk', inList(t.mode, JOB_MODES)),
    check('jobs_status_chk', inList(t.status, JOB_STATUSES)),
    index('jobs_repo_created_idx').on(t.repoId, t.createdAt),
    index('jobs_status_idx').on(t.status),
    index('jobs_parent_idx').on(t.parentJobId),
  ],
);

export const jobSteps = sqliteTable(
  'job_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** 0-based order within the job. */
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    /** Captured, secret-free log output. */
    log: text('log').notNull().default(''),
    /** Step result needed to resume (commit sha, MR iid, …). */
    output: text('output', { mode: 'json' }).$type<Record<string, Json> | null>(),
    error: text('error'),
  },
  (t) => [
    unique('job_steps_job_seq_uq').on(t.jobId, t.seq),
    check('job_steps_status_chk', inList(t.status, JOB_STEP_STATUSES)),
    index('job_steps_job_idx').on(t.jobId),
  ],
);
