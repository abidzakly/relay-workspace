import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  AC_STATES,
  CHECK_ACTORS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RUN_MODES,
  RUN_STATUSES,
  RUN_VERDICTS,
} from '@relay/shared';
import { inList } from './_helpers';

/**
 * Test Bench. Everything here is local to this app: Notion is never written from it.
 */

/** Parsed card body, re-read only when Notion's `last_edited_time` moves. */
export const cardBodies = sqliteTable('card_bodies', {
  cardId: text('card_id').primaryKey(),
  /** `ParsedBody` (ac, figmaUrl, docLinks, description). */
  body: text('body', { mode: 'json' }).notNull(),
  lastEditedAt: integer('last_edited_at').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  /** Hand-set Figma link; wins over the one found in the body. Survives re-reads. */
  figmaOverride: text('figma_override'),
  /** AC key → Figma node id (`1:23`). Survives re-reads. */
  frames: text('frames', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
});

/** One tick per card and target (`ac:<key>` or `finding:<id>`); survives leaving and re-opening the bench. */
export const acChecks = sqliteTable(
  'ac_checks',
  {
    cardId: text('card_id').notNull(),
    target: text('target').notNull(),
    state: text('state').notNull(),
    by: text('by').notNull(),
    runId: text('run_id'),
    verifiedSha: text('verified_sha'),
    note: text('note').notNull().default(''),
    evidencePath: text('evidence_path'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.target] }),
    check('ac_checks_state_ck', inList(t.state, AC_STATES)),
    check('ac_checks_by_ck', inList(t.by, CHECK_ACTORS)),
  ],
);

export const testFindings = sqliteTable(
  'test_findings',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id').notNull(),
    repoId: text('repo_id').notNull(),
    branch: text('branch').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    acKey: text('ac_key'),
    steps: text('steps').notNull().default(''),
    expected: text('expected').notNull().default(''),
    actual: text('actual').notNull().default(''),
    screenshotPath: text('screenshot_path'),
    source: text('source').notNull(),
    status: text('status').notNull(),
    runId: text('run_id'),
    fixCommitSha: text('fix_commit_sha'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('test_findings_card_idx').on(t.cardId),
    check('test_findings_severity_ck', inList(t.severity, FINDING_SEVERITIES)),
    check('test_findings_status_ck', inList(t.status, FINDING_STATUSES)),
    check('test_findings_source_ck', inList(t.source, CHECK_ACTORS)),
  ],
);

export const testRuns = sqliteTable(
  'test_runs',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id').notNull(),
    repoId: text('repo_id').notNull(),
    branch: text('branch').notNull(),
    headSha: text('head_sha').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    verdict: text('verdict'),
    summary: text('summary').notNull().default(''),
    waitingFor: text('waiting_for'),
    deviceSerial: text('device_serial'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [
    index('test_runs_branch_idx').on(t.repoId, t.branch),
    check('test_runs_mode_ck', inList(t.mode, RUN_MODES)),
    check('test_runs_status_ck', inList(t.status, RUN_STATUSES)),
    // NULL (no verdict yet) passes: `NULL IN (…)` is NULL, which a CHECK accepts.
    check('test_runs_verdict_ck', inList(t.verdict, RUN_VERDICTS)),
  ],
);

/**
 * A bench that was opened, so the sidebar can offer "Continue testing". Leaves the list once the branch is tested on
 * its current HEAD, has an MR, or is dismissed by hand (re-opening the bench brings it back).
 */
export const testBenchSessions = sqliteTable(
  'test_bench_sessions',
  {
    repoId: text('repo_id').notNull(),
    branch: text('branch').notNull(),
    cardId: text('card_id').notNull(),
    cardTitle: text('card_title').notNull(),
    openedAt: integer('opened_at').notNull(),
    dismissedAt: integer('dismissed_at'),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.branch] })],
);
