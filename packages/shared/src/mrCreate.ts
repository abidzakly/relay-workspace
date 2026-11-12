import { z } from 'zod';
import { MrSummaryOutputSchema } from './ai';
import { BranchNameSchema, EpochMsSchema, RepoIdSchema } from './common';
import { MrStackRefSchema } from './mrStack';

/**
 * "Ready for MR" + Create MR from the app. The MR is EXACTLY the `mrc` workflow:
 * title = branch (= Notion Branch formula), description = full Notion page URL, target = base (`main`),
 * assignee = me, reviewers = the repo's, delete source branch, NO squash, not a draft, no milestone/labels.
 */

export const ReadyCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  status: z.string().nullable(),
});

export const ReadyForMrSchema = z.object({
  repoId: RepoIdSchema,
  repoName: z.string(),
  branch: z.string(),
  sha: z.string(),
  pushedAt: EpochMsSchema,
  actor: z.string().nullable(),
  card: ReadyCardSchema,
  /** Commits in base...branch; null = not read yet. */
  commitCount: z.number().int().nonnegative().nullable(),
  /** Stack placement among open MRs and other ready branches (parent at the bottom). */
  stack: MrStackRefSchema.nullable(),
});
export type ReadyForMr = z.infer<typeof ReadyForMrSchema>;

export const ReadyForMrListSchema = z.object({ items: z.array(ReadyForMrSchema) });
export type ReadyForMrList = z.infer<typeof ReadyForMrListSchema>;

export const MrTemplateSchema = z.object({
  sourceBranch: z.string(),
  targetBranch: z.string(),
  title: z.string(),
  description: z.string(),
  assignee: z.string().nullable(),
  reviewers: z.array(z.string()),
  removeSourceBranch: z.literal(true),
  squash: z.literal(false),
  draft: z.literal(false),
});
export type MrTemplate = z.infer<typeof MrTemplateSchema>;

export const MR_CREATE_WARNINGS = [
  'stack_parent_open',
  'parent_without_mr',
  'no_notion_url',
] as const;

export const MrCreatePreviewSchema = z.object({
  repoId: RepoIdSchema,
  branch: z.string(),
  template: MrTemplateSchema,
  card: ReadyCardSchema.nullable(),
  commitCount: z.number().int().nonnegative(),
  /** Open ancestors: MRs (iid) or branches without MR (iid null). Parent first. */
  parents: z.array(z.object({ iid: z.number().int().positive().nullable(), branch: z.string() })),
  /** 1-based position of this MR in its stack (1 = would be mergeable first). */
  stackPosition: z.number().int().positive(),
  warnings: z.array(z.object({ code: z.enum(MR_CREATE_WARNINGS), message: z.string() })),
  /** true = creation is refused until fixed (parent branch has no MR yet, no Notion URL). */
  blocked: z.boolean(),
  /** Whether a finished Review Deck covers `base...branch` as it is now. */
  deckCompleted: z.boolean(),
  /** The deck was finished, but commits it does not cover arrived since. */
  deckStale: z.boolean(),
  /** An open MR already exists for the branch (409 on create). */
  existingMrIid: z.number().int().positive().nullable(),
  /** The Test Bench gate applies (the server has a Test Bench). */
  testRequired: z.boolean().default(false),
  /** The latest Test Bench run is `ready` and was made on the branch's current HEAD. */
  testOk: z.boolean().default(false),
  /** The run was `ready` but on an older commit. */
  testStale: z.boolean().default(false),
});
export type MrCreatePreview = z.infer<typeof MrCreatePreviewSchema>;

export const MrCreateRequestSchema = z
  .object({
    repoId: RepoIdSchema,
    branch: BranchNameSchema,
    /** Required when the deck was not finished: recorded in the audit log. */
    skipReviewReason: z.string().trim().min(3).max(500).optional(),
    /** Required when the branch was not tested on a device: recorded in the audit log. */
    skipTestReason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type MrCreateRequest = z.infer<typeof MrCreateRequestSchema>;

/** What Create MR did to the branch's Notion card after GitLab accepted the MR. */
export const MrCreateNotionSchema = z.object({
  outcome: z.enum(['updated', 'already_completed', 'failed']),
  /** Status Notion has now, or the status that was already there. Null when the write failed before a read. */
  status: z.string().nullable(),
  error: z.string().nullable(),
});
export type MrCreateNotion = z.infer<typeof MrCreateNotionSchema>;

export const MrCreateResultSchema = z.object({
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  iid: z.number().int().positive().nullable(),
  webUrl: z.string().nullable(),
  /** true = GitLab answered 409: an MR for this branch already existed. */
  existed: z.boolean(),
  /**
   * Notion card for this branch, after a real MR exists. Null in a dry run, or when no card / no iid came back.
   * `already_completed` means the live status was already Completed (or the workspace's Completed spelling).
   */
  notion: MrCreateNotionSchema.nullable(),
});
export type MrCreateResult = z.infer<typeof MrCreateResultSchema>;

/** Earlier messages sent with a follow-up question. The client trims to this; the server keeps nothing. */
export const MR_CHAT_MAX_HISTORY = 40;
export const MR_CHAT_MAX_MESSAGE = 20_000;

export const MrChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(MR_CHAT_MAX_MESSAGE),
  })
  .strict();
export type MrChatMessage = z.infer<typeof MrChatMessageSchema>;

/** A follow-up question about the AI summary on the Create MR screen. */
export const MrChatRequestSchema = z
  .object({
    repo: RepoIdSchema,
    branch: BranchNameSchema,
    summary: MrSummaryOutputSchema,
    history: z.array(MrChatMessageSchema).max(MR_CHAT_MAX_HISTORY),
    question: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type MrChatRequest = z.infer<typeof MrChatRequestSchema>;
