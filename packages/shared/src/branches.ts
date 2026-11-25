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
  sha: z.string().nullable(),
  committedAt: EpochMsSchema.nullable(),
  author: z.string().nullable(),
  subject: z.string().nullable(),
  /** Local branch against its upstream. null = no upstream, or remote only. `gone` = upstream deleted. */
  track: z
    .object({ ahead: z.number().int(), behind: z.number().int(), gone: z.boolean() })
    .nullable(),
});
export type LocalBranch = z.infer<typeof LocalBranchSchema>;

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
