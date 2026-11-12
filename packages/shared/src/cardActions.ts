import { z } from 'zod';
import { NotionIdSchema, RepoIdSchema } from './common';

/**
 * Card status changes, one-click Fixes and their confirmation step.
 *
 * Notion writes are never automatic. Every write is two calls:
 *   1. `…/preview`  (nothing is written): the server reads the live card, answers with `before -> after` and a
 *                   single-use `confirmToken` bound to exactly that change;
 *   2. the write    (`PATCH /api/cards/:id/status`, `POST /api/sync/fix`): needs the token from step 1, which the UI
 *                   only has after the user opened the confirm dialog.
 */

/** Hex, issued by the server (`randomBytes(24)`). Opaque to the client. */
export const CONFIRM_TOKEN_RE = /^[0-9a-f]{32,128}$/;
export const ConfirmTokenSchema = z.string().regex(CONFIRM_TOKEN_RE, 'invalid confirmation token');

/** A status name (Notion option name). Matched case/whitespace-insensitively by the server. */
export const StatusNameSchema = z.string().trim().min(1).max(100);

export const CardStatusPreviewRequestSchema = z.object({ status: StatusNameSchema }).strict();
export type CardStatusPreviewRequest = z.infer<typeof CardStatusPreviewRequestSchema>;

export const CardStatusRequestSchema = z
  .object({ status: StatusNameSchema, confirmToken: ConfirmTokenSchema })
  .strict();
export type CardStatusRequest = z.infer<typeof CardStatusRequestSchema>;

/**
 * Identifies one verdict of `GET /api/sync/health` together with `ruleId` (the same triple the verdict carries).
 * The server re-derives the verdict (and its fix payload) itself: the client never sends a fix to execute.
 */
export const SyncFixTargetSchema = z
  .object({
    cardId: NotionIdSchema.nullable(),
    repoId: RepoIdSchema.nullable(),
    mrIid: z.number().int().positive().nullable(),
  })
  .strict();
export type SyncFixTarget = z.infer<typeof SyncFixTargetSchema>;

export const SyncFixPreviewRequestSchema = z
  .object({
    ruleId: z.string().min(1).max(100),
    target: SyncFixTargetSchema,
    /** 0 = the verdict's primary `fix`, 1.. = `alternatives[i-1]`. */
    fixIndex: z.number().int().min(0).max(20).default(0),
  })
  .strict();
export type SyncFixPreviewRequest = z.infer<typeof SyncFixPreviewRequestSchema>;

export const SyncFixRequestSchema = SyncFixPreviewRequestSchema.extend({
  confirmToken: ConfirmTokenSchema,
}).strict();
export type SyncFixRequest = z.infer<typeof SyncFixRequestSchema>;

/** What the confirm dialog shows (and what the token is bound to). */
export const CardWritePreviewSchema = z.object({
  /** Single-use, expires at `expiresAt`. */
  confirmToken: ConfirmTokenSchema,
  expiresAt: z.number().int().nonnegative(),
  action: z.literal('card.status'),
  cardId: NotionIdSchema,
  cardTitle: z.string(),
  /** The Notion property being written, e.g. `Status`. */
  field: z.string(),
  /** Status as Notion has it right now (null = empty). */
  before: z.string().nullable(),
  /** The configured spelling that will be written. */
  after: z.string(),
  /** `live` = read from Notion just now; `cache` = Notion unreachable, dry-run only. */
  source: z.enum(['live', 'cache']),
  /** The global dry-run switch is ON: confirming simulates the write (audited as dry-run). */
  dryRun: z.boolean(),
  /** Set for a Fix: the rule that suggested it. */
  ruleId: z.string().nullable(),
  /** Situational notes, e.g. the cache was behind Notion. */
  warnings: z.array(z.string()),
});
export type CardWritePreview = z.infer<typeof CardWritePreviewSchema>;

export const CardStatusResultSchema = z.object({
  /** true = simulated (global dry-run): nothing was sent to Notion, the audit row says so. */
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  cardId: NotionIdSchema,
  before: z.string().nullable(),
  after: z.string(),
  /** The audit row carries an undo token (`POST /api/audit/:auditId/undo`). Never in dry-run. */
  undoable: z.boolean(),
  ruleId: z.string().nullable(),
});
export type CardStatusResult = z.infer<typeof CardStatusResultSchema>;

/** `409 undo_conflict` body details: the card was edited elsewhere after our write. */
export const UndoConflictDetailsSchema = z.object({
  /** What our write left behind (and what must still be there to undo). */
  expected: z.string().nullable(),
  /** What Notion has now. */
  actual: z.string().nullable(),
});
export type UndoConflictDetails = z.infer<typeof UndoConflictDetailsSchema>;

/**
 * Bulk "Ready to Test". Same two steps as a single change: `POST /api/cards/bulk-ready/preview` reads
 * every card live and issues one single-use token for that exact picture; `POST /api/cards/bulk-ready` needs it.
 *  - already Ready to Test -> skipped;
 *  - Complete              -> updated;
 *  - any other status      -> only when its id is listed in `includeWarned` (a ticked, default-unticked checkbox).
 */
export const BULK_READY_MAX_CARDS = 100;

export const BulkReadyPreviewRequestSchema = z
  .object({ cardIds: z.array(NotionIdSchema).min(1).max(BULK_READY_MAX_CARDS) })
  .strict();
export type BulkReadyPreviewRequest = z.infer<typeof BulkReadyPreviewRequestSchema>;

export const BulkReadyRequestSchema = BulkReadyPreviewRequestSchema.extend({
  /** The warned cards the user ticked. Must be a subset of `cardIds`. */
  includeWarned: z.array(NotionIdSchema).max(BULK_READY_MAX_CARDS).default([]),
  confirmToken: ConfirmTokenSchema,
}).strict();
export type BulkReadyRequest = z.infer<typeof BulkReadyRequestSchema>;

/**
 * `ready` = skipped, `complete` = will be updated, `warned` = other status (needs a tick),
 * `unavailable` = cannot be written (archived, not cached, read failed); see `reason`.
 */
export const BulkReadyKindSchema = z.enum(['ready', 'complete', 'warned', 'unavailable']);
export type BulkReadyKind = z.infer<typeof BulkReadyKindSchema>;

export const BulkFailureSchema = z.object({ code: z.string(), message: z.string() });
export type BulkFailure = z.infer<typeof BulkFailureSchema>;

export const BulkReadyPreviewItemSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  /** Status as Notion has it right now (null = empty, or unknown when `unavailable`). */
  before: z.string().nullable(),
  kind: BulkReadyKindSchema,
  /** `cache` = Notion unreachable, dry-run only. */
  source: z.enum(['live', 'cache']),
  /** Only for `unavailable`. */
  reason: BulkFailureSchema.nullable(),
});
export type BulkReadyPreviewItem = z.infer<typeof BulkReadyPreviewItemSchema>;

export const BulkReadyPreviewSchema = z.object({
  confirmToken: ConfirmTokenSchema,
  expiresAt: z.number().int().nonnegative(),
  action: z.literal('card.bulkReady'),
  /** The configured Ready to Test spelling that will be written. */
  after: z.string(),
  /** The Notion property being written. */
  field: z.string(),
  dryRun: z.boolean(),
  items: z.array(BulkReadyPreviewItemSchema),
});
export type BulkReadyPreview = z.infer<typeof BulkReadyPreviewSchema>;

/**
 * What happened to one card. `failed` = Notion refused this card; `not_attempted` = the batch stopped early on an
 * error every later card would hit too. Neither of them wrote anything, so running the batch again is safe.
 */
export const BulkReadyOutcomeSchema = z.enum([
  'updated',
  'skipped_ready',
  'skipped_warned',
  'unavailable',
  'failed',
  'not_attempted',
]);
export type BulkReadyOutcome = z.infer<typeof BulkReadyOutcomeSchema>;

export const BulkReadyResultItemSchema = z.object({
  cardId: NotionIdSchema,
  title: z.string(),
  before: z.string().nullable(),
  outcome: BulkReadyOutcomeSchema,
  /** The card's own audit row (only for `updated`). */
  auditId: z.number().int().positive().nullable(),
  failure: BulkFailureSchema.nullable(),
});
export type BulkReadyResultItem = z.infer<typeof BulkReadyResultItemSchema>;

export const BulkReadyResultSchema = z.object({
  /** true = simulated (global dry-run): nothing was sent to Notion. */
  dryRun: z.boolean(),
  /** null when no card was changed (no audit rows exist). */
  batchId: z.string().nullable(),
  /** The batch's audit row: `POST /api/audit/:undoAuditId/undo` is "Undo bulk". Null when nothing can be undone. */
  undoAuditId: z.number().int().positive().nullable(),
  after: z.string(),
  /** At least one card failed or was not attempted while others may already be changed. */
  partial: z.boolean(),
  items: z.array(BulkReadyResultItemSchema),
});
export type BulkReadyResult = z.infer<typeof BulkReadyResultSchema>;
