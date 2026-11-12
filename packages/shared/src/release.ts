import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema } from './common';

/**
 * Pending-release detection, served by `GET /api/release/:repo` and in `GET /api/state`.
 * `status: 'unknown'` means the dashboard cannot tell: `pendingMrs` is empty and `needsVersionBump` is false
 * because nothing is claimed, not because nothing is pending. `reason` says why.
 */

/**
 *  `never_checked`   no successful check yet (GitLab not configured, or before the first sync)
 *  `stale`           the last successful check is too old to trust
 *  `list_incomplete` the merged-MR list could not be read far enough (page limit)
 *  `no_boundary`     no version MR exists and the pubspec/tag fallback gives no answer
 */
export const RELEASE_UNKNOWN_REASONS = [
  'never_checked',
  'stale',
  'list_incomplete',
  'no_boundary',
] as const;
export const ReleaseUnknownReasonSchema = z.enum(RELEASE_UNKNOWN_REASONS);
export type ReleaseUnknownReason = z.infer<typeof ReleaseUnknownReasonSchema>;

/** Where the boundary came from: step 2 (`version_mr`), step 4 (`head_commit`), step 5 (`tag`). */
export const RELEASE_BOUNDARY_SOURCES = ['version_mr', 'head_commit', 'tag'] as const;

export const ReleaseBoundarySchema = z.object({
  source: z.enum(RELEASE_BOUNDARY_SOURCES),
  version: z.string(),
  /** `merged_at` of the version MR; time of the head check; committed date of the tag. */
  at: EpochMsSchema,
  /** Version MR only. */
  iid: z.number().int().positive().nullable(),
  sourceBranch: z.string().nullable(),
  webUrl: z.string().nullable(),
});
export type ReleaseBoundary = z.infer<typeof ReleaseBoundarySchema>;

export const PendingMrSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  sourceBranch: z.string(),
  author: z.string().nullable(),
  webUrl: z.string().nullable(),
  mergedAt: EpochMsSchema,
});
export type PendingMr = z.infer<typeof PendingMrSchema>;

export const PendingCardSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  /** The card's status is Complete: only these make the update-version button appear. */
  complete: z.boolean(),
  /** Already the configured Ready to Test status. */
  ready: z.boolean(),
  /** A link of this card is flagged (mismatch/duplicate). Shown, never auto-resolved. */
  conflict: z.boolean(),
  /** The pending MRs of this repo linked to the card. */
  mrIids: z.array(z.number().int().positive()),
});
export type PendingCard = z.infer<typeof PendingCardSchema>;

/** Outcome of the pubspec-vs-latest-tag fallback, used only when no boundary exists. */
export const RELEASE_FALLBACK_KINDS = [
  'tag_match',
  'tag_mismatch',
  'no_tags',
  'unavailable',
] as const;
export const ReleaseFallbackSchema = z.object({
  kind: z.enum(RELEASE_FALLBACK_KINDS),
  pubspecVersion: z.string().nullable(),
  latestTag: z.string().nullable(),
  /** Committed date of the tag's commit. */
  tagAt: EpochMsSchema.nullable(),
});
export type ReleaseFallback = z.infer<typeof ReleaseFallbackSchema>;

export const PendingReleaseSchema = z.object({
  repoId: RepoIdSchema,
  baseBranch: z.string(),
  status: z.enum(['ok', 'unknown']),
  reason: ReleaseUnknownReasonSchema.nullable(),
  /** null with status `ok` = no release ever happened: every merged MR is pending. */
  boundary: ReleaseBoundarySchema.nullable(),
  /** Newest first. */
  pendingMrs: z.array(PendingMrSchema),
  pendingCards: z.array(PendingCardSchema),
  /** `pendingMrs.length > 0`. */
  needsVersionBump: z.boolean(),
  /** The update-version button: `needsVersionBump` and at least one pending card is Complete. */
  showUpdateVersion: z.boolean(),
  /** The newest fetched head commit of the base branch is a version update (quick check step 4). */
  headIsVersionUpdate: z.boolean(),
  fallback: ReleaseFallbackSchema.nullable(),
  /** Last check attempt / last check that could be trusted. */
  checkedAt: EpochMsSchema.nullable(),
  lastOkAt: EpochMsSchema.nullable(),
  /** The last attempt's failure (service message only, free of secrets). */
  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
  warnings: z.array(z.string()),
});
export type PendingRelease = z.infer<typeof PendingReleaseSchema>;
