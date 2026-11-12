import { z } from 'zod';
import { BranchNameSchema, EpochMsSchema, ReviewRepoIdSchema } from './common';
import { ApprovalModeSchema } from './config';
import { DiscussionNoteSchema, InboxMrSchema, MR_FILE_KINDS } from './inbox';
import { REPLY_BODY_MAX } from './mrActions';

/**
 * Code Reviewer. READ endpoints plus one write:
 *   GET  /api/repos/:repo/branches?search=        branch picker
 *   GET  /api/review/:repo/mr/:iid                an MR's full diff + positioned discussions (live GitLab read)
 *   GET  /api/review/:repo/compare?from=&to=      two branches (GitLab compare)
 *   POST /api/mrs/:repo/:iid/comment              a new diff comment on a line (guardedWrite: dry-run + audit)
 * Diff text and notes are user content: the client renders them as text, never as HTML.
 */

/** One diff file can be huge (minified bundles, lockfiles): past this the text is dropped and `tooLarge` is set. */
export const DIFF_TEXT_MAX = 400_000;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  kind: z.enum(MR_FILE_KINDS),
  /** Unified diff text (hunks only, GitLab style, no `diff --git` header); null when binary / too large / collapsed. */
  diff: z.string().nullable(),
  binary: z.boolean(),
  /** GitLab (or we) refused to return the diff text because it is too big. */
  tooLarge: z.boolean(),
  /** GitLab collapsed the diff (big but not too big): text is absent from this response. */
  collapsed: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffRefsSchema = z.object({
  baseSha: z.string(),
  startSha: z.string(),
  headSha: z.string(),
});
export type DiffRefs = z.infer<typeof DiffRefsSchema>;

/** A line in a diff. `newLine` only = added line, `oldLine` only = removed line, both = context line. */
export const ReviewPositionSchema = z
  .object({
    path: z.string().min(1).max(500),
    oldPath: z.string().min(1).max(500),
    newLine: z.number().int().positive().nullable(),
    oldLine: z.number().int().positive().nullable(),
    /** First line of a multi-line selection (GitLab `line_range.start`); absent = a single line. Read-only. */
    rangeStart: z
      .object({
        newLine: z.number().int().positive().nullable(),
        oldLine: z.number().int().positive().nullable(),
      })
      .nullable()
      .optional(),
    /**
     * The diff version (head commit) this position is on. GitLab moves a thread's position forward on each push
     * while its line still exists, so a thread still on an older head is outdated. Read-only.
     */
    headSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .nullable()
      .optional(),
  })
  .refine((p) => p.newLine !== null || p.oldLine !== null, 'position needs a line');
export type ReviewPosition = z.infer<typeof ReviewPositionSchema>;

export const ReviewDiscussionSchema = z.object({
  id: z.string(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  notes: z.array(DiscussionNoteSchema),
  /** null = a general MR comment (not on a line). */
  position: ReviewPositionSchema.nullable(),
});
export type ReviewDiscussion = z.infer<typeof ReviewDiscussionSchema>;

export const ReviewFilesSchema = z.object({
  files: z.array(DiffFileSchema),
  /** More files exist than were returned. */
  truncated: z.boolean(),
});

/**
 * What the reviewer may do about approving this MR, decided by the server (never by the browser):
 *  - `canApprove`: GitLab identity known, not my own MR, open, not yet approved by me (per the cache).
 *  - `canRevoke`:  approved by me, open, and the repo's approval mode can take an approval back
 *                  (`note_keyword` cannot: a posted note stays).
 * GitLab has the final word at write time; a refusal comes back as an error, never as a fake success.
 */
export const ReviewApprovalSchema = z.object({
  mode: ApprovalModeSchema,
  approvedByMe: z.boolean(),
  canApprove: z.boolean(),
  canRevoke: z.boolean(),
  /** Plain-language reason approving is off (null when it is on). */
  reason: z.string().nullable(),
});
export type ReviewApproval = z.infer<typeof ReviewApprovalSchema>;

export const MrApproveRequestSchema = z.object({ approved: z.boolean() }).strict();
export type MrApproveRequest = z.infer<typeof MrApproveRequestSchema>;

export const MrApproveResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  approved: z.boolean(),
  mode: ApprovalModeSchema,
});
export type MrApproveResult = z.infer<typeof MrApproveResultSchema>;

export const MrReviewSchema = z.object({
  generatedAt: EpochMsSchema,
  /** From the local cache (same shape as the inbox row). */
  mr: InboxMrSchema,
  /** null = GitLab did not report diff refs: comments on lines cannot be posted. */
  diffRefs: DiffRefsSchema.nullable(),
  files: z.array(DiffFileSchema),
  truncated: z.boolean(),
  discussions: z.array(ReviewDiscussionSchema),
  approval: ReviewApprovalSchema,
  /** Plain-language reason a part could not be read live (never secret). */
  errors: z.array(z.string()),
});
export type MrReview = z.infer<typeof MrReviewSchema>;

export const CommitSummarySchema = z.object({
  id: z.string(),
  shortId: z.string(),
  title: z.string(),
  /** Full commit message, where the source gives one. */
  message: z.string().optional(),
  author: z.string().nullable(),
  createdAt: EpochMsSchema.nullable(),
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const CompareQuerySchema = z.object({ from: BranchNameSchema, to: BranchNameSchema });
export type CompareQuery = z.infer<typeof CompareQuerySchema>;

export const CompareReviewSchema = z.object({
  generatedAt: EpochMsSchema,
  /** A configured repo, or `~<projectId>` (Reviews: "what changed since you looked"). */
  repoId: ReviewRepoIdSchema,
  repoName: z.string(),
  from: z.string(),
  to: z.string(),
  /** Newest first, at most `COMMITS_SHOWN`. */
  commits: z.array(CommitSummarySchema),
  commitCount: z.number().int().nonnegative(),
  files: z.array(DiffFileSchema),
  truncated: z.boolean(),
  /** GitLab web URL of the compare page, when the host is known. */
  webUrl: z.string().nullable(),
});
export type CompareReview = z.infer<typeof CompareReviewSchema>;

export const BranchQuerySchema = z.object({ search: z.string().max(100).optional() });

export const BranchSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  protected: z.boolean(),
  merged: z.boolean(),
  committedAt: EpochMsSchema.nullable(),
  /** Head commit SHA (branch poll); absent in older payloads. */
  sha: z.string().nullable().optional(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const BranchListSchema = z.object({
  branches: z.array(BranchSchema),
  truncated: z.boolean(),
});
export type BranchList = z.infer<typeof BranchListSchema>;

export const ReviewCommentRequestSchema = z.object({
  position: ReviewPositionSchema,
  /**
   * The head commit of the diff the reviewer read. When the MR moved on since, line numbers may point elsewhere, so
   * the server refuses (409 `diff_changed`) rather than comment on the wrong line. Absent = not checked.
   */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
  body: z
    .string()
    .max(REPLY_BODY_MAX, `comment is longer than ${REPLY_BODY_MAX} characters`)
    .refine((s) => s.trim().length > 0, 'comment is empty'),
});
export type ReviewCommentRequest = z.infer<typeof ReviewCommentRequestSchema>;

export const ReviewCommentResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  /** The created thread; null in dry-run (or when GitLab's answer was unreadable). */
  discussion: ReviewDiscussionSchema.nullable(),
});
export type ReviewCommentResult = z.infer<typeof ReviewCommentResultSchema>;
