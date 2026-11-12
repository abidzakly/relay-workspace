import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema, ReviewRepoIdSchema } from './common';
import { MrDerivedStateSchema } from './mr';
import { SeveritySchema, VerdictSchema } from './rules';

/**
 * Sync Health report, MR timing and Parent / On Feedback / Issues linkage.
 * Everything here is derived from the local cache; nothing in it is secret.
 */

// ───────────────────────────── duration formatting ─────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `2d 5h`, `3h 12m`, `45m`, `<1m`. Negative input (clock skew) is clamped to 0. */
export function formatDuration(ms: number): string {
  const v = Math.max(0, Math.floor(ms));
  if (v < MIN) return '<1m';
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  const m = Math.floor((v % HOUR) / MIN);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** `3h ago`, `just now`. Coarse on purpose (largest unit only), like GitLab's relative stamps. */
export function formatAgo(ms: number): string {
  const v = Math.max(0, Math.floor(ms));
  if (v < MIN) return 'just now';
  if (v < HOUR) return `${Math.floor(v / MIN)}m ago`;
  if (v < DAY) return `${Math.floor(v / HOUR)}h ago`;
  return `${Math.floor(v / DAY)}d ago`;
}

// ───────────────────────────── MR timing ─────────────────────────────

/** Badge. `draft` = nobody is expected to act yet; `none` = merged / closed. */
export const WAITING_ON = ['reviewer', 'you', 'approved', 'draft', 'none'] as const;
export const WaitingOnSchema = z.enum(WAITING_ON);
export type WaitingOn = z.infer<typeof WaitingOnSchema>;

export const TIMING_LEVELS = ['ok', 'amber', 'red'] as const;
export const TimingLevelSchema = z.enum(TIMING_LEVELS);
export type TimingLevel = z.infer<typeof TimingLevelSchema>;

export const MrTimingSchema = z.object({
  repoId: ReviewRepoIdSchema,
  iid: z.number().int().positive(),
  /** Which clock applies: `open` (open / draft / locked), `merged`, `closed`. */
  phase: z.enum(['open', 'merged', 'closed']),
  /** Open MRs: `now − created_at` + escalation level. Draft MRs show the time but never escalate. */
  openFor: z
    .object({ ms: z.number().nonnegative(), label: z.string(), level: TimingLevelSchema })
    .nullable(),
  /**
   * Merged / closed MRs: `merged_at − created_at` ("merged after 1d 3h"). For `closed` the close time is not
   * cached, so `updatedAt` is used and `approx` is true.
   */
  finishedAfter: z
    .object({
      kind: z.enum(['merged', 'closed']),
      ms: z.number().nonnegative(),
      label: z.string(),
      approx: z.boolean(),
    })
    .nullable(),
  /** Latest human (non-system) note: "last comment 3h ago by @sam.reviewer". */
  lastComment: z.object({ at: EpochMsSchema, by: z.string().nullable() }).nullable(),
  /** Latest push, from GitLab's "added N commits" system notes; falls back to the MR creation time. */
  lastPushAt: EpochMsSchema.nullable(),
  /** First note by a configured reviewer (not the author) after the MR was opened. Feeds the review-latency stat. */
  firstReviewerResponseAt: EpochMsSchema.nullable(),
  waitingOn: z.object({
    kind: WaitingOnSchema,
    /** Since when (reviewer: your last push/reply; you: the reviewer's comment). */
    since: EpochMsSchema.nullable(),
  }),
});
export type MrTiming = z.infer<typeof MrTimingSchema>;

export const ReviewLatencyBucketSchema = z.object({
  /** `YYYY-MM` of the MR's creation (server local time). */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  sampled: z.number().int().nonnegative(),
  meanMs: z.number().nonnegative(),
});

/** Average time from MR open → first reviewer response. Version MRs are excluded. */
export const ReviewLatencySchema = z.object({
  /** MRs with a measurable first response. */
  sampled: z.number().int().nonnegative(),
  /** Reviewable MRs (non-draft, non-version) without any reviewer note yet: not counted in the mean. */
  withoutResponse: z.number().int().nonnegative(),
  meanMs: z.number().nonnegative().nullable(),
  medianMs: z.number().nonnegative().nullable(),
  meanLabel: z.string().nullable(),
  medianLabel: z.string().nullable(),
  byMonth: z.array(ReviewLatencyBucketSchema),
});
export type ReviewLatency = z.infer<typeof ReviewLatencySchema>;

// ───────────────────────────── family tree ─────────────────────────────

export const FamilyChildSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  /** Counts for the "all child Issues are Ready to Test" rule. */
  isIssues: z.boolean(),
  readyToTest: z.boolean(),
  mrState: MrDerivedStateSchema,
  mrRepoId: RepoIdSchema.nullable(),
  mrIid: z.number().int().positive().nullable(),
});
export type FamilyChild = z.infer<typeof FamilyChildSchema>;

/** `Parent (On Feedback)` → child cards. */
export const FamilyTreeSchema = z.object({
  parentId: z.string().min(1),
  /** false = the parent page is not in the cache (not synced / archived / outside the data source). */
  parentKnown: z.boolean(),
  parentTitle: z.string().nullable(),
  parentStatus: z.string().nullable(),
  children: z.array(FamilyChildSchema),
  issuesChildren: z.number().int().nonnegative(),
  readyIssuesChildren: z.number().int().nonnegative(),
  /** Every child Issues card is Ready to Test (and there is at least one). */
  allIssuesReady: z.boolean(),
  /** allIssuesReady AND the parent is On Feedback: suggest parent → Ready to Test (one click, never automatic). */
  suggestParentReady: z.boolean(),
});
export type FamilyTree = z.infer<typeof FamilyTreeSchema>;

/** "↰ Parent: <title> [On Feedback]" chip on a child card; jumps to the parent. */
export const ParentChipSchema = z.object({
  cardId: NotionIdSchema,
  parentId: z.string().min(1),
  parentKnown: z.boolean(),
  parentTitle: z.string().nullable(),
  parentStatus: z.string().nullable(),
});
export type ParentChip = z.infer<typeof ParentChipSchema>;

// ───────────────────────────── release facts (cache-derived) ─────────────────────────────

/**
 * What is known about a merged MR's release (same rule as the pending-release detector).
 * `null` = cannot tell (merged-MR list not checked or out of date / no build history): never a definite answer.
 */
export const ReleaseFactSchema = z.object({
  repoId: RepoIdSchema,
  iid: z.number().int().positive(),
  /** Merged into the repo's base branch. false = e.g. a feature → feature merge: no release applies. */
  onBase: z.boolean(),
  /** A version-update MR merged at/after this MR (the MR is included in a version bump). */
  bumped: z.boolean().nullable(),
  /** Version of the release that contains the MR. null when bumped but older than the history read so far. */
  version: z.string().nullable(),
  /** A succeeded build job exists for that version. null = the dashboard has no build history for the repo. */
  built: z.boolean().nullable(),
});
export type ReleaseFact = z.infer<typeof ReleaseFactSchema>;

// ───────────────────────────── report ─────────────────────────────

export const UnruledSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  status: z.string().nullable(),
  mrState: MrDerivedStateSchema,
  /** Why no rule-table row covers it: unknown status, or a (status, MR state) pair the table does not list. */
  reason: z.enum(['no_status', 'unrecognized_status', 'no_rule_for_pair']),
});
export type Unruled = z.infer<typeof UnruledSchema>;

// ───────────────────────────── false positives ─────────────────────────────

/**
 * Identity of a finding: the rule plus the card and MR it fired on. A finding marked as a false positive stays
 * hidden while the same rule keeps firing on the same card / MR; a different rule on that card shows again.
 */
export const HealthFindingRefSchema = z
  .object({
    ruleId: z.string().min(1).max(120),
    cardId: NotionIdSchema.nullable(),
    repoId: RepoIdSchema.nullable(),
    mrIid: z.number().int().positive().nullable(),
  })
  .strict();
export type HealthFindingRef = z.infer<typeof HealthFindingRefSchema>;

/** Stable key of a finding (`ruleId|cardId|repoId#iid`). Card ids are compared without dashes, in lower case. */
export const healthFindingKey = (r: {
  ruleId: string;
  cardId: string | null;
  repoId: string | null;
  mrIid: number | null;
}): string =>
  `${r.ruleId}|${(r.cardId ?? '').replace(/-/g, '').toLowerCase()}|${r.repoId ?? ''}#${r.mrIid ?? ''}`;

export const DismissedVerdictSchema = VerdictSchema.extend({ dismissedAt: EpochMsSchema });
export type DismissedVerdict = z.infer<typeof DismissedVerdictSchema>;

// ───────────────────────────── period ─────────────────────────────

const YmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/** `GET /api/sync/health?from=YYYY-MM-DD&to=YYYY-MM-DD`. Both optional; absent = open-ended. Inclusive days. */
export const HealthRangeQuerySchema = z
  .object({ from: YmdSchema.optional(), to: YmdSchema.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type HealthRangeQuery = z.infer<typeof HealthRangeQuerySchema>;

export const HealthReportSchema = z.object({
  generatedAt: EpochMsSchema,
  /**
   * Period the findings are limited to (inclusive local days, null = open-ended). A card counts by its Notion
   * creation date (last edit when unknown); a finding without a card by its MR's creation date.
   */
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  verdicts: z.array(VerdictSchema),
  /** Findings marked as false positives: left out of `verdicts` and the counts. */
  dismissed: z.array(DismissedVerdictSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    bySeverity: z.record(SeveritySchema, z.number().int().nonnegative()),
    /** Cards evaluated (non-archived). */
    cards: z.number().int().nonnegative(),
  }),
  /** Cards for which no rule-table row applies: surfaced instead of silently treated as healthy. */
  unruled: z.array(UnruledSchema),
  families: z.array(FamilyTreeSchema),
  chips: z.array(ParentChipSchema),
  timing: z.array(MrTimingSchema),
  reviewLatency: ReviewLatencySchema,
  releaseFacts: z.array(ReleaseFactSchema),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;
