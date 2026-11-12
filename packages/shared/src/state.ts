import { z } from 'zod';
import { CardSchema } from './card';
import { DomainStateSchema } from './domain';
import { EpochMsSchema } from './common';
import { LinkSchema } from './link';
import { MrTimingSchema } from './health';
import { MrDerivedStateSchema, MrSchema } from './mr';
import { PendingReleaseSchema } from './release';
import { VerdictSchema } from './rules';

/**
 * `GET /api/state` snapshot + the sync status that feeds Sync Health.
 * Read-only view of the local cache; nothing in it is secret.
 */

/** `notion` or `gitlab:<repoId>`. */
export const SyncSourceSchema = z.string().min(1).max(80);

export const SYNC_SOURCE_STATES = ['never', 'ok', 'partial', 'error', 'skipped'] as const;
export const SyncSourceStateSchema = z.enum(SYNC_SOURCE_STATES);
export type SyncSourceState = z.infer<typeof SyncSourceStateSchema>;

/** Health of one sync source (Notion, or one GitLab repo). In memory: a restart resets it to `never`. */
export const SyncSourceStatusSchema = z.object({
  source: SyncSourceSchema,
  state: SyncSourceStateSchema,
  lastAttemptAt: EpochMsSchema.nullable(),
  lastSuccessAt: EpochMsSchema.nullable(),
  lastDurationMs: z.number().int().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** Last failure (sanitized: only error kind + the service's own message). */
  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
  /** `partial` / informational reasons, e.g. "2 MR errors", "rate limited", "truncated". */
  warnings: z.array(z.string()),
  /** GitLab only: last RateLimit-* headers seen. */
  rateLimit: z
    .object({
      limit: z.number().nullable(),
      remaining: z.number().nullable(),
      resetAt: EpochMsSchema.nullable(),
    })
    .nullable(),
});
export type SyncSourceStatus = z.infer<typeof SyncSourceStatusSchema>;

export const SYNC_RUN_KINDS = ['full', 'incremental', 'refresh'] as const;
export const SyncRunKindSchema = z.enum(SYNC_RUN_KINDS);
export type SyncRunKind = z.infer<typeof SyncRunKindSchema>;

export const SYNC_RUN_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export const SyncRunOutcomeSchema = z.enum(SYNC_RUN_OUTCOMES);
export type SyncRunOutcome = z.infer<typeof SyncRunOutcomeSchema>;

export const SyncRunSummarySchema = z.object({
  kind: SyncRunKindSchema,
  startedAt: EpochMsSchema,
  finishedAt: EpochMsSchema,
  outcome: SyncRunOutcomeSchema,
  /** Rows whose content changed during the run. */
  changed: z.object({
    cards: z.number().int().nonnegative(),
    mrs: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
  }),
});
export type SyncRunSummary = z.infer<typeof SyncRunSummarySchema>;

export const SyncStatusSchema = z.object({
  /** A run is executing right now. */
  running: z.boolean(),
  /** Another run is waiting for the current one to finish (coalesced). */
  queued: z.boolean(),
  /** Timer ticks dropped because a run was still executing. */
  skippedBusy: z.number().int().nonnegative(),
  lastRun: SyncRunSummarySchema.nullable(),
  sources: z.array(SyncSourceStatusSchema),
  /** Poller schedule; `null` while the poller is not started. */
  schedule: z
    .object({
      incrementalMs: z.number().int().positive(),
      fullMs: z.number().int().positive(),
      nextIncrementalAt: EpochMsSchema.nullable(),
      nextFullAt: EpochMsSchema.nullable(),
      /** The startup catch-up (full) sync has finished (successfully or not). */
      catchUpDone: z.boolean(),
    })
    .nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/** Cached MR + the cosmetic derived state (the merge gate never uses it) + the version-MR flag. */
export const StateMrSchema = MrSchema.extend({
  derivedState: MrDerivedStateSchema.exclude(['none']),
  /** Version-update MR (excluded from card matching). */
  isVersionMr: z.boolean(),
  /** Open-for / merged-after / last comment / waiting-on, as of `generatedAt`. */
  timing: MrTimingSchema,
  /** I am the author, an assignee or a reviewer, or the MR is linked to one of my cards. */
  mine: z.boolean(),
});
export type StateMr = z.infer<typeof StateMrSchema>;

/**
 * A card as `GET /api/state` sends it. `mine` = the Assignee property matches `gitlab.myUsername` /
 * `notion.assigneeAliases`, or the card has a manual assigned-at (the same set KPI counts). `month` = the KPI month
 * (`YYYY-MM`, the later of assigned-at and estimation start); null when the card has no assigned-at.
 */
export const StateCardSchema = CardSchema.extend({
  mine: z.boolean(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable(),
  /** Product Domain → repo: `connected`, `unconnected` (no repo registered for it) or `unknown` (no domain). */
  domainState: DomainStateSchema,
  /** First connected repo serving the card's Product Domain. */
  domainRepoId: z.string().nullable(),
  /** Every connected repo serving the card's Product Domain (a domain may be shared by several repos). */
  domainRepoIds: z.array(z.string()).default([]),
});
export type StateCard = z.infer<typeof StateCardSchema>;

export const StateSnapshotSchema = z.object({
  generatedAt: EpochMsSchema,
  /** Non-archived cards. */
  cards: z.array(StateCardSchema),
  /** Every cached MR (all states, all repos). */
  mrs: z.array(StateMrSchema),
  links: z.array(LinkSchema),
  /**
   * `verdicts` = the Sync Health rule engine output; the full report (families, unruled cards,
   * review latency) is `GET /api/sync/health`. `sync` is live.
   */
  health: z.object({
    implemented: z.literal(true),
    verdicts: z.array(VerdictSchema),
    sync: SyncStatusSchema,
  }),
  /** Pending-release detection per repo. Computed from the cache and the last release check. */
  pendingReleases: z.object({ implemented: z.literal(true), items: z.array(PendingReleaseSchema) }),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;
