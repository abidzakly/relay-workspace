import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';
import { JobModeSchema } from './jobs';

/** Gamification. All awards are decided by `apps/server/src/services/gamificationService.ts`. */

export const BADGE_IDS = [
  'zero_mismatches',
  'five_approvals_day',
  'bug_slayer',
  'researcher',
  'first_try',
] as const;
export const BadgeIdSchema = z.enum(BADGE_IDS);
export type BadgeId = z.infer<typeof BadgeIdSchema>;

export const GamificationStreakSchema = z.object({
  current: z.int().nonnegative(),
  best: z.int().nonnegative(),
});
export type GamificationStreak = z.infer<typeof GamificationStreakSchema>;

/** Every badge is listed, earned or not: `count` 0 = not earned yet. */
export const GamificationBadgeSchema = z.object({
  id: BadgeIdSchema,
  count: z.int().nonnegative(),
  lastEarnedAt: EpochMsSchema.nullable(),
});
export type GamificationBadge = z.infer<typeof GamificationBadgeSchema>;

export const GamificationReleaseSchema = z.object({
  jobId: z.string().min(1),
  repoId: RepoIdSchema,
  mode: JobModeSchema,
  version: z.string().nullable(),
  at: EpochMsSchema,
  /** Sync Health mismatches of this repo, plus those on cards with no MR, when the release finished. */
  mismatches: z.int().nonnegative(),
  /** Everything earned since the previous release, this release's own XP included. */
  xpEarned: z.int().nonnegative(),
  /** The zero-mismatch streak after this release. */
  streak: z.int().nonnegative(),
});
export type GamificationRelease = z.infer<typeof GamificationReleaseSchema>;

/** `GET /api/gamification`. */
export const GamificationReportSchema = z.object({
  xp: z.int().nonnegative(),
  level: z.object({
    level: z.int().positive(),
    /** XP earned inside this level. */
    xpIntoLevel: z.int().nonnegative(),
    /** XP this level takes in total. */
    xpForLevel: z.int().positive(),
  }),
  streaks: z.object({
    releases: GamificationStreakSchema,
    slaDays: GamificationStreakSchema,
    /** Days in a row with a finished Review Deck. */
    reviewDays: GamificationStreakSchema.optional(),
  }),
  badges: z.array(GamificationBadgeSchema),
  /** Newest first. */
  releases: z.array(GamificationReleaseSchema),
});
export type GamificationReport = z.infer<typeof GamificationReportSchema>;
