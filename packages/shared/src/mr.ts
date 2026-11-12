import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema, UsernameSchema } from './common';

/** GitLab MR `state` values (documented: opened, closed, locked, merged). */
export const MR_STATES = ['opened', 'closed', 'locked', 'merged'] as const;
export const MrStateSchema = z.enum(MR_STATES);
export type MrState = z.infer<typeof MrStateSchema>;

/**
 * Derived MR state used by the Sync Health rules.
 * `none` = the card has no linked MR.
 */
export const MR_DERIVED_STATES = [
  'none',
  'open',
  'draft',
  'reviewed',
  'approved',
  'merged',
  'closed',
] as const;
export const MrDerivedStateSchema = z.enum(MR_DERIVED_STATES);
export type MrDerivedState = z.infer<typeof MrDerivedStateSchema>;

export const HeadPipelineSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  webUrl: z.string().nullable(),
});
export type HeadPipeline = z.infer<typeof HeadPipelineSchema>;

/** Cached MR. Primary key is (repoId, iid). */
export const MrSchema = z.object({
  repoId: RepoIdSchema,
  iid: z.number().int().positive(),
  /** GitLab global MR id. */
  gitlabId: z.number().int().positive().nullable(),
  title: z.string(),
  state: MrStateSchema,
  draft: z.boolean(),
  hasConflicts: z.boolean(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  author: UsernameSchema.nullable(),
  webUrl: z.string().nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema.nullable(),
  mergedAt: EpochMsSchema.nullable(),
  /** Notion page id extracted from the MR description (first match). */
  descriptionNotionId: NotionIdSchema.nullable(),
  /** Usernames that approved (from the approvals API / fallback mode). */
  approvedBy: z.array(z.string()),
  /** GitLab usernames assigned to / asked to review the MR. Used to decide which MRs are mine. */
  assignees: z.array(z.string()),
  reviewers: z.array(z.string()),
  lastNoteAt: EpochMsSchema.nullable(),
  headPipeline: HeadPipelineSchema.nullable(),
  syncedAt: EpochMsSchema,
});
export type Mr = z.infer<typeof MrSchema>;

/** Cached MR note. */
export const NoteSchema = z.object({
  repoId: RepoIdSchema,
  mrIid: z.number().int().positive(),
  noteId: z.number().int().positive(),
  discussionId: z.string(),
  author: z.string().nullable(),
  body: z.string(),
  system: z.boolean(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema.nullable(),
  /** false = unread in the dashboard. */
  seen: z.boolean(),
  /** Live reads only (not cached): display name, GitLab avatar URL, edited after posting, a lone comment. */
  authorName: z.string().nullable().optional(),
  authorAvatar: z.string().nullable().optional(),
  edited: z.boolean().optional(),
  individual: z.boolean().optional(),
});
export type Note = z.infer<typeof NoteSchema>;
