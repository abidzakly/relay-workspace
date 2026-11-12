import { z } from 'zod';
import { BranchNameSchema, BranchPrefixSchema, UsernameSchema } from './common';

/**
 * Edition presets: `editions/<name>/presets.json` in the repo. Read once at server start. `global` is a partial of the
 * global settings and becomes the defaults until the first Settings save (after that, the saved settings win and the
 * presets are never read again). `repo` pre-fills the "Add repository" form. Nothing else in the code knows about
 * editions.
 */
export const RepoPresetsSchema = z
  .object({
    reviewers: z.array(UsernameSchema).optional(),
    versionBranchPrefix: BranchPrefixSchema.optional(),
    baseBranch: BranchNameSchema.optional(),
  })
  .strict();
export type RepoPresets = z.infer<typeof RepoPresetsSchema>;

export const PresetsFileSchema = z
  .object({
    global: z.record(z.string(), z.unknown()).default({}),
    repo: RepoPresetsSchema.default({}),
  })
  .strict();
export type PresetsFile = z.infer<typeof PresetsFileSchema>;
