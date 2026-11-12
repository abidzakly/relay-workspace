import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema } from './common';
import { ReviewLatencySchema } from './health';
import { MrStateSchema } from './mr';
import {
  AssignedAtResolutionSchema,
  BugRatioSchema,
  ResearchQuotaSchema,
  SlaEvaluationSchema,
} from './sla';

/**
 * KPI API. Computed by `apps/server/src/services/kpiEngine.ts` from the local cache. Months and days
 * follow the server's time zone, like the SLA engine.
 */

/** `YYYY-MM`. */
export const KpiMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
export type KpiMonth = z.infer<typeof KpiMonthSchema>;

export const KpiCardMrSchema = z.object({
  repoId: RepoIdSchema,
  iid: z.int().positive(),
  state: MrStateSchema,
  createdAt: EpochMsSchema,
  webUrl: z.string().nullable(),
  /** The link is flagged as a duplicate or mismatch, so this clock stop may be wrong. */
  conflict: z.boolean(),
});
export type KpiCardMr = z.infer<typeof KpiCardMrSchema>;

/** One line of the SLA table. */
export const KpiCardRowSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  url: z.string().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  /** The local month the card's clock starts in: `max(assignedAt, estimation start)`. */
  month: KpiMonthSchema,
  /** Its status is Complete or the ready status: no pushes, not in Today's focus. */
  completed: z.boolean(),
  assignedAt: AssignedAtResolutionSchema,
  sla: SlaEvaluationSchema,
  /** The MR that stopped the clock: the earliest linked one that is not closed-unmerged. */
  mr: KpiCardMrSchema.nullable(),
  /** Linked MRs closed without merging. They do not stop the clock. */
  ignoredClosedMrs: z.int().nonnegative(),
  /** Status is neither parked/closed (`statusGroups.inactive`) nor handed to QA (`statusGroups.done`). */
  actionable: z.boolean().default(true),
  /** Reached Ready to Test or later (`statusGroups.done`): counts as completed for the completion rate. */
  reachedReady: z.boolean().default(false),
  /** Counts in the completion-rate denominator (not `statusGroups.uncommitted`). */
  committed: z.boolean().default(true),
  /** Notion Point (1-6). */
  point: z.number().nullable().default(null),
});
export type KpiCardRow = z.infer<typeof KpiCardRowSchema>;

const HitRateFields = {
  met: z.int().nonnegative(),
  breached: z.int().nonnegative(),
  /** Timer still running (or not started) at `asOf`. Not in the hit-rate. */
  inFlight: z.int().nonnegative(),
  /** `met / (met + breached)`; null when both are 0. */
  hitRate: z.number().min(0).max(1).nullable(),
  /** Mean of start clock -> MR opened, over met and breached cards stopped by an MR. */
  avgResolutionMs: z.int().nonnegative().nullable(),
  avgResolutionLabel: z.string().nullable(),
};

export const KpiSlaByTypeSchema = z.object({
  type: z.string(),
  ruleDays: z.int().positive().nullable(),
  ...HitRateFields,
});
export type KpiSlaByType = z.infer<typeof KpiSlaByTypeSchema>;

export const KpiLateCardSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  url: z.string().nullable(),
  type: z.string().nullable(),
  deadline: EpochMsSchema,
  /** When the MR opened; null = no MR by `asOf`. */
  stoppedAt: EpochMsSchema.nullable(),
  lateByMs: z.int().nonnegative(),
  lateByLabel: z.string(),
});
export type KpiLateCard = z.infer<typeof KpiLateCardSchema>;

/** Task completion rate: cards that reached Ready to Test (or later) over committed cards of the month. */
export const KpiCompletionSchema = z.object({
  completed: z.int().nonnegative(),
  total: z.int().nonnegative(),
  /** null when there is no committed card. */
  rate: z.number().min(0).max(1).nullable(),
  target: z.number().min(0).max(1),
  met: z.boolean(),
  /** More cards that must reach Ready to Test to hit the target (0 when met). */
  needed: z.int().nonnegative(),
});
export type KpiCompletion = z.infer<typeof KpiCompletionSchema>;

/** Point-based effort of the month's committed cards. */
export const KpiEffortSchema = z.object({
  totalHours: z.number().nonnegative(),
  doneHours: z.number().nonnegative(),
  research: z.int().nonnegative(),
  unestimated: z.int().nonnegative(),
});
export type KpiEffort = z.infer<typeof KpiEffortSchema>;

export const KpiScorecardSchema = z.object({
  month: KpiMonthSchema,
  /** Evaluated as of this instant: now for the current month, the month's last millisecond for a past one. */
  asOf: EpochMsSchema,
  counts: z.object({
    cards: z.int().nonnegative(),
    /** Cards with no timer (`untracked`). */
    untracked: z.int().nonnegative(),
    /** Cards whose assigned-at is an approximation. */
    approxAssignedAt: z.int().nonnegative(),
  }),
  bugRatio: BugRatioSchema,
  research: ResearchQuotaSchema,
  sla: z.object({
    overall: z.object(HitRateFields),
    byType: z.array(KpiSlaByTypeSchema),
  }),
  lateCards: z.array(KpiLateCardSchema),
  reviewLatency: ReviewLatencySchema,
  /** Absent in snapshots frozen before it existed. */
  completion: KpiCompletionSchema.optional(),
  effort: KpiEffortSchema.optional(),
});
export type KpiScorecard = z.infer<typeof KpiScorecardSchema>;

/** What `kpi_snapshots.data` holds. */
export const KpiSnapshotDataSchema = z.object({
  scorecard: KpiScorecardSchema,
  rows: z.array(KpiCardRowSchema),
});
export type KpiSnapshotData = z.infer<typeof KpiSnapshotDataSchema>;

export const KpiHistoryItemSchema = z.object({
  month: KpiMonthSchema,
  frozenAt: EpochMsSchema,
  bugRatio: z.number().min(0).max(1),
  bugOverLimit: z.boolean(),
  researchCount: z.int().nonnegative(),
  researchMet: z.boolean(),
  hitRate: z.number().min(0).max(1).nullable(),
  lateCards: z.int().nonnegative(),
  completionRate: z.number().min(0).max(1).nullable().default(null),
});
export type KpiHistoryItem = z.infer<typeof KpiHistoryItemSchema>;

const KpiViewFields = {
  month: KpiMonthSchema,
  /** The month in progress on the server. */
  current: z.boolean(),
  /** Served from `kpi_snapshots`. */
  frozen: z.boolean(),
  frozenAt: EpochMsSchema.nullable(),
};

/** `GET /api/kpi?month=`. */
export const KpiReportSchema = z.object({
  ...KpiViewFields,
  /** false = no `gitlab.myUsername` or `notion.assigneeAliases`, so no card can count as mine. */
  meConfigured: z.boolean(),
  scorecard: KpiScorecardSchema,
  /** Frozen months, newest first. */
  history: z.array(KpiHistoryItemSchema),
});
export type KpiReport = z.infer<typeof KpiReportSchema>;

/** `GET /api/kpi/cards?month=`. The current month also lists other months' cards whose timer is still open. */
export const KpiCardsResponseSchema = z.object({
  ...KpiViewFields,
  rows: z.array(KpiCardRowSchema),
});
export type KpiCardsResponse = z.infer<typeof KpiCardsResponseSchema>;

/** `GET /api/kpi/focus`: this month's actionable running timers, least time left first. */
export const KpiFocusResponseSchema = z.object({
  generatedAt: EpochMsSchema,
  rows: z.array(KpiCardRowSchema),
  /** Before `limit` was applied. */
  total: z.int().nonnegative(),
});
export type KpiFocusResponse = z.infer<typeof KpiFocusResponseSchema>;

export const KpiQuerySchema = z.object({ month: KpiMonthSchema.optional() }).strict();
export const KpiFocusQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export const KPI_EXPORT_FORMATS = ['md', 'csv'] as const;
export const KpiExportQuerySchema = z
  .object({ month: KpiMonthSchema.optional(), format: z.enum(KPI_EXPORT_FORMATS).default('md') })
  .strict();

/** `PUT /api/cards/:id/assigned-at`. null removes the override. */
export const AssignedAtOverrideBodySchema = z
  .object({ assignedAt: EpochMsSchema.nullable() })
  .strict();
export type AssignedAtOverrideBody = z.infer<typeof AssignedAtOverrideBodySchema>;

export const AssignedAtOverrideResultSchema = z.object({
  cardId: NotionIdSchema,
  assignedAt: AssignedAtResolutionSchema,
  /** null = the value was already set, so nothing was written. */
  auditId: z.int().positive().nullable(),
});
export type AssignedAtOverrideResult = z.infer<typeof AssignedAtOverrideResultSchema>;
