import { z } from 'zod';
import { EpochMsSchema, ExtRepoIdSchema } from './common';
import { SecretSchema } from './config';

/**
 * Reviews (the reviewer's desk): merge requests in ANY GitLab project where I am a reviewer or was mentioned, read
 * with a personal access token (`read_api` to look, `api` to comment or approve). Sources:
 *  - `GET /merge_requests?scope=reviews_for_me&state=opened`   (I am a reviewer)
 *  - `GET /todos?state=pending&type=MergeRequest`             (mentioned, addressed, review requested, ...)
 * Local marks (`reviewed up to <sha>`, snooze) live in this app only; nothing about them is written to GitLab.
 */

/** GitLab to-do `action_name`s that put an MR on the desk, plus `reviewer` (on the MR's reviewer list). */
export const REVIEW_REASONS = [
  'reviewer',
  'review_requested',
  'directly_addressed',
  'mentioned',
  'approval_required',
  'assigned',
] as const;
export const ReviewReasonSchema = z.enum(REVIEW_REASONS);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

/**
 * Where an MR sits on the desk. `needs_you`: asked and not looked at yet, or asked again since. `changed`: new commits
 * since you marked it reviewed. `mentioned`: only mentioned, no review asked. `waiting`: you reviewed this version, the
 * author is up (drafts sit here too). `approved`: you approved this version. `snoozed`: hidden until a time you chose.
 */
export const REVIEW_LANES = [
  'needs_you',
  'changed',
  'mentioned',
  'waiting',
  'approved',
  'snoozed',
] as const;
export const ReviewLaneSchema = z.enum(REVIEW_LANES);
export type ReviewLane = z.infer<typeof ReviewLaneSchema>;

export const ReviewTodoSchema = z.object({
  id: z.number().int().positive(),
  action: z.string(),
  author: z.string().nullable(),
  /** Plain text of the note that raised it (user content, clipped): render as text. */
  body: z.string().nullable(),
  createdAt: EpochMsSchema,
});
export type ReviewTodo = z.infer<typeof ReviewTodoSchema>;

/**
 * How an MR reaches the desk. `webhook`: its project sent a webhook recently (configured repo, or the Reviews hook on a
 * group/project), so changes arrive instantly. `poll`: no webhook reaches the dashboard for it, so it is only seen by
 * the once-a-minute to-do check; `reason` says why, in plain words.
 */
export const REVIEW_SOURCE_REASONS = ['not_configured', 'no_delivery', 'stale_delivery'] as const;
export const ReviewSourceReasonSchema = z.enum(REVIEW_SOURCE_REASONS);
export type ReviewSourceReason = z.infer<typeof ReviewSourceReasonSchema>;

export const ReviewSourceSchema = z.object({
  via: z.enum(['webhook', 'poll']),
  /** null when `via` is `webhook`. */
  reason: ReviewSourceReasonSchema.nullable(),
  /** The configured repo id for this project, when there is one (links to its webhook settings). */
  repoId: z.string().nullable(),
  /** Last webhook delivery seen for the project; null = never. */
  lastDeliveryAt: EpochMsSchema.nullable(),
});
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

/** A webhook older than this no longer counts: the project falls back to polling. */
export const REVIEW_WEBHOOK_FRESH_MS = 3 * 24 * 3_600_000;
export const REVIEW_POLL_MS = 60_000;

export const ReviewDeskItemSchema = z.object({
  /** `<projectId>!<iid>`. */
  key: z.string(),
  /** `~<projectId>`: open it with the review routes and MR writes. */
  repoId: ExtRepoIdSchema,
  projectId: z.number().int().positive(),
  /** `group/project`, from the MR's references (or the project id when unknown). */
  projectPath: z.string(),
  iid: z.number().int().positive(),
  title: z.string(),
  author: z.string().nullable(),
  authorName: z.string().nullable(),
  webUrl: z.string().nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  draft: z.boolean(),
  hasConflicts: z.boolean(),
  /** GitLab `detailed_merge_status`, e.g. `mergeable`, `ci_still_running`, `not_approved`. */
  mergeStatus: z.string().nullable(),
  labels: z.array(z.string()),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema.nullable(),
  headSha: z.string().nullable(),
  notes: z.number().int().nonnegative(),
  reasons: z.array(ReviewReasonSchema),
  todos: z.array(ReviewTodoSchema),
  /** When I was first asked (oldest to-do, else the MR's creation): drives the "waiting for you" age. */
  askedAt: EpochMsSchema,
  /** null = the approvals could not be read. */
  approvedByMe: z.boolean().nullable(),
  approvedBy: z.array(z.string()),
  approvalsLeft: z.number().int().nonnegative().nullable(),
  lastReviewedSha: z.string().nullable(),
  lastReviewedAt: EpochMsSchema.nullable(),
  snoozedUntil: EpochMsSchema.nullable(),
  lane: ReviewLaneSchema,
  source: ReviewSourceSchema,
});
export type ReviewDeskItem = z.infer<typeof ReviewDeskItemSchema>;

export const ReviewDeskSchema = z.object({
  generatedAt: EpochMsSchema,
  /** Last successful read of GitLab; null = never. */
  fetchedAt: EpochMsSchema.nullable(),
  /** A personal token is saved. */
  tokenSet: z.boolean(),
  /** The GitLab user the token belongs to (read at save time). */
  username: z.string().nullable(),
  items: z.array(ReviewDeskItemSchema),
  /** Plain-language problems of the last read (never secret). */
  errors: z.array(z.string()),
  /** Reading GitLab right now. */
  refreshing: z.boolean(),
  polling: z.object({
    /** The once-a-minute to-do check is running (feature on, token saved, `reviews.poll` on). */
    active: z.boolean(),
    intervalMs: z.number().int().positive(),
    lastPollAt: EpochMsSchema.nullable(),
    /** Desk items that only the poll can see. */
    polledItems: z.number().int().nonnegative(),
  }),
  /** The Reviews webhook (for groups or projects that are not configured repos). */
  webhook: z.object({
    /** `<public base URL>/webhook/~reviews`, or null when no public URL is set. */
    url: z.string().nullable(),
    secretSet: z.boolean(),
    lastDeliveryAt: EpochMsSchema.nullable(),
  }),
});
export type ReviewDesk = z.infer<typeof ReviewDeskSchema>;

export const ReviewTokenStatusSchema = z.object({
  tokenSet: z.boolean(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  /** Token scopes GitLab reported, when it reports them. */
  scopes: z.array(z.string()),
  /** `api` scope present: comments and approvals can be sent. */
  canWrite: z.boolean(),
  expiresAt: z.string().nullable(),
});
export type ReviewTokenStatus = z.infer<typeof ReviewTokenStatusSchema>;

/** `token: null` clears it. */
export const ReviewTokenRequestSchema = z.object({ token: SecretSchema.nullable() });
export type ReviewTokenRequest = z.infer<typeof ReviewTokenRequestSchema>;

export const ReviewMarkRequestSchema = z.object({
  /** The head SHA I reviewed; null clears the mark. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
});
export type ReviewMarkRequest = z.infer<typeof ReviewMarkRequestSchema>;

export const ReviewSnoozeRequestSchema = z.object({
  /** Epoch ms to wake up at; null wakes it now. */
  until: EpochMsSchema.nullable(),
});
export type ReviewSnoozeRequest = z.infer<typeof ReviewSnoozeRequestSchema>;

export const REVIEW_SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Plain-language reason a desk item is polled (shown on the item and in the desk banner). */
export function reviewSourceText(s: ReviewSource, projectPath: string): string {
  switch (s.reason) {
    case 'not_configured':
      return `${projectPath} is not one of your repos and no Reviews webhook reaches it, so the dashboard checks GitLab once a minute instead.`;
    case 'no_delivery':
      return `${projectPath} is a configured repo, but its webhook has never reached the dashboard. Check Settings > Repos > Webhook health.`;
    case 'stale_delivery':
      return `${projectPath} sent no webhook in the last 3 days, so it may not reach the dashboard any more. Check Settings > Repos > Webhook health.`;
    default:
      return 'Changes arrive instantly through a webhook.';
  }
}
