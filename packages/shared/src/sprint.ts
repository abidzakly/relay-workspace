import { z } from 'zod';
import { MrDerivedStateSchema } from './mr';

/**
 * Sprint Harbor (`GET /api/sprints`). A sprint = my cards sharing a Notion `Select Sprint` value, limited to Product
 * Domains whose repo is connected. Each task carries its MRs and sub-tasks.
 */

/** Where a task sits in the harbor: quay = not started, crane = being worked, deck = in review, sealed = with QA. */
export const DOCK_STAGES = ['quay', 'crane', 'deck', 'sealed'] as const;
export const DockStageSchema = z.enum(DOCK_STAGES);
export type DockStage = z.infer<typeof DockStageSchema>;

export const SprintMrSchema = z.object({
  repoId: z.string(),
  iid: z.int().positive(),
  title: z.string(),
  state: MrDerivedStateSchema,
  webUrl: z.string().nullable(),
});
export type SprintMr = z.infer<typeof SprintMrSchema>;

export const SprintSubTaskSchema = z.object({
  id: z.string(),
  /** null = not in the local cache (not assigned to me): only the Notion link is known. */
  title: z.string().nullable(),
  status: z.string().nullable(),
  stage: DockStageSchema.nullable(),
  url: z.string().nullable(),
  point: z.number().nullable(),
});
export type SprintSubTask = z.infer<typeof SprintSubTaskSchema>;

export const SprintTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  stage: DockStageSchema,
  /** Status reads as blocked / on hold. */
  blocked: z.boolean(),
  point: z.number().nullable(),
  project: z.string(),
  repoId: z.string(),
  mrs: z.array(SprintMrSchema),
  subTasks: z.array(SprintSubTaskSchema),
});
export type SprintTask = z.infer<typeof SprintTaskSchema>;

export const SprintSchema = z.object({
  name: z.string(),
  projects: z.array(z.string()),
  tasks: z.array(SprintTaskSchema),
  capacityHours: z.number(),
  /** Estimated hours of every task and known sub-task (Point → hours). */
  loadHours: z.number(),
  /** Of which sealed (reached Ready to Test). */
  doneHours: z.number(),
  research: z.int().nonnegative(),
  unestimated: z.int().nonnegative(),
  counts: z.record(DockStageSchema, z.int().nonnegative()),
  /** Has work that is not sealed yet. */
  active: z.boolean(),
});
export type Sprint = z.infer<typeof SprintSchema>;

export const SprintProjectSchema = z.object({
  name: z.string(),
  repoId: z.string(),
  repoName: z.string(),
});
export type SprintProject = z.infer<typeof SprintProjectSchema>;

export const SprintsResponseSchema = z.object({
  generatedAt: z.number(),
  capacityHours: z.number(),
  projects: z.array(SprintProjectSchema),
  /** Newest first. */
  sprints: z.array(SprintSchema),
  /** My cards with a sprint whose Product Domain has no connected repo (left out). */
  skippedUnconnected: z.int().nonnegative(),
  /** My cards with a connected domain but no sprint. */
  withoutSprint: z.int().nonnegative(),
});
export type SprintsResponse = z.infer<typeof SprintsResponseSchema>;
