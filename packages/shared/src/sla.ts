import { z } from 'zod';
import { EpochMsSchema } from './common';

/**
 * Results of the SLA engine. Computed by `apps/server/src/services/slaEngine.ts`.
 *
 * `over_70` and `over_90` are strict: exactly 70% is still `on_track`. `untracked` is not an SLA state: it is a card
 * with no timer at all (no type, no rule for its type, or no assigned-at).
 */
export const SLA_STATES = [
  'untracked',
  'not_started',
  'on_track',
  'over_70',
  'over_90',
  'breached',
  'met',
] as const;
export const SlaStateSchema = z.enum(SLA_STATES);
export type SlaState = z.infer<typeof SlaStateSchema>;

export const SlaUntrackedReasonSchema = z.enum(['no_type', 'no_rule', 'no_assigned_at']);
export type SlaUntrackedReason = z.infer<typeof SlaUntrackedReasonSchema>;

export const SlaEvaluationSchema = z.object({
  state: SlaStateSchema,
  /** Set only when `state` is `untracked`. */
  untrackedReason: SlaUntrackedReasonSchema.nullable(),
  ruleDays: z.int().positive().nullable(),
  startClock: EpochMsSchema.nullable(),
  deadline: EpochMsSchema.nullable(),
  /** The linked MR's `created_at`, when it stopped the clock. */
  stoppedAt: EpochMsSchema.nullable(),
  /** 0..1, measured at `stoppedAt` or now. With working days, weekends do not count as elapsed. */
  elapsedFraction: z.number().min(0).max(1).nullable(),
  /** Deadline minus `stoppedAt` or now, in wall-clock ms. Negative = late. */
  remainingMs: z.number().nullable(),
  /** The card has an estimation start that could not be read, so it was ignored. */
  estimationInvalid: z.boolean(),
});
export type SlaEvaluation = z.infer<typeof SlaEvaluationSchema>;

/** Where an assigned-at came from. `manual` is the per-card override, and it always wins. */
export const AssignedAtOriginSchema = z.enum(['firstSeen', 'property', 'manual']);
export type AssignedAtOrigin = z.infer<typeof AssignedAtOriginSchema>;

export const AssignedAtResolutionSchema = z.object({
  /** null = nothing known, so the card has no timer. */
  at: EpochMsSchema.nullable(),
  source: AssignedAtOriginSchema.nullable(),
  approx: z.boolean(),
});
export type AssignedAtResolution = z.infer<typeof AssignedAtResolutionSchema>;

export const BugRatioSchema = z.object({
  bugs: z.int().nonnegative(),
  total: z.int().nonnegative(),
  /** 0 when `total` is 0. */
  ratio: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
  overLimit: z.boolean(),
  /**
   * More non-bug cards needed to get back to `max`: 0 when within it. null = no number of cards can (`max` is 0 and
   * there is a bug).
   */
  nonBugCardsToRecover: z.int().nonnegative().nullable(),
});
export type BugRatio = z.infer<typeof BugRatioSchema>;

export const ResearchQuotaStateSchema = z.enum(['met', 'pending', 'missed']);
export type ResearchQuotaState = z.infer<typeof ResearchQuotaStateSchema>;

export const ResearchQuotaSchema = z.object({
  count: z.int().nonnegative(),
  required: z.int().nonnegative(),
  remaining: z.int().nonnegative(),
  /** `missed` only once the month is over. */
  state: ResearchQuotaStateSchema,
  /** The month is in progress, its reminder day has come, and the quota is not met. Dedupe is the caller's job. */
  reminderDue: z.boolean(),
});
export type ResearchQuota = z.infer<typeof ResearchQuotaSchema>;
