import { z } from 'zod';
import { BranchNameSchema, RepoIdSchema } from './common';

/**
 * "Run this branch": put a repo's workspace on the Mac on an MR's source branch before the app runs on a device.
 * The branch is fetched and tracked when it is not local yet.
 */

/** Why `git fetch origin` failed. `network` is usually the VPN being off. */
export const FetchFailureReasonSchema = z.enum(['network', 'auth', 'unknown']);
export type FetchFailureReason = z.infer<typeof FetchFailureReasonSchema>;

export const FetchFailureSchema = z.object({
  reason: FetchFailureReasonSchema,
  /** First lines of git's stderr, secret-free (git never prints credentials). */
  message: z.string(),
});
export type FetchFailure = z.infer<typeof FetchFailureSchema>;

export const RunBranchBodySchema = z.object({ repo: RepoIdSchema, branch: BranchNameSchema });
export type RunBranchBody = z.infer<typeof RunBranchBodySchema>;

export const RunBranchResultSchema = z.object({
  /** The workspace now on `branch` (a worktree when one already held it). */
  workspaceId: z.string(),
  branch: z.string(),
  /** False when the local branch could not be fast-forwarded to origin. */
  synced: z.boolean(),
  /** Set when origin could not be reached: the local copy was used and may be stale. */
  fetchFailed: FetchFailureSchema.nullable(),
});
export type RunBranchResult = z.infer<typeof RunBranchResultSchema>;
