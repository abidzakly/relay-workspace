import { z } from 'zod';
import { BranchNameSchema, EpochMsSchema, RepoIdSchema } from './common';
import { FetchFailureSchema } from './runBranch';

/**
 * Branches page: every branch of a repo, wherever it came from (Relay, an IDE, a colleague), local and remote, with its
 * MR and card. Each row can run on a device, open a Test Bench, create an MR or link a Notion card.
 */

/** One branch as the workspace on the Mac sees it (`git for-each-ref`). */
export const LocalBranchSchema = z.object({
  name: z.string(),
  local: z.boolean(),
  /** `origin/<name>` exists (as of the last fetch). */
  remote: z.boolean(),
  /** Checked out in the repo workspace. */
  current: z.boolean(),
  /** The worktree that has it checked out (the repo workspace's own path when `current`). Older agents: null. */
  worktreePath: z.string().nullable().default(null),
  sha: z.string().nullable(),
  committedAt: EpochMsSchema.nullable(),
  author: z.string().nullable(),
  /** Lower-cased; absent from an older host agent. */
  authorEmail: z.string().nullable().default(null),
  subject: z.string().nullable(),
  /** Local branch against its upstream. null = no upstream, or remote only. `gone` = upstream deleted. */
  track: z
    .object({ ahead: z.number().int(), behind: z.number().int(), gone: z.boolean() })
    .nullable(),
});
export type LocalBranch = z.infer<typeof LocalBranchSchema>;

/** `list-branches` on the host: the refs plus whose commits are "mine" (the workspace's `git config user.email`). */
export const LocalBranchListSchema = z.object({
  branches: z.array(LocalBranchSchema),
  me: z.string().nullable(),
});
export type LocalBranchList = z.infer<typeof LocalBranchListSchema>;

export const BranchSourceStateSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export type BranchSourceState = z.infer<typeof BranchSourceStateSchema>;

export const BranchCardRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  status: z.string().nullable(),
  /** Linked in Relay (not by the card's Branch formula). */
  linked: z.boolean(),
});
export type BranchCardRef = z.infer<typeof BranchCardRefSchema>;

export const BranchRowSchema = LocalBranchSchema.extend({
  /** The repo's base branch (`main`): no MR, no card. */
  isBase: z.boolean(),
  /** GitLab says it is merged into the default branch. */
  merged: z.boolean(),
  /** Protected on GitLab: never deleted from Relay. */
  protected: z.boolean().default(false),
  /** The head commit is the user's (by email). null = cannot tell. */
  mine: z.boolean().nullable().default(null),
  mr: z
    .object({
      iid: z.number().int(),
      title: z.string(),
      draft: z.boolean(),
      targetBranch: z.string(),
      webUrl: z.string().nullable(),
    })
    .nullable(),
  card: BranchCardRefSchema.nullable(),
  /** Checked out in another worktree: deleting the branch needs that worktree gone first. */
  holder: z
    .object({
      path: z.string(),
      /** Its cockpit workspace, when Relay knows it. */
      workspaceId: z.string().nullable(),
      name: z.string(),
      /** Made by Relay (under `.cockpit-worktrees`): Relay may remove it. */
      managed: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type BranchRow = z.infer<typeof BranchRowSchema>;

export const BranchListResultSchema = z.object({
  repoId: z.string(),
  baseBranch: z.string(),
  /** The repo workspace on the Mac the local refs come from. null = none holds the repo. */
  workspaceId: z.string().nullable(),
  rows: z.array(BranchRowSchema),
  sources: z.object({ local: BranchSourceStateSchema, remote: BranchSourceStateSchema }),
  /** GitLab listed more branches than one read returns. */
  truncated: z.boolean(),
  /** The workspace's `git config user.email`: what "mine" is compared with. */
  meEmail: z.string().nullable().default(null),
});
export type BranchListResult = z.infer<typeof BranchListResultSchema>;

export const BranchRepoQuerySchema = z.object({ repo: RepoIdSchema });
export const BranchFetchBodySchema = z.object({ repo: RepoIdSchema });
export const BranchFetchResultSchema = z.object({ fetchFailed: FetchFailureSchema.nullable() });
export type BranchFetchResult = z.infer<typeof BranchFetchResultSchema>;

export const CardLinkBodySchema = z.object({
  repo: RepoIdSchema,
  branch: BranchNameSchema,
  cardId: z.string().min(1).max(100),
});
export type CardLinkBody = z.infer<typeof CardLinkBodySchema>;
export const CardUnlinkBodySchema = z.object({ repo: RepoIdSchema, branch: BranchNameSchema });

/** Delete a branch on the Mac, on origin, or both. Remote needs `confirmName` when the branch is not the user's. */
export const BranchDeleteBodySchema = z
  .object({
    repo: RepoIdSchema,
    branch: BranchNameSchema,
    local: z.boolean(),
    remote: z.boolean(),
    /** `git branch -D`: drop commits no other branch has (and a held worktree's uncommitted changes). */
    force: z.boolean().default(false),
    /** The branch is checked out in a Relay worktree: remove that worktree first. */
    removeWorktree: z.boolean().default(false),
    /** The branch is checked out in the repo workspace: switch it to this (the base branch) first. */
    switchTo: BranchNameSchema.optional(),
    confirmName: z.string().max(255).optional(),
  })
  .refine((b) => b.local || b.remote, 'pick where to delete');
export type BranchDeleteBody = z.input<typeof BranchDeleteBodySchema>;

const DeletePartSchema = z.union([
  z.object({ state: z.enum(['deleted', 'simulated', 'skipped']) }),
  z.object({ state: z.literal('failed'), code: z.string(), message: z.string() }),
]);
export const BranchDeleteResultSchema = z.object({
  local: DeletePartSchema,
  remote: DeletePartSchema,
  /** The head the branch pointed at, to recover it (`git branch <name> <sha>`). */
  sha: z.string().nullable(),
});
export type BranchDeleteResult = z.infer<typeof BranchDeleteResultSchema>;
