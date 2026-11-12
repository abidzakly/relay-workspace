import { z } from 'zod';
import {
  EpochMsSchema,
  NotionIdSchema,
  RepoIdSchema,
  ReviewRepoIdSchema,
  UsernameSchema,
} from './common';
import { HeadPipelineSchema, MrDerivedStateSchema, MrStateSchema } from './mr';
import { MrTimingSchema } from './health';
import { MatchBySchema } from './link';
import { MergeGateSchema } from './mergeGate';
import { MrStackRefSchema, MrStackSchema } from './mrStack';

/**
 * MR Inbox (`GET /api/mrs`) and MR Detail (`GET /api/mrs/:repo/:iid`) READ-ONLY views.
 * Descriptions and notes are RAW markdown (user content): the client sanitizes before rendering.
 */

export const INBOX_STATE_FILTERS = ['open', 'merged', 'closed', 'all'] as const;
export const InboxStateFilterSchema = z.enum(INBOX_STATE_FILTERS);
export type InboxStateFilter = z.infer<typeof InboxStateFilterSchema>;

export const MrListQuerySchema = z.object({
  repo: RepoIdSchema.optional(),
  /** `open` (default) = opened + locked. */
  state: InboxStateFilterSchema.default('open'),
  /** Only MRs this user approved or commented on. */
  reviewer: UsernameSchema.optional(),
});
export type MrListQuery = z.infer<typeof MrListQuerySchema>;

/** Why an MR needs (or does not need) your action; `rank` 0 = most urgent. Cosmetic: never used by the merge gate. */
export const ACTION_KINDS = [
  'reply_needed',
  'ready_to_merge',
  'review_requested',
  'conflicts',
  'pipeline_failed',
  'waiting_reviewer',
  'draft',
  'open',
  'merged',
  'closed',
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const NeedsActionSchema = z.object({
  kind: ActionKindSchema,
  rank: z.number().int().nonnegative(),
  /** true = the dashboard thinks the ball is in your court. */
  yours: z.boolean(),
  label: z.string(),
});
export type NeedsAction = z.infer<typeof NeedsActionSchema>;

export const MrCardRefSchema = z.object({
  id: NotionIdSchema,
  title: z.string(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  matchBy: MatchBySchema,
  conflict: z.boolean(),
});
export type MrCardRef = z.infer<typeof MrCardRefSchema>;

export const ReviewerStatusSchema = z.object({
  username: z.string(),
  approved: z.boolean(),
  /** Left a human note on the MR. */
  commented: z.boolean(),
  /** When the approval was given (from its note); null if unknown or not approved. */
  approvedAt: EpochMsSchema.nullable().default(null),
});
export type ReviewerStatus = z.infer<typeof ReviewerStatusSchema>;

export const InboxMrSchema = z.object({
  /** A configured repo, or `~<projectId>` for a project reached through Reviews. */
  repoId: ReviewRepoIdSchema,
  repoName: z.string(),
  iid: z.number().int().positive(),
  title: z.string(),
  state: MrStateSchema,
  derivedState: MrDerivedStateSchema.exclude(['none']),
  draft: z.boolean(),
  hasConflicts: z.boolean(),
  isVersionMr: z.boolean(),
  author: z.string().nullable(),
  webUrl: z.string().nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema.nullable(),
  mergedAt: EpochMsSchema.nullable(),
  lastNoteAt: EpochMsSchema.nullable(),
  headPipeline: HeadPipelineSchema.nullable(),
  approvedBy: z.array(z.string()),
  reviewers: z.array(ReviewerStatusSchema),
  /** Human notes not yet seen in the dashboard. */
  unreadNotes: z.number().int().nonnegative(),
  card: MrCardRefSchema.nullable(),
  timing: MrTimingSchema,
  action: NeedsActionSchema,
  /** I am the author, an assignee or a reviewer, or the MR is linked to one of my cards. */
  mine: z.boolean(),
  /** Stacked-MR placement (open MRs only). null/absent = not open or not laid out. */
  stack: MrStackRefSchema.nullable().optional(),
});
export type InboxMr = z.infer<typeof InboxMrSchema>;

export const MrInboxSchema = z.object({
  generatedAt: EpochMsSchema,
  /** Sorted by `action.rank`, then oldest-waiting first. */
  items: z.array(InboxMrSchema),
  /** Filter options (all repos / all configured reviewers), independent of the current filter. */
  repos: z.array(z.object({ id: RepoIdSchema, name: z.string() })),
  reviewers: z.array(z.string()),
  /** Number of MRs that are on your plate (`action.yours`) within the returned items. */
  yoursCount: z.number().int().nonnegative(),
  /** Stacks of size > 1 among the open MRs (parent → child). */
  stacks: z.array(MrStackSchema).optional(),
});
export type MrInbox = z.infer<typeof MrInboxSchema>;

// ───────────────────────────── detail ─────────────────────────────

export const MR_FILE_KINDS = ['added', 'modified', 'renamed', 'deleted'] as const;
export const MrFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  kind: z.enum(MR_FILE_KINDS),
});
export type MrFile = z.infer<typeof MrFileSchema>;

export const DiscussionNoteSchema = z.object({
  id: z.number().int().positive(),
  author: z.string().nullable(),
  /** RAW markdown. */
  body: z.string(),
  createdAt: EpochMsSchema,
  unread: z.boolean(),
  /** Live reads only. */
  authorName: z.string().nullable().optional(),
  /** Same-origin avatar path (`/api/gitlab/avatar?src=…`), or null: draw initials. */
  avatar: z.string().nullable().optional(),
  edited: z.boolean().optional(),
});
export type DiscussionNote = z.infer<typeof DiscussionNoteSchema>;

/** An `!NNN` mention in a comment, resolved from the cache so the client can show "!166 (closed)". */
export const MrRefSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
});
export type MrRef = z.infer<typeof MrRefSchema>;

/** One line of the code a diff thread was left on (text is user content: render as text). */
export const ThreadCodeLineSchema = z.object({
  kind: z.enum(['ctx', 'add', 'del']),
  oldNo: z.number().int().positive().nullable(),
  newNo: z.number().int().positive().nullable(),
  text: z.string(),
});
export type ThreadCodeLine = z.infer<typeof ThreadCodeLineSchema>;

/** The code a reviewer selected for a diff thread (GitLab `position`, incl. a multi-line `line_range`). */
export const ThreadCodeSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  /** The commented line (last line of a range), for the "line N" label. */
  newLine: z.number().int().positive().nullable(),
  oldLine: z.number().int().positive().nullable(),
  /** Empty = the line is not in the current diff (outdated, or the diff could not be read). */
  lines: z.array(ThreadCodeLineSchema),
});
export type ThreadCode = z.infer<typeof ThreadCodeSchema>;

export const DiscussionSchema = z.object({
  id: z.string(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  notes: z.array(DiscussionNoteSchema),
  /** A lone comment (GitLab `individual_note`), not a thread someone started. */
  individual: z.boolean().optional(),
  /** Present for a thread on a diff line (live reads only). */
  code: ThreadCodeSchema.nullable().optional(),
});
export type Discussion = z.infer<typeof DiscussionSchema>;

/** Per section: where the data came from. `cache` = GitLab could not be read live (or is not configured). */
export const SOURCES = ['live', 'cache', 'unavailable'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

export const MrDetailSchema = z.object({
  generatedAt: EpochMsSchema,
  mr: InboxMrSchema,
  /** RAW markdown from GitLab (live only; the description is not cached). */
  description: z.object({ markdown: z.string().nullable(), source: SourceSchema }),
  pipeline: z.object({ value: HeadPipelineSchema.nullable(), source: SourceSchema }),
  approvals: z.object({
    mode: z.string(),
    source: SourceSchema,
    approvedBy: z.array(z.string()),
    /** Cosmetic only (= `gate.allowed`): the merge route re-fetches live and decides. */
    gateLooksOk: z.boolean(),
    /** The merge-gate rule evaluated over this drawer's data. Decides the button state only. */
    gate: MergeGateSchema,
  }),
  files: z.object({
    source: SourceSchema,
    files: z.array(MrFileSchema),
    truncated: z.boolean(),
    /** Why the live read failed (short, never secret); absent when it worked. */
    reason: z.string().max(300).optional(),
  }),
  discussions: z.object({
    source: SourceSchema,
    threads: z.array(DiscussionSchema),
    /** System notes ("added 2 commits", "approved") are not threads; only counted. */
    systemNotes: z.number().int().nonnegative(),
  }),
  /** Same-repo `!NNN` mentions in the description and comments, keyed by iid (cached MRs only). */
  refs: z.record(z.string(), MrRefSchema).optional(),
  /** Usernames that took part (author, reviewers, commenters): seeds the `@` autocomplete. */
  people: z.array(z.object({ username: z.string(), name: z.string().nullable() })).optional(),
  /** Sanitized (secret-free) reasons a live read failed. */
  liveErrors: z.array(z.string()),
});
export type MrDetail = z.infer<typeof MrDetailSchema>;
